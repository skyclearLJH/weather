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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const date = url.searchParams.get('date') ?? '';
  const timestamp = parseUtcDate(date);

  if (timestamp === null || timestamp % (10 * 60 * 1000) !== 0) {
    return new Response(JSON.stringify({ error: 'date must be YYYYMMDDHHMM UTC on a 10-minute slot' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const isHistorical = Date.now() - timestamp >= RECENT_AGE_MS;
  const cacheKey = new Request(`https://gk2a-ir.internal/frame?date=${date}&v=2`, { method: 'GET' });
  const edgeCache = globalThis.caches?.default;

  if (edgeCache) {
    const hit = await edgeCache.match(cacheKey);
    if (hit) {
      return hit;
    }
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
