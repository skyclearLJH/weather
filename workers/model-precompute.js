const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const KIM_GRID_URL = 'https://apihub.kma.go.kr/api/typ06/cgi-bin/url/nph-kim_nc_xy_txt2_std';
const OPEN_METEO_BASE_URL = 'https://api.open-meteo.com/v1';
const CACHE_PREFIX = 'models/east-asia/v1/';
const KIM_SOURCE_PREFIX = `${CACHE_PREFIX}kim/source/`;
const HOUR_MS = 60 * 60 * 1000;
const FRAME_STEP_HOURS = 6;
const FRAME_COUNT = 40;
const MISSING_VALUE = 65535;
const MAX_GRID_POINTS = 25000;
const OPEN_METEO_DEFAULT_CHUNK_SIZE = 80;
const OPEN_METEO_HEAVY_CHUNK_SIZE = 40;
const RUNTIME_CACHE_LIMIT = 10;
const KIM_NATIVE_STEP = 1 / 12;
const KIM_LAT_ORIGIN = -89.95882415771484;
const KIM_GLOBAL_MISSING = 0xffffffff;
const KIM_GLOBAL_GRID = {
  lonMin: 75,
  lonMax: 170,
  latMin: 5,
  latMax: 65,
  lonStep: 0.5,
  latStep: 0.5,
  width: 191,
  height: 121,
};
const EAST_ASIA_PRECOMPUTE = { bbox: [75, 5, 170, 65], step: 0.5 };
const runtimePayloadCache = new Map();
const inflightBuilds = new Map();

const MODEL_CONFIG = {
  'kim-global': {
    label: 'KIM 전구',
    providerModel: 'kma_gdps',
    provider: 'KMA API Hub official KIM global grid',
    nativeResolution: '약 8 km',
  },
  ifs: {
    label: 'ECMWF IFS',
    providerModel: 'ecmwf_ifs',
    provider: 'ECMWF IFS HRES / Open-Meteo spatial normalization',
    nativeResolution: '약 9 km',
  },
  aifs: {
    label: 'ECMWF AIFS',
    providerModel: 'ecmwf_aifs025_single',
    provider: 'ECMWF Open Data / Open-Meteo spatial normalization',
    nativeResolution: '0.25°',
  },
  gfs: {
    label: 'NOAA GFS',
    providerModel: 'ncep_gfs_global',
    provider: 'NOAA GFS / Open-Meteo spatial normalization',
    nativeResolution: '0.25° (약 22~28 km)',
  },
};
const MODEL_IDS_WITHOUT_KIM = ['ifs', 'aifs', 'gfs'];

class KimNoDataError extends Error {
  constructor(message = 'KIM 전구모델 자료가 아직 생산되지 않았습니다.') {
    super(message);
    this.name = 'KimNoDataError';
  }
}

const jsonResponse = (payload, status = 200, cacheControl = 'no-store', extraHeaders = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...extraHeaders,
    },
  });

const readAuthKey = (env) =>
  env?.KMA_BROADCAST_AUTH_KEY || env?.KMA_AUTH_KEY || env?.VITE_KMA_AUTH_KEY || '';
const getStore = (env) => env?.MODEL_R2 || env?.SATELLITE_R2 || env?.MODEL_CACHE || env?.KIM_RAIN_CACHE || null;
const isKvStore = (store) => typeof store?.getWithMetadata === 'function';
const getEdgeCache = () => typeof caches !== 'undefined' && caches.default ? caches.default : null;
const pad2 = (value) => String(value).padStart(2, '0');
const formatUtcCycle = (date) =>
  `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}`;
const parseUtcCycle = (value) => Date.UTC(
  Number(value.slice(0, 4)),
  Number(value.slice(4, 6)) - 1,
  Number(value.slice(6, 8)),
  Number(value.slice(8, 10)),
);
const frameLeadHours = () =>
  Array.from({ length: FRAME_COUNT }, (_, index) => (index + 1) * FRAME_STEP_HOURS);

const buildCycleCandidates = (nowMs = Date.now()) => {
  const now = new Date(nowMs);
  const availableHour = now.getUTCHours() >= 20 ? 12 : now.getUTCHours() >= 8 ? 0 : -12;
  const firstMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), availableHour);
  return Array.from({ length: 4 }, (_, index) =>
    formatUtcCycle(new Date(firstMs - index * 12 * HOUR_MS)));
};

const parseKimBinary = (buffer, expectedWidth, expectedHeight) => {
  if (buffer.byteLength < 8) throw new KimNoDataError();
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (width !== expectedWidth || height !== expectedHeight || buffer.byteLength < 8 + width * height * 4) {
    throw new KimNoDataError('KIM 전구모델 격자 형식이 올바르지 않습니다.');
  }
  return { width, height, values: new Float32Array(buffer, 8, width * height) };
};

const kimSubsetForBbox = (bbox) => {
  const [lonMin, latMin, lonMax, latMax] = bbox;
  if (lonMin < 0 || lonMax > 359.9 || lonMax <= lonMin) return null;
  const xMin = Math.max(1, Math.floor(lonMin / KIM_NATIVE_STEP));
  const xMax = Math.min(4319, Math.ceil(lonMax / KIM_NATIVE_STEP));
  const yMin = Math.max(0, Math.floor((latMin - KIM_LAT_ORIGIN) / KIM_NATIVE_STEP));
  const yMax = Math.min(2159, Math.ceil((latMax - KIM_LAT_ORIGIN) / KIM_NATIVE_STEP));
  return {
    xMin, xMax, yMin, yMax,
    width: xMax - xMin + 1,
    height: yMax - yMin + 1,
    lonMin: xMin * KIM_NATIVE_STEP,
    latMin: KIM_LAT_ORIGIN + yMin * KIM_NATIVE_STEP,
  };
};

