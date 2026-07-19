// GK2A(천리안2A) IR105 동아시아(EA) 관측을 방송용 경량 격자로 변환하는 프록시.
//
// 원본: API허브 LE1B/IR105/EA/data — NetCDF4(HDF5), 3000x2600 uint16 DN 격자.
// 파일 구조가 고정이라(운영 산출 소프트웨어 동일) DN 격자는 항상 파일 오프셋
// 11827에 리틀엔디언으로 연속 저장된다(프레임 2개 교차 검증). 여기서 4x4 블록
// 최대 DN(=최저 휘도온도, 구름 우선)으로 다운샘플해 750x650 바이너리로 응답한다.
//
// 응답 형식: 'GKIR' 매직 4B + uint16LE width + uint16LE height + uint16LE[w*h]
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const SRC_WIDTH = 3000;
const SRC_HEIGHT = 2600;
const SRC_FILE_BYTES = 15612407;
const SRC_DATA_OFFSET = 11827;
const FACTOR = 4;
const OUT_WIDTH = SRC_WIDTH / FACTOR;
const OUT_HEIGHT = SRC_HEIGHT / FACTOR;
const HISTORICAL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const RECENT_AGE_MS = 30 * 60 * 1000;

const readAuthKey = (env) =>
  env?.KMA_BROADCAST_AUTH_KEY ||
  env?.KMA_AUTH_KEY ||
  env?.VITE_KMA_AUTH_KEY ||
  (typeof process !== 'undefined' &&
    (process.env.KMA_BROADCAST_AUTH_KEY || process.env.KMA_AUTH_KEY || process.env.VITE_KMA_AUTH_KEY)) ||
  '';

const parseUtcDate = (value) => {
  if (!/^\d{12}$/.test(value ?? '')) {
    return null;
  }
  return Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12)),
  );
};

// ---------------------------------------------------------------------------
// 전구(FD) 지원: NOAA Open Data(noaa-gk2a-pds, 무인증·무호출한도)의 FD 원본을 쓴다.
// FD NetCDF는 EA와 달리 HDF5 deflate 청크(1375x1375 x16)로 압축돼 있어 최소한의
// HDF5 파싱이 필요하다. 운영 산출물이라 파일 구조가 고정: 본 데이터셋 객체 헤더는
// 항상 오프셋 6524에 있고(검증 후 전체 스캔 폴백), 청크 주소만 프레임마다 다르다.
const FD_SRC = 5500;
const FD_CHUNK = 1375;
const FD_FACTOR = 11; // 1375의 약수 → 청크 단위 처리 가능, 출력 500x500
const FD_OUT = FD_SRC / FD_FACTOR;
const FD_DATASET_HEADER_HINT = 6524;

// 한반도 주변 정밀 크롭(area=ko): FD 원본 2km에서 lat 22~48N/lon 110~145E를
// 덮는 픽셀 사각형을 3x3 블록최대(6km)로 잘라낸다. KMA EA(8km) 대체 —
// 같은 NOAA 파일에서 나오므로 KMA 데이터 용량을 전혀 쓰지 않는다.
const KO_CROP = { col0: 1845, row0: 534, srcW: 1746, srcH: 1065, factor: 3 };
const KO_OUT_W = KO_CROP.srcW / KO_CROP.factor; // 582
const KO_OUT_H = KO_CROP.srcH / KO_CROP.factor; // 355

const inflateBytes = async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// HDF5 v2 객체 헤더(OHDR)에서 메시지 목록을 읽는다 (OCHK 연속 블록 포함).
const parseObjectHeaderV2 = (buf, dv, addr) => {
  const str4 = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (str4(addr) !== 'OHDR') return null;
  const flags = dv.getUint8(addr + 5);
  let p = addr + 6;
  if (flags & 0x20) p += 16;
  if (flags & 0x10) p += 4;
  const sizeBytes = 1 << (flags & 0x03);
  const chunkSize =
    sizeBytes === 1 ? dv.getUint8(p) : sizeBytes === 2 ? dv.getUint16(p, true) : dv.getUint32(p, true);
  p += sizeBytes;
  const hdrLen = flags & 0x04 ? 6 : 4;
  const messages = [];
  const walk = (s, e) => {
    let q = s;
    while (q + hdrLen <= e && messages.length < 500) {
      const type = dv.getUint8(q);
      const size = dv.getUint16(q + 1, true);
      const body = q + hdrLen;
      if (type === 0x10 && size >= 16) {
        const contAddr = Number(dv.getBigUint64(body, true));
        const contLen = Number(dv.getBigUint64(body + 8, true));
        if (str4(contAddr) === 'OCHK') walk(contAddr + 4, contAddr + contLen - 8);
      } else if (type !== 0) {
        messages.push({ type, body, size });
      }
      q = body + size;
    }
  };
  walk(p, p + chunkSize);
  return messages;
};

