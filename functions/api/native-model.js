// ECMWF·GFS 네이티브 0.25° 격자 서빙.
//
// GitHub Actions(tools/model-native/fetch_native_models.py)가 GRIB2를 디코드해
// R2에 올려둔 프레임을 그대로 전달한다. Worker에서는 GRIB2(complex packing/
// CCSDS)를 풀 수 없으므로 여기서 변환하지 않고 읽기만 한다.
//
// 라우트
//   ?model=gfs&meta=1            → manifest(JSON): 격자·주기·프레임 준비 상태
//   ?model=gfs&cycle=..&frame=3  → 프레임(uint16 centimm LE, 결측 65535)
// cycle 생략 시 latest.json이 가리키는 최신 주기를 쓴다.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Model-Cycle,X-Model-Frame,X-Model-Source',
};

const SCHEMA_VERSION = 'v1';
const MODELS = new Set(['ecmwf', 'gfs']);
const FRAME_COUNT = 40;

const jsonResponse = (payload, status = 200, cacheControl = 'no-store') =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });

// 전용 버킷이 없으면 위성 버킷으로 폴백한다(키 접두사가 달라 섞이지 않는다).
const getStore = (env) => env?.MODEL_R2 || env?.SATELLITE_R2 || null;

const latestKey = (model) => `models/native/${SCHEMA_VERSION}/${model}/latest.json`;
const frameKey = (model, cycle, frame) =>
  `models/native/${SCHEMA_VERSION}/${model}/${cycle}/frame-${String(frame).padStart(2, '0')}.bin`;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const model = url.searchParams.get('model') ?? 'gfs';
  if (!MODELS.has(model)) {
    return jsonResponse({ error: 'model must be ecmwf or gfs' }, 400);
  }

  const store = getStore(context.env);
  if (!store) {
    return jsonResponse({ error: 'native model storage is not configured' }, 503);
  }

  const manifestObject = await store.get(latestKey(model));
  if (!manifestObject) {
    return jsonResponse({ error: 'native model cache is empty', model }, 404);
  }
  const manifest = await manifestObject.json();

  if (url.searchParams.has('meta')) {
    return jsonResponse(manifest, 200, 'public, max-age=120, s-maxage=300');
  }

  const frame = Number(url.searchParams.get('frame'));
  if (!Number.isInteger(frame) || frame < 0 || frame >= FRAME_COUNT) {
    return jsonResponse({ error: `frame must be 0..${FRAME_COUNT - 1}` }, 400);
  }
  const cycle = url.searchParams.get('cycle') || manifest.cycle;
  if (!/^\d{10}$/.test(cycle)) {
    return jsonResponse({ error: 'cycle must be YYYYMMDDHH' }, 400);
  }

  const object = await store.get(frameKey(model, cycle, frame));
  if (!object) {
    return jsonResponse({ error: 'frame is not ready yet', model, cycle, frame }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/octet-stream',
      // 예보 주기는 6~12시간마다 바뀌고 프레임 자체는 불변이라 길게 캐시한다.
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      'X-Model-Cycle': cycle,
      'X-Model-Frame': String(frame),
      'X-Model-Source': 'r2-native',
    },
  });
}