const fetchKimField = async (env, cycle, leadHour, name, subset, timeoutMs = 30000) => {
  const authKey = readAuthKey(env);
  if (!authKey) throw new Error('KIM 전구모델 기상청 인증키가 설정되지 않았습니다.');
  const query = new URLSearchParams({
    group: 'KIMG', nwp: 'NE57', data: 'U', name, map: 'S',
    sub: `${subset.xMin},${subset.yMin},${subset.xMax},${subset.yMax}`,
    tmfc: cycle, hf: String(leadHour), disp: 'B', help: '0', authKey,
  });
  const response = await fetch(`${KIM_GRID_URL}?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 403) throw new Error('KIM 전구모델 API 사용 권한이 없습니다.');
  if (!response.ok) throw new KimNoDataError(`KIM 전구모델 요청 실패 (${response.status})`);
  return parseKimBinary(await response.arrayBuffer(), subset.width, subset.height);
};

const findKimCycle = async (env) => {
  const subset = { xMin: 1523, xMax: 1523, yMin: 1529, yMax: 1529, width: 1, height: 1 };
  let lastError = null;
  for (const cycle of buildCycleCandidates()) {
    try {
      await fetchKimField(env, cycle, FRAME_STEP_HOURS, 'prec_acc', subset);
      return cycle;
    } catch (error) {
      if (!(error instanceof KimNoDataError)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new KimNoDataError();
};

const normalizeBbox = (rawBbox) => {
  if (!Array.isArray(rawBbox) || rawBbox.length !== 4) throw new Error('bbox 형식이 올바르지 않습니다.');
  const values = rawBbox.map(Number);
  if (values.some((value) => !Number.isFinite(value))) throw new Error('bbox 값이 올바르지 않습니다.');
  let [lonMin, latMin, lonMax, latMax] = values;
  lonMin = Math.max(-180, Math.min(180, lonMin));
  lonMax = Math.max(-180, Math.min(180, lonMax));
  latMin = Math.max(-80, Math.min(80, latMin));
  latMax = Math.max(-80, Math.min(80, latMax));
  if (lonMax <= lonMin || latMax <= latMin) throw new Error('bbox 범위가 올바르지 않습니다.');
  return [lonMin, latMin, lonMax, latMax];
};

const buildGrid = (bbox, requestedStep) => {
  const [lonMin, latMin, lonMax, latMax] = bbox;
  let step = Math.max(0.08, Math.min(10, Number(requestedStep) || 1));
  const pointCountFor = (candidate) =>
    (Math.floor((lonMax - lonMin) / candidate) + 1) * (Math.floor((latMax - latMin) / candidate) + 1);
  if (pointCountFor(step) > MAX_GRID_POINTS) step *= Math.sqrt(pointCountFor(step) / MAX_GRID_POINTS);
  step = Math.ceil(step * 1000) / 1000;
  while (pointCountFor(step) > MAX_GRID_POINTS) step = Math.ceil((step + 0.01) * 1000) / 1000;
  const width = Math.floor((lonMax - lonMin) / step) + 1;
  const height = Math.floor((latMax - latMin) / step) + 1;
  const gridLonMax = lonMin + (width - 1) * step;
  const gridLatMin = latMax - (height - 1) * step;
  const points = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      points.push({ lat: latMax - row * step, lon: lonMin + column * step });
    }
  }
  return {
    lonMin, lonMax: gridLonMax, latMin: gridLatMin, latMax, step, width, height,
    order: 'north-to-south-row-major', points,
  };
};

const fetchInBatches = async (items, batchSize, fetcher) => {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.all(items.slice(offset, offset + batchSize).map(fetcher)));
  }
  return results;
};

const splitIntoChunks = (items, chunkSize) => {
  const chunks = [];
  for (let offset = 0; offset < items.length; offset += chunkSize) chunks.push(items.slice(offset, offset + chunkSize));
  return chunks;
};

const parseUtcTime = (value) => typeof value === 'string' ? Date.parse(value.endsWith('Z') ? value : `${value}Z`) : Number.NaN;
const findHourlyField = (hourly, baseName, providerModel) => {
  if (Array.isArray(hourly?.[`${baseName}_${providerModel}`])) return hourly[`${baseName}_${providerModel}`];
  if (Array.isArray(hourly?.[baseName])) return hourly[baseName];
  const key = Object.keys(hourly ?? {}).find((candidate) => candidate === baseName || candidate.startsWith(`${baseName}_`));
  return key ? hourly[key] : null;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const openMeteoEndpointFor = (providerModels) => {
  const models = [].concat(providerModels);
  if (models.every((model) => model.startsWith('ecmwf_'))) return `${OPEN_METEO_BASE_URL}/ecmwf`;
  if (models.every((model) => model.startsWith('ncep_'))) return `${OPEN_METEO_BASE_URL}/gfs`;
  return `${OPEN_METEO_BASE_URL}/forecast`;
};

const sha256Hex = async (value) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const openMeteoChunkCacheKey = async (cycle, providerModels, points) => {
  const models = [].concat(providerModels).join(',');
  const coordinates = points.map((point) => `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`).join(';');
  return `${CACHE_PREFIX}open-meteo/${cycle}/${models}/${await sha256Hex(coordinates)}.json`;
};

const openMeteoChunkSizeFor = (providerModels) => [].concat(providerModels).some((model) =>
  model.includes('aifs') || model.startsWith('ncep_'))
  ? OPEN_METEO_HEAVY_CHUNK_SIZE
  : OPEN_METEO_DEFAULT_CHUNK_SIZE;

const fetchOpenMeteoChunk = async (env, points, providerModels, cycle) => {
  const store = getStore(env);
  const cacheKey = await openMeteoChunkCacheKey(cycle, providerModels, points);
  const cached = await readStoredJson(store, cacheKey);
  if (Array.isArray(cached?.rows) && cached.rows.length === points.length) {
    return { rows: cached.rows, fromCache: true };
  }
  const query = new URLSearchParams({
    latitude: points.map((point) => point.lat.toFixed(3)).join(','),
    longitude: points.map((point) => point.lon.toFixed(3)).join(','),
    hourly: 'precipitation,pressure_msl', models: [].concat(providerModels).join(','),
    past_hours: '36', forecast_hours: '276', timezone: 'UTC', cell_selection: 'nearest',
  });
  const endpoint = openMeteoEndpointFor(providerModels);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${endpoint}?${query}`, { signal: AbortSignal.timeout(45000) });
    if (response.ok) {
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [payload];
      if (rows.length !== points.length) throw new Error(`전구모델 좌표 응답 수가 일치하지 않습니다. (${rows.length}/${points.length})`);
      try {
        await writeStoredJson(store, cacheKey, { generatedAt: new Date().toISOString(), rows });
      } catch {
        // The live response remains usable even when cache storage is temporarily unavailable.
      }
      return { rows, fromCache: false };
    }
    if (response.status !== 429 || attempt === 2) {
      throw new Error(`전구모델 정규화 요청 실패 (${response.status})`);
    }
    const retryAfter = Number(response.headers.get('Retry-After'));
    await delay(Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30000, retryAfter * 1000)
      : [8000, 22000][attempt]);
  }
  throw new Error('전구모델 정규화 요청을 완료하지 못했습니다.');
};