// FD 데이터셋(5500x5500, deflate 청크)의 레이아웃을 찾는다.
const findFdDataset = (buf, dv) => {
  const inspect = (addr) => {
    const messages = parseObjectHeaderV2(buf, dv, addr);
    if (!messages) return null;
    let dimsOk = false;
    let layout = null;
    let deflateOnly = null;
    for (const m of messages) {
      if (m.type === 0x01) {
        const ver = dv.getUint8(m.body);
        const rank = dv.getUint8(m.body + 1);
        const off = ver === 1 ? m.body + 8 : m.body + 4;
        dimsOk =
          rank === 2 &&
          Number(dv.getBigUint64(off, true)) === FD_SRC &&
          Number(dv.getBigUint64(off + 8, true)) === FD_SRC;
      }
      if (m.type === 0x08 && dv.getUint8(m.body) === 3 && dv.getUint8(m.body + 1) === 2) {
        const ndim = dv.getUint8(m.body + 2);
        layout = {
          btree: Number(dv.getBigUint64(m.body + 3, true)),
          chunkDims: [dv.getUint32(m.body + 11, true), dv.getUint32(m.body + 15, true)],
          elemSize: dv.getUint32(m.body + 11 + (ndim - 1) * 4, true),
        };
      }
      if (m.type === 0x0b) {
        const ver = dv.getUint8(m.body);
        const n = dv.getUint8(m.body + 1);
        let p = ver === 1 ? m.body + 8 : m.body + 2;
        deflateOnly = n === 1 && dv.getUint16(p, true) === 1;
      }
    }
    if (dimsOk && layout && deflateOnly && layout.chunkDims[0] === FD_CHUNK && layout.chunkDims[1] === FD_CHUNK) {
      return layout;
    }
    return null;
  };

  const fast = inspect(FD_DATASET_HEADER_HINT);
  if (fast) return fast;
  // 구조가 바뀐 경우: OHDR 시그니처 전체 스캔 폴백
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x48 && buf[i + 2] === 0x44 && buf[i + 3] === 0x52) {
      const hit = inspect(i);
      if (hit) return hit;
    }
  }
  return null;
};

const walkFdChunkBtree = (buf, dv, addr, out) => {
  if (String.fromCharCode(buf[addr], buf[addr + 1], buf[addr + 2], buf[addr + 3]) !== 'TREE') {
    throw new Error('chunk btree not found');
  }
  const level = dv.getUint8(addr + 5);
  const entries = dv.getUint16(addr + 6, true);
  const keySize = 8 + 3 * 8; // size(4)+mask(4) + 오프셋 3차원(행, 열, 요소)
  let p = addr + 24;
  for (let i = 0; i < entries; i++) {
    const size = dv.getUint32(p, true);
    const row = Number(dv.getBigUint64(p + 8, true));
    const col = Number(dv.getBigUint64(p + 16, true));
    const child = Number(dv.getBigUint64(p + keySize, true));
    if (level === 0) out.push({ size, row, col, addr: child });
    else walkFdChunkBtree(buf, dv, child, out);
    p += keySize + 8;
  }
};

