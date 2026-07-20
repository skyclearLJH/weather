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

// 동아시아 정밀 크롭(area=ko): FD 원본 2km에서 대략 lon 95~168E / lat 5~55N
// (기상청 EA 섹터 상당)을 덮는 GEOS 픽셀 사각형을 2x2 블록최대(4km)로 잘라낸다.
// 같은 NOAA 파일에서 나오므로 KMA 데이터 용량을 전혀 쓰지 않는다.
// 클라이언트는 이 격자를 3D 높이 메쉬가 아니라 텍스처로 입혀 렌더하므로(정점 수와
// 분리) 1809x1066 해상도도 가볍게 그린다. satApi.js의 KO_GRID와 반드시 일치해야 함.
const KO_CROP = { col0: 1071, row0: 354, srcW: 3618, srcH: 2132, factor: 2 };
const KO_OUT_W = KO_CROP.srcW / KO_CROP.factor; // 1809
const KO_OUT_H = KO_CROP.srcH / KO_CROP.factor; // 1066

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

// 처리 결과(ko/fd 출력 바이트) 메모리 캐시 — 로컬 개발(엣지 캐시 없음)과
// 워커 웜 아이솔레이트에서 재계산을 막는다. 프레임당 약 0.9MB × 20프레임.
const FD_OUTPUT_CACHE = new Map(); // `${date}:${area}` → Uint8Array
const FD_OUTPUT_CACHE_LIMIT = 40;
const FD_PROCESS_IN_FLIGHT = new Map(); // date → Promise<{ko, fd}>

const rememberOutput = (key, bytes) => {
  FD_OUTPUT_CACHE.set(key, bytes);
  while (FD_OUTPUT_CACHE.size > FD_OUTPUT_CACHE_LIMIT) {
    FD_OUTPUT_CACHE.delete(FD_OUTPUT_CACHE.keys().next().value);
  }
};

const frameError = (message, httpStatus) => {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  return error;
};

const packOutput = (magic, w, h, data) => {
  const outBytes = new Uint8Array(8 + data.length * 2);
  const head = new DataView(outBytes.buffer);
  outBytes[0] = magic.charCodeAt(0);
  outBytes[1] = magic.charCodeAt(1);
  outBytes[2] = magic.charCodeAt(2);
  outBytes[3] = magic.charCodeAt(3);
  head.setUint16(4, w, true);
  head.setUint16(6, h, true);
  new Uint8Array(outBytes.buffer, 8).set(new Uint8Array(data.buffer));
  return outBytes;
};