const fetchOpenMeteoRows = async (env, points, providerModels, cycle) => {
  const chunks = splitIntoChunks(points, openMeteoChunkSizeFor(providerModels));
  const rows = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const result = await fetchOpenMeteoChunk(env, chunks[index], providerModels, cycle);
    rows.push(...result.rows);
    if (!result.fromCache && index < chunks.length - 1) await delay(2000);
  }
  return rows;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const encodeField = (values, validCount, encoding, unit) => ({
  available: validCount >= Math.floor(values.length * 0.75),
  validRatio: values.length ? validCount / values.length : 0,
  encoding, unit, missingValue: MISSING_VALUE,
  values: bytesToBase64(new Uint8Array(values.buffer)),
});

const encodeUnavailableField = (
  length,
  reason,
  cacheProgress = null,
  encoding = 'uint16-centimm-le',
  unit = 'mm/6h',
) => {
  const values = new Uint16Array(length);
  values.fill(MISSING_VALUE);
  return {
    ...encodeField(values, 0, encoding, unit),
    reason,
    cacheProgress,
  };
};

const base64ToUint32 = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Uint32Array(bytes.buffer);
};

const base64ToFloat32 = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
};

const encodeOpenMeteo = (rows, targetTimes, providerModel, pointCount) => {
  const rain = new Uint16Array(targetTimes.length * pointCount);
  const pressure = new Uint16Array(targetTimes.length * pointCount);
  rain.fill(MISSING_VALUE);
  pressure.fill(MISSING_VALUE);
  let rainValid = 0;
  let pressureValid = 0;
  rows.forEach((row, pointIndex) => {
    const times = row?.hourly?.time;
    if (!Array.isArray(times)) return;
    const precipitation = findHourlyField(row.hourly, 'precipitation', providerModel);
    const pressureMsl = findHourlyField(row.hourly, 'pressure_msl', providerModel);
    const timeIndex = new Map(times.map((time, index) => [parseUtcTime(time), index]));
    targetTimes.forEach((targetMs, frameIndex) => {
      if (Array.isArray(precipitation)) {
        let total = 0;
        let valid = true;
        for (let back = FRAME_STEP_HOURS - 1; back >= 0; back -= 1) {
          const rawValue = precipitation[timeIndex.get(targetMs - back * HOUR_MS)];
          if (rawValue == null) { valid = false; break; }
          const value = Number(rawValue);
          if (!Number.isFinite(value)) { valid = false; break; }
          total += Math.max(0, value);
        }
        if (valid) {
          rain[frameIndex * pointCount + pointIndex] = Math.min(MISSING_VALUE - 1, Math.round(total * 100));
          rainValid += 1;
        }
      }
      if (Array.isArray(pressureMsl)) {
        const rawValue = pressureMsl[timeIndex.get(targetMs)];
        const value = rawValue == null ? Number.NaN : Number(rawValue);
        if (Number.isFinite(value) && value > 800 && value < 1200) {
          pressure[frameIndex * pointCount + pointIndex] = Math.round(value * 10);
          pressureValid += 1;
        }
      }
    });
  });
  return {
    rain: encodeField(rain, rainValid, 'uint16-centimm-le', 'mm/6h'),
    pressure: encodeField(pressure, pressureValid, 'uint16-decihpa-le', 'hPa'),
  };
};

const sourceIndexForPoint = (point, subset) => {
  const column = Math.round((point.lon - subset.lonMin) / KIM_NATIVE_STEP);
  const row = Math.round((point.lat - subset.latMin) / KIM_NATIVE_STEP);
  return column < 0 || column >= subset.width || row < 0 || row >= subset.height ? -1 : row * subset.width + column;
};

const buildDirectKimRain = async (env, cycle, grid, bbox, leadHours) => {
  const subset = kimSubsetForBbox(bbox);
  if (!subset) throw new Error('이 영역은 KIM 직접 격자 조회 범위를 벗어났습니다.');
  const frames = await fetchInBatches(leadHours, 8, (leadHour) => fetchKimField(env, cycle, leadHour, 'prec_acc', subset));
  const encoded = new Uint16Array(leadHours.length * grid.points.length);
  encoded.fill(MISSING_VALUE);
  const indexes = grid.points.map((point) => sourceIndexForPoint(point, subset));
  let validCount = 0;
  frames.forEach((frame, frameIndex) => {
    const previous = frameIndex ? frames[frameIndex - 1] : null;
    indexes.forEach((sourceIndex, pointIndex) => {
      if (sourceIndex < 0) return;
      const current = frame.values[sourceIndex];
      const before = previous?.values[sourceIndex] ?? 0;
      if (!Number.isFinite(current) || !Number.isFinite(before)) return;
      encoded[frameIndex * grid.points.length + pointIndex] = Math.min(MISSING_VALUE - 1, Math.round(Math.max(0, current - before) * 100));
      validCount += 1;
    });
  });
  return encodeField(encoded, validCount, 'uint16-centimm-le', 'mm/6h');
};