const handleFdRequest = async (context, date, area, isHistorical, edgeCache, cacheKey) => {
  const base =
    context.env?.GK2A_FD_UPSTREAM_BASE || 'https://noaa-gk2a-pds.s3.amazonaws.com/AMI/L1B/FD/';
  const upstream = `${base}${date.slice(0, 6)}/${date.slice(6, 8)}/${date.slice(8, 10)}/gk2a_ami_le1b_ir105_fd020ge_${date}.nc`;

  let originResponse;
  try {
    // fd/ko가 같은 원본을 쓰므로 원본 자체를 잠시 엣지 캐시해 다운로드를 공유
    originResponse = await fetch(upstream, { cf: { cacheEverything: true, cacheTtl: 600 } });
  } catch (error) {
    return new Response(JSON.stringify({ error: `FD upstream fetch failed: ${error.message}` }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  if (!originResponse.ok) {
    return new Response(JSON.stringify({ error: 'FD frame not available', status: originResponse.status }), {
      status: originResponse.status === 403 || originResponse.status === 404 ? 404 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const body = await originResponse.arrayBuffer();
  const buf = new Uint8Array(body);
  const dv = new DataView(body);
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x48 || buf[2] !== 0x44 || buf[3] !== 0x46) {
    return new Response(JSON.stringify({ error: 'FD file is not HDF5', size: buf.length }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const layout = findFdDataset(buf, dv);
  if (!layout) {
    return new Response(JSON.stringify({ error: 'FD dataset layout not found' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  const chunks = [];
  walkFdChunkBtree(buf, dv, layout.btree, chunks);

  let out;
  let outW;
  let outH;
  let magic;
  if (area === 'ko') {
    // 크롭과 교차하는 청크(4개)만 inflate → 크롭 원본 조립 → 3x3 블록 최대
    magic = [0x47, 0x4b, 0x4b, 0x4f]; // 'GKKO'
    outW = KO_OUT_W;
    outH = KO_OUT_H;
    const { col0, row0, srcW, srcH, factor } = KO_CROP;
    const cropRaw = new Uint16Array(srcW * srcH);
    for (const chunk of chunks) {
      if (chunk.row + FD_CHUNK <= row0 || chunk.row >= row0 + srcH) continue;
      if (chunk.col + FD_CHUNK <= col0 || chunk.col >= col0 + srcW) continue;
      const raw = await inflateBytes(buf.subarray(chunk.addr, chunk.addr + chunk.size));
      if (raw.length !== FD_CHUNK * FD_CHUNK * 2) {
        return new Response(JSON.stringify({ error: 'FD chunk size mismatch', got: raw.length }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const cdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const rowStart = Math.max(chunk.row, row0);
      const rowEnd = Math.min(chunk.row + FD_CHUNK, row0 + srcH);
      const colStart = Math.max(chunk.col, col0);
      const colEnd = Math.min(chunk.col + FD_CHUNK, col0 + srcW);
      for (let r = rowStart; r < rowEnd; r++) {
        const srcOff = ((r - chunk.row) * FD_CHUNK + (colStart - chunk.col)) * 2;
        const dstOff = (r - row0) * srcW + (colStart - col0);
        for (let i = 0; i < colEnd - colStart; i++) {
          cropRaw[dstOff + i] = cdv.getUint16(srcOff + i * 2, true);
        }
      }
    }
    out = new Uint16Array(outW * outH);
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        let max = 0;
        for (let dy = 0; dy < factor; dy++) {
          let idx = (oy * factor + dy) * srcW + ox * factor;
          for (let dx = 0; dx < factor; dx++) {
            const v = cropRaw[idx + dx];
            if (v <= 8191 && v > max) max = v;
          }
        }
        out[oy * outW + ox] = max;
      }
    }
  } else {
    // 청크별 inflate 후 11x11 블록 최대 DN 다운샘플 (DN 클수록 차가운 운정)
    magic = [0x47, 0x4b, 0x46, 0x44]; // 'GKFD'
    outW = FD_OUT;
    outH = FD_OUT;
    out = new Uint16Array(FD_OUT * FD_OUT);
    const per = FD_CHUNK / FD_FACTOR; // 125
    for (const chunk of chunks) {
      const raw = await inflateBytes(buf.subarray(chunk.addr, chunk.addr + chunk.size));
      if (raw.length !== FD_CHUNK * FD_CHUNK * 2) {
        return new Response(JSON.stringify({ error: 'FD chunk size mismatch', got: raw.length }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      const cdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const outY0 = chunk.row / FD_FACTOR;
      const outX0 = chunk.col / FD_FACTOR;
      for (let oy = 0; oy < per; oy++) {
        for (let ox = 0; ox < per; ox++) {
          let max = 0;
          for (let dy = 0; dy < FD_FACTOR; dy++) {
            let idx = ((oy * FD_FACTOR + dy) * FD_CHUNK + ox * FD_FACTOR) * 2;
            for (let dx = 0; dx < FD_FACTOR; dx++) {
              const v = cdv.getUint16(idx, true);
              if (v <= 8191 && v > max) max = v;
              idx += 2;
            }
          }
          out[(outY0 + oy) * FD_OUT + outX0 + ox] = max;
        }
      }
    }
  }

  const outBytes = new Uint8Array(8 + out.length * 2);
  const head = new DataView(outBytes.buffer);
  outBytes[0] = magic[0]; outBytes[1] = magic[1]; outBytes[2] = magic[2]; outBytes[3] = magic[3];
  head.setUint16(4, outW, true);
  head.setUint16(6, outH, true);
  new Uint8Array(outBytes.buffer, 8).set(new Uint8Array(out.buffer));

  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set(
    'Cache-Control',
    isHistorical
      ? `public, max-age=3600, s-maxage=${HISTORICAL_CACHE_TTL_SECONDS}`
      : 'public, max-age=120, s-maxage=120',
  );
  const response = new Response(outBytes, { status: 200, headers });
  if (edgeCache) {
    const putPromise = edgeCache.put(cacheKey, response.clone()).catch(() => {});
    if (context.waitUntil) {
      context.waitUntil(putPromise);
    }
  }
  return response;
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date') ?? '';
  const areaParam = url.searchParams.get('area');
  const area = areaParam === 'fd' || areaParam === 'ko' ? areaParam : 'ea';
  const timestamp = parseUtcDate(date);

  if (timestamp === null || timestamp % (10 * 60 * 1000) !== 0) {
    return new Response(JSON.stringify({ error: 'date must be YYYYMMDDHHMM UTC on a 10-minute slot' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const isHistorical = Date.now() - timestamp >= RECENT_AGE_MS;
  const cacheKey = new Request(`https://gk2a-ir.internal/frame?date=${date}&area=${area}&v=2`, { method: 'GET' });
  const edgeCache = globalThis.caches?.default;

  if (edgeCache) {
    const hit = await edgeCache.match(cacheKey);
    if (hit) {
      return hit;
    }
  }

  if (area === 'fd' || area === 'ko') {
    return handleFdRequest(context, date, area, isHistorical, edgeCache, cacheKey);
  }

  const authKey = readAuthKey(context.env);
  // 로컬 개발에서 apihub 직결이 느릴 때 배포 프록시로 우회 (예: https://weather-ljh.pages.dev/api/kma-broadcast/)
  const upstreamBase = context.env?.GK2A_UPSTREAM_BASE || 'https://apihub.kma.go.kr/';
  const upstream = `${upstreamBase}api/typ05/api/GK2A/LE1B/IR105/EA/data?date=${date}&authKey=${authKey}`;

  let originResponse;
  try {
    originResponse = await fetch(upstream, { redirect: 'follow' });
  } catch (error) {
    return new Response(JSON.stringify({ error: `upstream fetch failed: ${error.message}` }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  if (originResponse.status === 403) {
    return new Response(JSON.stringify({ error: '하루 최대 호출량을 넘어 데이터를 불러올 수 없습니다.' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const body = await originResponse.arrayBuffer();
  const bytes = new Uint8Array(body);
  const isHdf =
    originResponse.ok &&
    bytes.length === SRC_FILE_BYTES &&
    bytes[0] === 0x89 && bytes[1] === 0x48 && bytes[2] === 0x44 && bytes[3] === 0x46;

  if (!isHdf) {
    // 미발표 시각(404/빈 응답)이거나 포맷이 바뀐 경우 — 캐시 없이 실패를 알림
    return new Response(JSON.stringify({ error: 'frame not available', status: originResponse.status, size: bytes.length }), {
      status: bytes.length === 0 || originResponse.status === 404 ? 404 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // 4x4 블록 최대 DN 다운샘플 (DN이 클수록 차가운 운정 → 구름 보존)
  const src = new DataView(body, SRC_DATA_OFFSET, SRC_WIDTH * SRC_HEIGHT * 2);
  const outBytes = new Uint8Array(8 + OUT_WIDTH * OUT_HEIGHT * 2);
  const header = new DataView(outBytes.buffer);
  outBytes[0] = 0x47; outBytes[1] = 0x4b; outBytes[2] = 0x49; outBytes[3] = 0x52; // 'GKIR'
  header.setUint16(4, OUT_WIDTH, true);
  header.setUint16(6, OUT_HEIGHT, true);
  const out = new DataView(outBytes.buffer, 8);

  for (let oy = 0; oy < OUT_HEIGHT; oy++) {
    const syBase = oy * FACTOR;
    for (let ox = 0; ox < OUT_WIDTH; ox++) {
      const sxBase = ox * FACTOR;
      let max = 0;
      for (let dy = 0; dy < FACTOR; dy++) {
        let idx = ((syBase + dy) * SRC_WIDTH + sxBase) * 2;
        for (let dx = 0; dx < FACTOR; dx++) {
          const v = src.getUint16(idx, true);
          // 32768은 무효(우주 영역 등) — 무시
          if (v <= 8191 && v > max) {
            max = v;
          }
          idx += 2;
        }
      }
      out.setUint16((oy * OUT_WIDTH + ox) * 2, max, true);
    }
  }

  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set(
    'Cache-Control',
    isHistorical
      ? `public, max-age=3600, s-maxage=${HISTORICAL_CACHE_TTL_SECONDS}`
      : 'public, max-age=120, s-maxage=120',
  );

  const response = new Response(outBytes, { status: 200, headers });

  if (edgeCache) {
    const putPromise = edgeCache.put(cacheKey, response.clone()).catch(() => {});
    if (context.waitUntil) {
      context.waitUntil(putPromise);
    }
  }

  return response;
}