// 원본 파일을 한 번만 받아 청크를 한 번씩만 inflate하면서 FD(전구 22km)와
// KO(한반도 6km) 출력을 동시에 만든다 — 두 영역의 성공/실패가 항상 함께 간다.
const buildFrameOutputs = async (context, date) => {
  const base =
    context.env?.GK2A_FD_UPSTREAM_BASE || 'https://noaa-gk2a-pds.s3.amazonaws.com/AMI/L1B/FD/';
  const upstream = `${base}${date.slice(0, 6)}/${date.slice(6, 8)}/${date.slice(8, 10)}/gk2a_ami_le1b_ir105_fd020ge_${date}.nc`;

  let originResponse;
  try {
    originResponse = await fetch(upstream, { cf: { cacheEverything: true, cacheTtl: 600 } });
  } catch (error) {
    throw frameError(`FD upstream fetch failed: ${error.message}`, 502);
  }
  if (!originResponse.ok) {
    throw frameError(
      'FD frame not available',
      originResponse.status === 403 || originResponse.status === 404 ? 404 : 502,
    );
  }

  const body = await originResponse.arrayBuffer();
  const buf = new Uint8Array(body);
  const dv = new DataView(body);
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x48 || buf[2] !== 0x44 || buf[3] !== 0x46) {
    throw frameError('FD file is not HDF5', 502);
  }

  const layout = findFdDataset(buf, dv);
  if (!layout) {
    throw frameError('FD dataset layout not found', 502);
  }
  const chunks = [];
  walkFdChunkBtree(buf, dv, layout.btree, chunks);

  const fdData = new Uint16Array(FD_OUT * FD_OUT);
  const per = FD_CHUNK / FD_FACTOR; // 125
  const { col0, row0, srcW, srcH, factor } = KO_CROP;
  const cropRaw = new Uint16Array(srcW * srcH);

  for (const chunk of chunks) {
    const raw = await inflateBytes(buf.subarray(chunk.addr, chunk.addr + chunk.size));
    if (raw.length !== FD_CHUNK * FD_CHUNK * 2) {
      throw frameError(`FD chunk size mismatch: ${raw.length}`, 502);
    }
    const cdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    // 전구: 11x11 블록 최대 DN 다운샘플 (DN 클수록 차가운 운정)
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
        fdData[(outY0 + oy) * FD_OUT + outX0 + ox] = max;
      }
    }

    // 한반도 크롭: 교차 청크(4개)의 해당 영역을 원본 해상도로 조립
    if (
      chunk.row + FD_CHUNK > row0 && chunk.row < row0 + srcH &&
      chunk.col + FD_CHUNK > col0 && chunk.col < col0 + srcW
    ) {
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
  }

  // 크롭 3x3 블록 최대 → 6km
  const koData = new Uint16Array(KO_OUT_W * KO_OUT_H);
  for (let oy = 0; oy < KO_OUT_H; oy++) {
    for (let ox = 0; ox < KO_OUT_W; ox++) {
      let max = 0;
      for (let dy = 0; dy < factor; dy++) {
        let idx = (oy * factor + dy) * srcW + ox * factor;
        for (let dx = 0; dx < factor; dx++) {
          const v = cropRaw[idx + dx];
          if (v <= 8191 && v > max) max = v;
        }
      }
      koData[oy * KO_OUT_W + ox] = max;
    }
  }

  return {
    fd: packOutput('GKFD', FD_OUT, FD_OUT, fdData),
    ko: packOutput('GKKO', KO_OUT_W, KO_OUT_H, koData),
  };
};

// 같은 아이솔레이트 안에서는 프레임 처리를 직렬화한다 — 35MB 원본을 동시에
// 여러 개 들고 있으면 워커 메모리 한도(128MB)를 넘겨 요청이 통째로 죽는다.
let processChain = Promise.resolve();

const processFrame = (context, date) => {
  if (FD_PROCESS_IN_FLIGHT.has(date)) {
    return FD_PROCESS_IN_FLIGHT.get(date);
  }
  const promise = processChain
    .catch(() => {})
    .then(() => buildFrameOutputs(context, date))
    .finally(() => {
      FD_PROCESS_IN_FLIGHT.delete(date);
    });
  FD_PROCESS_IN_FLIGHT.set(date, promise);
  processChain = promise.catch(() => {});
  return promise;
};

// 최신 관측 시각 조회: S3 목록(수 KB)만 읽으므로 프레임 탐색(35MB 다운로드
// 반복)과 달리 수백 ms면 끝난다. 현재 시간대에 파일이 없으면 이전 시간대 확인.
const handleLatestRequest = async () => {
  const pad = (v) => String(v).padStart(2, '0');
  let latest = null;
  for (const offsetHours of [0, 1, 2]) {
    const t = new Date(Date.now() - offsetHours * 60 * 60 * 1000);
    const prefix = `AMI/L1B/FD/${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${pad(t.getUTCHours())}/gk2a_ami_le1b_ir105_fd020ge_`;
    let xml;
    try {
      const response = await fetch(
        `https://noaa-gk2a-pds.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`,
      );
      if (!response.ok) continue;
      xml = await response.text();
    } catch {
      continue;
    }
    for (const match of xml.matchAll(/fd020ge_(\d{12})\.nc/g)) {
      if (!latest || match[1] > latest) latest = match[1];
    }
    if (latest) break;
  }
  return new Response(JSON.stringify({ latest }), {
    status: latest ? 200 : 404,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30, s-maxage=30',
    },
  });
};