const shouldUseDirectKim = (bbox) => {
  const [lonMin, latMin, lonMax, latMax] = bbox;
  return lonMin >= 0 && lonMax <= 180 && lonMax - lonMin <= 16 && latMax - latMin <= 13;
};
const stableNumber = (value) => Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
const tileCacheKey = (cycle, model, bbox, step) =>
  `${CACHE_PREFIX}tiles/${cycle}/${model}/${bbox.map(stableNumber).join('_')}/${stableNumber(step)}.json`;
const pressureCacheKey = (cycle, frame, bbox, step) =>
  `${CACHE_PREFIX}pressure/${cycle}/kim-global/${frame}/${bbox.map(stableNumber).join('_')}/${stableNumber(step)}.json`;
const kimNativeFrameCacheKey = (cycle, frame, bbox) =>
  `${CACHE_PREFIX}native-frame/${cycle}/kim-global/${frame}/${bbox.map(stableNumber).join('_')}.json`;
const kimNativeSourceFieldCacheKey = (cycle, leadHour, name, subset) =>
  `${CACHE_PREFIX}kim/native-fields/${cycle}/${name}/${leadHour}/${subset.xMin}_${subset.yMin}_${subset.xMax}_${subset.yMax}.json`;
const kimGlobalFrameKey = (cycle, frameIndex) =>
  `${KIM_SOURCE_PREFIX}${cycle}/frame-${String(frameIndex).padStart(2, '0')}.json`;
const kimGlobalManifestKey = (cycle) => `${KIM_SOURCE_PREFIX}${cycle}/manifest.json`;
const kimGlobalBundleKey = (cycle) => `${KIM_SOURCE_PREFIX}${cycle}/bundle-v2.json`;

const readStoredJson = async (store, key) => {
  if (!store) return null;
  try {
    if (isKvStore(store)) return await store.get(key, 'json');
    const object = await store.get(key);
    return object ? await object.json() : null;
  } catch { return null; }
};
const hasStoredJson = async (store, key) => store
  ? typeof store.head === 'function' ? Boolean(await store.head(key)) : Boolean(await readStoredJson(store, key))
  : false;
const writeStoredJson = async (store, key, payload) => {
  if (!store) return;
  if (isKvStore(store)) {
    await store.put(key, JSON.stringify(payload), {
      expirationTtl: 3 * 24 * 60 * 60,
      metadata: { generatedAt: payload.generatedAt ?? new Date().toISOString() },
    });
    return;
  }
  await store.put(key, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=86400' },
    customMetadata: { generatedAt: payload.generatedAt ?? new Date().toISOString() },
  });
};

const fetchCachedKimNativeField = async (env, cycle, leadHour, name, subset, timeoutMs = 60000) => {
  const store = getStore(env);
  const cacheKey = kimNativeSourceFieldCacheKey(cycle, leadHour, name, subset);
  const cached = await readStoredJson(store, cacheKey);
  if (cached?.width === subset.width && cached?.height === subset.height && cached?.values) {
    const values = base64ToFloat32(cached.values);
    if (values.length === subset.width * subset.height) return { width: cached.width, height: cached.height, values };
  }
  const source = await fetchKimField(env, cycle, leadHour, name, subset, timeoutMs);
  try {
    await writeStoredJson(store, cacheKey, {
      generatedAt: new Date().toISOString(),
      width: source.width,
      height: source.height,
      encoding: 'float32-le',
      values: bytesToBase64(new Uint8Array(source.values.buffer)),
    });
  } catch {
    // Do not discard a successful KMA response because the cache write failed.
  }
  return source;
};

const isCompleteKimSourceFrame = (frame) => {
  if (!frame?.values) return false;
  const values = base64ToUint32(frame.values);
  if (values.length !== KIM_GLOBAL_GRID.width * KIM_GLOBAL_GRID.height) return false;
  let validCount = 0;
  values.forEach((value) => { if (value !== KIM_GLOBAL_MISSING) validCount += 1; });
  return validCount / values.length >= 0.995;
};

const fetchKimGlobalCumulativeFrame = async (env, cycle, frameIndex) => {
  const leadHour = frameLeadHours()[frameIndex];
  const subset = kimSubsetForBbox(EAST_ASIA_PRECOMPUTE.bbox);
  const source = await fetchCachedKimNativeField(env, cycle, leadHour, 'prec_acc', subset, 45000);
  const values = new Uint32Array(KIM_GLOBAL_GRID.width * KIM_GLOBAL_GRID.height);
  values.fill(KIM_GLOBAL_MISSING);
  for (let row = 0; row < KIM_GLOBAL_GRID.height; row += 1) {
    const latitude = KIM_GLOBAL_GRID.latMax - row * KIM_GLOBAL_GRID.latStep;
    for (let column = 0; column < KIM_GLOBAL_GRID.width; column += 1) {
      const longitude = KIM_GLOBAL_GRID.lonMin + column * KIM_GLOBAL_GRID.lonStep;
      const sourceIndex = sourceIndexForPoint({ lat: latitude, lon: longitude }, subset);
      if (sourceIndex < 0) continue;
      const value = source.values[sourceIndex];
      if (Number.isFinite(value) && value >= 0 && value < 100000) {
        values[row * KIM_GLOBAL_GRID.width + column] = Math.round(value * 100);
      }
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    cycle,
    frameIndex,
    leadHour,
    grid: KIM_GLOBAL_GRID,
    encoding: 'uint32-centimm-le',
    missingValue: KIM_GLOBAL_MISSING,
    values: bytesToBase64(new Uint8Array(values.buffer)),
  };
};

const assembleKimGlobalBundle = async (store, cycle, manifest) => {
  if (!store || !manifest.frames.every(Boolean)) return { bundle: null, invalidFrameIndexes: [] };
  const existing = await readStoredJson(store, kimGlobalBundleKey(cycle));
  if (existing) return { bundle: existing, invalidFrameIndexes: [] };
  const frames = await Promise.all(frameLeadHours().map((_, frameIndex) =>
    readStoredJson(store, kimGlobalFrameKey(cycle, frameIndex))));
  const invalidFrameIndexes = frames.flatMap((frame, frameIndex) =>
    isCompleteKimSourceFrame(frame) ? [] : [frameIndex]);
  if (invalidFrameIndexes.length) return { bundle: null, invalidFrameIndexes };
  const bundle = {
    generatedAt: new Date().toISOString(),
    cycle,
    grid: KIM_GLOBAL_GRID,
    encoding: 'uint32-centimm-le',
    missingValue: KIM_GLOBAL_MISSING,
    leadHours: frameLeadHours(),
    frames: frames.map((frame) => frame.values),
  };
  await writeStoredJson(store, kimGlobalBundleKey(cycle), bundle);
  return { bundle, invalidFrameIndexes: [] };
};

const warmKimGlobalFrame = async (env, cycle, scheduledTime = Date.now()) => {
  const store = getStore(env);
  if (!store) return { warmed: false, complete: false, count: 0 };
  const manifestKey = kimGlobalManifestKey(cycle);
  const manifest = await readStoredJson(store, manifestKey) || {
    generatedAt: new Date().toISOString(), cycle, frames: Array(FRAME_COUNT).fill(false),
  };
  if (manifest.frames.every(Boolean)) {
    const assembled = await assembleKimGlobalBundle(store, cycle, manifest);
    if (assembled.bundle) return { warmed: false, complete: true, count: FRAME_COUNT };
    assembled.invalidFrameIndexes.forEach((frameIndex) => { manifest.frames[frameIndex] = false; });
    await writeStoredJson(store, manifestKey, manifest);
  }
  const scheduledDate = new Date(scheduledTime);
  const preferredIndex = (scheduledDate.getUTCHours() * 60 + scheduledDate.getUTCMinutes()) % FRAME_COUNT;
  let frameIndex = preferredIndex;
  for (let offset = 0; offset < FRAME_COUNT; offset += 1) {
    const candidate = (preferredIndex + offset) % FRAME_COUNT;
    if (!manifest.frames[candidate]) { frameIndex = candidate; break; }
  }
  const key = kimGlobalFrameKey(cycle, frameIndex);
  const storedFrame = await readStoredJson(store, key);
  if (!isCompleteKimSourceFrame(storedFrame)) {
    const payload = await fetchKimGlobalCumulativeFrame(env, cycle, frameIndex);
    if (!isCompleteKimSourceFrame(payload)) throw new KimNoDataError('KIM 전구 원자료에 결측 영역이 있어 다시 수집합니다.');
    await writeStoredJson(store, key, payload);
  }
  manifest.frames[frameIndex] = true;
  manifest.generatedAt = new Date().toISOString();
  await writeStoredJson(store, manifestKey, manifest);
  const count = manifest.frames.filter(Boolean).length;
  return { warmed: true, complete: count === FRAME_COUNT, count };
};

const kimCacheIndexForPoint = (point, sourceGrid) => {
  let longitude = point.lon;
  const wrapsGlobe = sourceGrid.lonMax - sourceGrid.lonMin >= 350;
  if (wrapsGlobe) {
    while (longitude < sourceGrid.lonMin) longitude += 360;
    while (longitude > sourceGrid.lonMax) longitude -= 360;
  }
  let column = Math.round((longitude - sourceGrid.lonMin) / sourceGrid.lonStep);
  if (wrapsGlobe) column = ((column % sourceGrid.width) + sourceGrid.width) % sourceGrid.width;
  const row = Math.round((sourceGrid.latMax - point.lat) / sourceGrid.latStep);
  if (column < 0 || column >= sourceGrid.width || row < 0 || row >= sourceGrid.height) return -1;
  return row * sourceGrid.width + column;
};

const buildCachedKimRain = async (env, cycle, grid, leadHours) => {
  const store = getStore(env);
  const valueCount = leadHours.length * grid.points.length;
  if (!store) return encodeUnavailableField(valueCount, 'KIM global cache storage is not configured.');
  const bundle = await readStoredJson(store, kimGlobalBundleKey(cycle));
  if (!bundle?.frames || bundle.frames.length !== leadHours.length) {
    const manifest = await readStoredJson(store, kimGlobalManifestKey(cycle));
    const count = manifest?.frames?.filter(Boolean).length || 0;
    return encodeUnavailableField(valueCount, 'KIM global cache is warming.', { count, total: FRAME_COUNT });
  }
  const sourceGrid = bundle.grid ?? KIM_GLOBAL_GRID;
  const sourceIndexes = grid.points.map((point) => kimCacheIndexForPoint(point, sourceGrid));
  const encoded = new Uint16Array(valueCount);
  encoded.fill(MISSING_VALUE);
  let validCount = 0;
  let previous = null;
  bundle.frames.forEach((frameValue, frameIndex) => {
    const current = base64ToUint32(frameValue);
    sourceIndexes.forEach((sourceIndex, pointIndex) => {
      if (sourceIndex < 0) return;
      const currentValue = current[sourceIndex];
      const previousValue = previous ? previous[sourceIndex] : 0;
      if (currentValue === KIM_GLOBAL_MISSING || previousValue === KIM_GLOBAL_MISSING) return;
      encoded[frameIndex * grid.points.length + pointIndex] = Math.min(
        MISSING_VALUE - 1,
        Math.max(0, currentValue - previousValue),
      );
      validCount += 1;
    });
    previous = current;
  });
  return encodeField(encoded, validCount, 'uint16-centimm-le', 'mm/6h');
};

const buildMetadata = async (env) => {
  let cycle;
  let kimCycleVerified = true;
  try {
    cycle = await findKimCycle(env);
  } catch {
    cycle = buildCycleCandidates()[0];
    kimCycleVerified = false;
  }
  const cycleMs = parseUtcCycle(cycle);
  const leadHours = frameLeadHours();
  return {
    generatedAt: new Date().toISOString(), cycle, kimCycleVerified, horizonHours: 240,
    stepHours: FRAME_STEP_HOURS, accumulationHours: FRAME_STEP_HOURS, leadHours,
    times: leadHours.map((hour) => new Date(cycleMs + hour * HOUR_MS).toISOString()),
    temporalPolicy: 'common-6-hour-valid-window',
    models: Object.fromEntries(Object.entries(MODEL_CONFIG).map(([model, config]) => [model, {
      label: config.label, provider: config.provider, nativeResolution: config.nativeResolution,
    }])),
    attribution: 'KMA · ECMWF · NOAA · Open-Meteo',
  };
};

const buildTile = async (env, { model, bbox, requestedStep, cycle }) => {
  if (model === 'compare') {
    const grid = buildGrid(bbox, requestedStep);
    const leadHours = frameLeadHours();
    const targetTimes = leadHours.map((hour) => parseUtcCycle(cycle) + hour * HOUR_MS);
    const directKim = shouldUseDirectKim(bbox);
    const normalizedModels = MODEL_IDS_WITHOUT_KIM;
    const providerModels = normalizedModels.map((modelId) => MODEL_CONFIG[modelId].providerModel);
    const [kimRain, chunkRows] = await Promise.all([
      directKim
        ? buildDirectKimRain(env, cycle, grid, bbox, leadHours)
        : buildCachedKimRain(env, cycle, grid, leadHours),
      fetchOpenMeteoRows(env, grid.points, providerModels, cycle),
    ]);
    const rows = chunkRows.flat();
    if (rows.length !== grid.points.length) throw new Error(`전구모델 격자 수가 일치하지 않습니다. (${rows.length}/${grid.points.length})`);
    const models = {};
    normalizedModels.forEach((modelId) => {
      const config = MODEL_CONFIG[modelId];
      const fields = encodeOpenMeteo(rows, targetTimes, config.providerModel, grid.points.length);
      models[modelId] = {
        ...fields,
        source: config.provider,
        sourceMode: 'normalized-spatial-grid',
      };
    });
    models['kim-global'] = {
      rain: kimRain,
      pressure: null,
      source: directKim ? 'KMA API Hub direct grid' : 'KMA API Hub cached East Asia grid',
      sourceMode: directKim ? 'native-subset' : kimRain.available ? 'official-east-asia-cache' : 'cache-warming',
    };
    return {
      generatedAt: new Date().toISOString(), cycle, model: 'compare',
      source: 'KMA API Hub and normalized provider grids',
      grid: {
        lonMin: grid.lonMin, lonMax: grid.lonMax, latMin: grid.latMin, latMax: grid.latMax,
        step: grid.step, width: grid.width, height: grid.height, order: grid.order,
      },
      leadHours,
      times: targetTimes.map((time) => new Date(time).toISOString()),
      models,
    };
  }
  const config = MODEL_CONFIG[model];
  if (!config) throw new Error('지원하지 않는 전구모델입니다.');
  const grid = buildGrid(bbox, requestedStep);
  const leadHours = frameLeadHours();
  const targetTimes = leadHours.map((hour) => parseUtcCycle(cycle) + hour * HOUR_MS);
  const directKim = model === 'kim-global' && shouldUseDirectKim(bbox);
  let rain;
  let pressure = null;
  if (directKim) {
    rain = await buildDirectKimRain(env, cycle, grid, bbox, leadHours);
  } else if (model === 'kim-global') {
    rain = await buildCachedKimRain(env, cycle, grid, leadHours);
  } else {
    const rows = await fetchOpenMeteoRows(env, grid.points, config.providerModel, cycle);
    if (rows.length !== grid.points.length) throw new Error(`전구모델 격자 수가 일치하지 않습니다. (${rows.length}/${grid.points.length})`);
    ({ rain, pressure } = encodeOpenMeteo(rows, targetTimes, config.providerModel, grid.points.length));
  }
  return {
    generatedAt: new Date().toISOString(), cycle, model, label: config.label,
    source: directKim
      ? 'KMA API Hub direct grid'
      : model === 'kim-global' ? 'KMA API Hub cached East Asia grid' : config.provider,
    sourceMode: directKim
      ? 'native-subset'
      : model === 'kim-global' ? rain.available ? 'official-east-asia-cache' : 'cache-warming' : 'normalized-spatial-grid',
    grid: {
      lonMin: grid.lonMin, lonMax: grid.lonMax, latMin: grid.latMin, latMax: grid.latMax,
      step: grid.step, width: grid.width, height: grid.height, order: grid.order,
    },
    leadHours, times: targetTimes.map((time) => new Date(time).toISOString()), rain, pressure,
  };
};

const buildDirectKimPressure = async (env, { bbox, requestedStep, cycle, frameIndex }) => {
  const grid = buildGrid(bbox, requestedStep);
  const leadHour = frameLeadHours()[frameIndex];
  const encoded = new Uint16Array(grid.points.length);
  encoded.fill(MISSING_VALUE);
  let validCount = 0;
  const pointGroups = [[], []];
  grid.points.forEach((point, pointIndex) => {
    const normalizedPoint = {
      ...point,
      lon: Math.max(KIM_NATIVE_STEP, point.lon < 0 ? point.lon + 360 : point.lon),
    };
    pointGroups[normalizedPoint.lon <= 180 ? 0 : 1].push({ point: normalizedPoint, pointIndex });
  });
  const results = await Promise.all(pointGroups.filter((group) => group.length).map(async (group) => {
    const longitudes = group.map((entry) => entry.point.lon);
    const subset = kimSubsetForBbox([
      Math.min(...longitudes),
      grid.latMin,
      Math.max(...longitudes),
      grid.latMax,
    ]);
    if (!subset) return null;
    const source = await fetchKimField(env, cycle, leadHour, 'psl', subset);
    return { group, subset, source };
  }));
  results.filter(Boolean).forEach(({ group, subset, source }) => {
    group.forEach(({ point, pointIndex }) => {
      const sourceIndex = sourceIndexForPoint(point, subset);
      if (sourceIndex < 0) return;
      const pascals = source.values[sourceIndex];
      if (!Number.isFinite(pascals) || pascals < 80000 || pascals > 120000) return;
      encoded[pointIndex] = Math.round(pascals / 10);
      validCount += 1;
    });
  });
  return {
    generatedAt: new Date().toISOString(), cycle, model: 'kim-global', frameIndex,
    time: new Date(parseUtcCycle(cycle) + leadHour * HOUR_MS).toISOString(),
    source: 'KMA API Hub direct grid',
    grid: {
      lonMin: grid.lonMin, lonMax: grid.lonMax, latMin: grid.latMin, latMax: grid.latMax,
      step: grid.step, width: grid.width, height: grid.height, order: grid.order,
    },
    pressure: encodeField(encoded, validCount, 'uint16-decihpa-le', 'hPa'),
  };
};

const buildKimNativeFrame = async (env, { bbox, cycle, frameIndex }) => {
  const subset = kimSubsetForBbox(bbox);
  if (!subset) throw new Error('이 영역은 KIM 네이티브 격자 조회 범위를 벗어났습니다.');
  const leadHour = frameLeadHours()[frameIndex];
  const previousLeadHour = frameIndex > 0 ? frameLeadHours()[frameIndex - 1] : null;
  const [currentRain, previousRain, pressureSource] = await Promise.all([
    fetchCachedKimNativeField(env, cycle, leadHour, 'prec_acc', subset, 60000),
    previousLeadHour == null
      ? Promise.resolve(null)
      : fetchCachedKimNativeField(env, cycle, previousLeadHour, 'prec_acc', subset, 60000),
    fetchCachedKimNativeField(env, cycle, leadHour, 'psl', subset, 60000),
  ]);

  const rainValues = new Uint16Array(subset.width * subset.height);
  rainValues.fill(MISSING_VALUE);
  let rainValid = 0;
  for (let row = 0; row < subset.height; row += 1) {
    const sourceRow = subset.height - 1 - row;
    for (let column = 0; column < subset.width; column += 1) {
      const sourceIndex = sourceRow * subset.width + column;
      const current = currentRain.values[sourceIndex];
      const previous = previousRain?.values[sourceIndex] ?? 0;
      if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;
      rainValues[row * subset.width + column] = Math.min(
        MISSING_VALUE - 1,
        Math.round(Math.max(0, current - previous) * 100),
      );
      rainValid += 1;
    }
  }

  const pressureGrid = buildGrid(bbox, 0.5);
  const pressureValues = new Uint16Array(pressureGrid.points.length);
  pressureValues.fill(MISSING_VALUE);
  let pressureValid = 0;
  pressureGrid.points.forEach((point, pointIndex) => {
    const sourceIndex = sourceIndexForPoint(point, subset);
    if (sourceIndex < 0) return;
    const pascals = pressureSource.values[sourceIndex];
    if (!Number.isFinite(pascals) || pascals < 80000 || pascals > 120000) return;
    pressureValues[pointIndex] = Math.round(pascals / 10);
    pressureValid += 1;
  });

  const validTime = new Date(parseUtcCycle(cycle) + leadHour * HOUR_MS).toISOString();
  const nativeGrid = {
    lonMin: subset.lonMin,
    lonMax: subset.lonMin + (subset.width - 1) * KIM_NATIVE_STEP,
    latMin: subset.latMin,
    latMax: subset.latMin + (subset.height - 1) * KIM_NATIVE_STEP,
    step: KIM_NATIVE_STEP,
    width: subset.width,
    height: subset.height,
    order: 'north-to-south-row-major',
  };
  return {
    generatedAt: new Date().toISOString(),
    cycle,
    model: 'kim-global',
    label: MODEL_CONFIG['kim-global'].label,
    source: 'KMA API Hub direct native grid',
    sourceMode: 'native-frame',
    frameIndex,
    grid: nativeGrid,
    leadHours: [leadHour],
    times: [validTime],
    rain: encodeField(rainValues, rainValid, 'uint16-centimm-le', 'mm/6h'),
    pressure: {
      ...encodeField(pressureValues, pressureValid, 'uint16-decihpa-le', 'hPa'),
      grid: {
        lonMin: pressureGrid.lonMin,
        lonMax: pressureGrid.lonMax,
        latMin: pressureGrid.latMin,
        latMax: pressureGrid.latMax,
        step: pressureGrid.step,
        width: pressureGrid.width,
        height: pressureGrid.height,
        order: pressureGrid.order,
      },
    },
  };
};

const parseTileRequest = (url) => {
  const model = url.searchParams.get('model') || 'kim-global';
  const bbox = normalizeBbox((url.searchParams.get('bbox') || '').split(','));
  const requestedStep = Number(url.searchParams.get('step')) || 1;
  const cycle = url.searchParams.get('cycle');
  if (cycle && !/^\d{10}$/.test(cycle)) throw new Error('모델 기준시각이 올바르지 않습니다.');
  return { model, bbox, requestedStep, cycle };
};

const cacheableResponse = (payload, source) => jsonResponse(
  payload, 200, 'public, max-age=300, s-maxage=86400, stale-while-revalidate=3600',
  { 'X-Global-Model-Source': source },
);

const rememberRuntimePayload = (key, payload) => {
  runtimePayloadCache.delete(key);
  runtimePayloadCache.set(key, payload);
  while (runtimePayloadCache.size > RUNTIME_CACHE_LIMIT) {
    runtimePayloadCache.delete(runtimePayloadCache.keys().next().value);
  }
};

const isCompletePayload = (payload) => payload.model === 'compare'
  ? Object.values(payload.models ?? {}).every((model) => model.rain?.available)
  : payload.rain?.available !== false;

const serveWithCache = async (env, executionCtx, key, builder) => {
  const runtimePayload = runtimePayloadCache.get(key);
  if (runtimePayload) {
    rememberRuntimePayload(key, runtimePayload);
    return cacheableResponse(runtimePayload, 'runtime');
  }
  const edgeCache = getEdgeCache();
  const edgeKey = new Request(`https://model-cache.invalid/${key}`);
  if (edgeCache) { const cached = await edgeCache.match(edgeKey); if (cached) return cached; }
  const store = getStore(env);
  const stored = await readStoredJson(store, key);
  if (stored) {
    rememberRuntimePayload(key, stored);
    const response = cacheableResponse(stored, 'r2');
    if (edgeCache) executionCtx.waitUntil(edgeCache.put(edgeKey, response.clone()));
    return response;
  }
  let build = inflightBuilds.get(key);
  if (!build) {
    build = builder();
    inflightBuilds.set(key, build);
  }
  let payload;
  try {
    payload = await build;
  } finally {
    if (inflightBuilds.get(key) === build) inflightBuilds.delete(key);
  }
  if (!isCompletePayload(payload)) return jsonResponse(payload, 200, 'no-store', { 'X-Global-Model-Source': 'live-incomplete' });
  rememberRuntimePayload(key, payload);
  const response = cacheableResponse(payload, 'live');
  if (store) executionCtx.waitUntil(writeStoredJson(store, key, payload));
  if (edgeCache) executionCtx.waitUntil(edgeCache.put(edgeKey, response.clone()));
  return response;
};

const handleMetadata = async (env, executionCtx) => {
  const edgeCache = getEdgeCache();
  const cacheKey = new Request('https://model-cache.invalid/metadata/v4');
  if (edgeCache) { const cached = await edgeCache.match(cacheKey); if (cached) return cached; }
  const response = jsonResponse(await buildMetadata(env), 200, 'public, max-age=120, s-maxage=300');
  if (edgeCache) executionCtx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
};

const handleTile = async (request, env, executionCtx) => {
  const parsed = parseTileRequest(new URL(request.url));
  const cycle = parsed.cycle || (await buildMetadata(env)).cycle;
  const params = { ...parsed, cycle };
  return serveWithCache(env, executionCtx, tileCacheKey(cycle, params.model, params.bbox, params.requestedStep), () => buildTile(env, params));
};

const handlePressure = async (request, env, executionCtx) => {
  const url = new URL(request.url);
  const parsed = parseTileRequest(url);
  const frameIndex = Number(url.searchParams.get('frame'));
  if (parsed.model !== 'kim-global') return jsonResponse({ error: '별도 기압 조회는 KIM 전구모델에만 사용합니다.' }, 400);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= FRAME_COUNT) return jsonResponse({ error: '예보 프레임 번호가 올바르지 않습니다.' }, 400);
  const cycle = parsed.cycle || (await buildMetadata(env)).cycle;
  const params = { ...parsed, cycle, frameIndex };
  return serveWithCache(env, executionCtx, pressureCacheKey(cycle, frameIndex, parsed.bbox, parsed.requestedStep), () => buildDirectKimPressure(env, params));
};