// --- 접속 시 최근 프레임 엣지 캐시 프리워밍 ---
// 위성 뷰를 열면 클라이언트가 먼저 `?latest=1`을 한 번 호출한다. 그 응답을 돌려준
// 뒤(waitUntil, 백그라운드)에 '관측 30분을 갓 넘긴' 프레임들을 이 함수 자신에게
// self-fetch로 요청해 엣지 캐시에 채워 둔다. 30분이 지난 프레임은 7일 엣지 캐시를
// 받으므로 한 번 데우면 그 프레임의 12시간 수명 내내 유지된다. 이미 데워진 프레임은
// 값싼 엣지 HIT라 재계산이 없다. 별도 크론/워커 없이 Pages 자동 배포로 반영된다.
// 매 요청마다 돌지 않도록 아이솔레이트별로 최소 간격(WARM_THROTTLE_MS)을 둔다.
const WARM_AGES_MINUTES = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];
const WARM_THROTTLE_MS = 4 * 60 * 1000;
let lastWarmAt = 0;

const warmRecentFrames = async (origin) => {
  const floored = Math.floor(Date.now() / (10 * 60 * 1000)) * (10 * 60 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  for (const ageMin of WARM_AGES_MINUTES) {
    const d = new Date(floored - ageMin * 60 * 1000);
    const date =
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    // ko 미스면 처리하면서 fd 엣지 캐시도 함께 채워지지만(handleFdRequest), 확실히
    // 하도록 두 영역 모두 요청한다. 한 프레임씩 순차로 — 서버 처리를 몰아치지 않게.
    for (const area of ['ko', 'fd']) {
      try {
        const response = await fetch(`${origin}/api/gk2a-ir?date=${date}&area=${area}`);
        await response.arrayBuffer();
      } catch {
        // 개별 프레임 실패는 무시 — 다음 접속/다음 프레임에서 다시 시도된다
      }
    }
  }
};

const maybeWarmRecentFrames = (context) => {
  const now = Date.now();
  if (now - lastWarmAt < WARM_THROTTLE_MS) {
    return;
  }
  lastWarmAt = now;
  const origin = new URL(context.request.url).origin;
  if (context.waitUntil) {
    context.waitUntil(warmRecentFrames(origin));
  }
};

const buildFrameResponse = (outBytes, isHistorical) => {
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set(
    'Cache-Control',
    isHistorical
      ? `public, max-age=3600, s-maxage=${HISTORICAL_CACHE_TTL_SECONDS}`
      : 'public, max-age=120, s-maxage=120',
  );
  return new Response(outBytes, { status: 200, headers });
};

const makeAreaCacheKey = (date, area) =>
  new Request(`https://gk2a-ir.internal/frame?date=${date}&area=${area}&v=2`, { method: 'GET' });

const handleFdRequest = async (context, date, area, isHistorical, edgeCache, cacheKey) => {
  let outBytes = FD_OUTPUT_CACHE.get(`${date}:${area}`);

  if (!outBytes) {
    let outputs;
    try {
      outputs = await processFrame(context, date);
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.httpStatus ?? 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    rememberOutput(`${date}:ko`, outputs.ko);
    rememberOutput(`${date}:fd`, outputs.fd);
    outBytes = outputs[area];

    // 반대 영역도 엣지 캐시에 미리 저장 — 곧바로 이어질 요청이 재계산하지 않게
    if (edgeCache) {
      const other = area === 'ko' ? 'fd' : 'ko';
      const putOther = edgeCache
        .put(makeAreaCacheKey(date, other), buildFrameResponse(outputs[other], isHistorical))
        .catch(() => {});
      if (context.waitUntil) {
        context.waitUntil(putOther);
      }
    }
  }

  const response = buildFrameResponse(outBytes, isHistorical);
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
  if (url.searchParams.has('latest')) {
    // 위성 뷰 진입 신호 — 응답과 별개로 최근 프레임을 백그라운드 프리워밍
    maybeWarmRecentFrames(context);
    return handleLatestRequest();
  }
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