const handleKimFrame = async (request, env, executionCtx) => {
  const url = new URL(request.url);
  const parsed = parseTileRequest(url);
  const frameIndex = Number(url.searchParams.get('frame'));
  if (parsed.model !== 'kim-global') return jsonResponse({ error: '네이티브 프레임 조회는 KIM 전구모델에만 사용합니다.' }, 400);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= FRAME_COUNT) return jsonResponse({ error: '예보 프레임 번호가 올바르지 않습니다.' }, 400);
  const cycle = parsed.cycle || (await buildMetadata(env)).cycle;
  const params = { ...parsed, cycle, frameIndex };
  return serveWithCache(
    env,
    executionCtx,
    kimNativeFrameCacheKey(cycle, frameIndex, parsed.bbox),
    () => buildKimNativeFrame(env, params),
  );
};

const handleStatus = async (env) => {
  const metadata = await buildMetadata(env);
  const store = getStore(env);
  const kimManifest = store ? await readStoredJson(store, kimGlobalManifestKey(metadata.cycle)) : null;
  const kimFrameCount = kimManifest?.frames?.filter(Boolean).length || 0;
  const warmed = {
    kimGlobal: {
      complete: await hasStoredJson(store, kimGlobalBundleKey(metadata.cycle)),
      frames: kimFrameCount,
      totalFrames: FRAME_COUNT,
    },
  };
  return jsonResponse({
    ready: true, cycle: metadata.cycle, warmed,
    storage: env.MODEL_R2
      ? 'model-r2'
      : env.SATELLITE_R2
        ? 'shared-r2-fallback'
        : env.MODEL_CACHE || env.KIM_RAIN_CACHE ? 'kv-fallback' : 'edge-only',
  });
};

const handleWarm = async (env) => {
  const store = getStore(env);
  if (!store) return jsonResponse({ error: 'KIM global cache storage is not configured.' }, 503);
  const metadata = await buildMetadata(env);
  const result = await warmKimGlobalFrame(env, metadata.cycle, Date.now());
  const bundleReady = await hasStoredJson(store, kimGlobalBundleKey(metadata.cycle));
  return jsonResponse({
    ready: bundleReady,
    cycle: metadata.cycle,
    frames: result.count,
    totalFrames: FRAME_COUNT,
  }, 200, 'no-store');
};

const routeRequest = async (request, env, executionCtx) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  try {
    if (action === 'metadata' || url.pathname.endsWith('/metadata')) return await handleMetadata(env, executionCtx);
    if (action === 'frame' || url.pathname.endsWith('/frame')) return await handleKimFrame(request, env, executionCtx);
    if (action === 'pressure' || url.pathname.endsWith('/pressure')) return await handlePressure(request, env, executionCtx);
    if (action === 'status' || url.pathname.endsWith('/status')) return await handleStatus(env);
    if (action === 'warm' || url.pathname.endsWith('/warm')) return await handleWarm(env);
    return await handleTile(request, env, executionCtx);
  } catch (error) {
    return jsonResponse({ error: error.message || '전구모델 자료를 불러오지 못했습니다.' }, 502);
  }
};

const precompute = async (env, scheduledTime = Date.now()) => {
  const metadata = await buildMetadata(env);
  await warmKimGlobalFrame(env, metadata.cycle, scheduledTime);
};

export default {
  fetch: routeRequest,
  scheduled(controller, env, executionCtx) {
    executionCtx.waitUntil(precompute(env, controller.scheduledTime));
  },
};

export { buildMetadata, buildTile, routeRequest };
