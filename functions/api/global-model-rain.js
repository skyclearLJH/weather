const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const KIM_GRID_URL =
  'https://apihub.kma.go.kr/api/typ06/cgi-bin/url/nph-kim_nc_xy_txt2_std';
const FORECAST_HOURS = 241;
const PAST_HOURS = 24;
const OUTPUT_STEP_HOURS = 6;
const HOUR_MS = 60 * 60 * 1000;
const GRID = {
  lonMin: 123.7,
  lonMax: 132.1,
  latMin: 32.5,
  latMax: 39.7,
  step: 0.4,
};
const KIM_SUBSET = {
  xMin: 1483,
  xMax: 1587,
  yMin: 1468,
  yMax: 1559,
  step: 1 / 12,
  lonMin: 1483 / 12,
  latMin: -89.95882415771484 + 1468 / 12,
};
const CHUNK_SIZE = 80;
const KIM_CONCURRENCY = 8;
const CACHE_SECONDS = 60 * 60;
const RAW_KIM_CACHE_SECONDS = 7 * 24 * 60 * 60;
const MISSING_VALUE = 65535;
const MODEL_FIELDS = {
  ifs: 'precipitation_ecmwf_ifs025',
  aifs: 'precipitation_ecmwf_aifs025_single',
  gfs: 'precipitation_ncep_gfs_global',
};
const OPEN_METEO_MODELS = [
  'ecmwf_ifs025',
  'ecmwf_aifs025_single',
  'ncep_gfs_global',
];

class KimNoDataError extends Error {
  constructor(message = 'KIM 전구모델 자료가 아직 생산되지 않았습니다.') {
    super(message);
    this.name = 'KimNoDataError';
  }
}

const readAuthKey = (env) =>
  env?.KMA_BROADCAST_AUTH_KEY ||
  env?.KMA_AUTH_KEY ||
  env?.VITE_KMA_AUTH_KEY ||
  (typeof process !== 'undefined' &&
    (process.env.KMA_BROADCAST_AUTH_KEY ||
      process.env.KMA_AUTH_KEY ||
      process.env.VITE_KMA_AUTH_KEY)) ||
  '';

const jsonResponse = (payload, status = 200, cacheControl = 'no-store') =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });

const getEdgeCache = () =>
  typeof caches !== 'undefined' && caches.default ? caches.default : null;

const putCache = (context, key, response) => {
  const cache = getEdgeCache();
  if (!cache) return;
  const task = cache.put(key, response.clone());
  if (typeof context.waitUntil === 'function') context.waitUntil(task);
  else task.catch(() => {});
};

const buildGridPoints = () => {
  const width = Math.round((GRID.lonMax - GRID.lonMin) / GRID.step) + 1;
  const height = Math.round((GRID.latMax - GRID.latMin) / GRID.step) + 1;
  const points = [];
  for (let row = 0; row < height; row += 1) {
    const lat = GRID.latMax - row * GRID.step;
    for (let column = 0; column < width; column += 1) {
      points.push({ lat, lon: GRID.lonMin + column * GRID.step });
    }
  }
  return { width, height, points };
};

const fetchOpenMeteoChunk = async (points) => {
  const query = new URLSearchParams({
    latitude: points.map((point) => point.lat.toFixed(2)).join(','),
    longitude: points.map((point) => point.lon.toFixed(2)).join(','),
    hourly: 'precipitation',
    models: OPEN_METEO_MODELS.join(','),
    past_hours: String(PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    timezone: 'UTC',
    cell_selection: 'nearest',
  });
  const response = await fetch(`${OPEN_METEO_URL}?${query}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`전구모델 중계 요청 실패 (${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [payload];
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const encodeValues = (encoded, validCount) => ({
  available: validCount >= Math.floor(encoded.length * 0.8),
  validRatio: encoded.length > 0 ? validCount / encoded.length : 0,
  encoding: 'uint16-centimm-le',
  missingValue: MISSING_VALUE,
  values: bytesToBase64(new Uint8Array(encoded.buffer)),
});

const parseUtcTime = (value) => {
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value.endsWith('Z') ? value : `${value}Z`);
};

const encodeOpenMeteoValues = (rows, targetTimes, fieldName, pointCount) => {
  const encoded = new Uint16Array(targetTimes.length * pointCount);
  encoded.fill(MISSING_VALUE);
  let validCount = 0;

  rows.forEach((row, pointIndex) => {
    const times = row?.hourly?.time;
    const values = row?.hourly?.[fieldName];
    if (!Array.isArray(times) || !Array.isArray(values)) return;
    const timeIndex = new Map(times.map((time, index) => [parseUtcTime(time), index]));

    targetTimes.forEach((targetMs, frameIndex) => {
      let total = 0;
      for (let back = OUTPUT_STEP_HOURS - 1; back >= 0; back -= 1) {
        const index = timeIndex.get(targetMs - back * HOUR_MS);
        const value = Number(values[index]);
        if (!Number.isFinite(value)) return;
        total += Math.max(0, value);
      }
      encoded[frameIndex * pointCount + pointIndex] = Math.min(
        MISSING_VALUE - 1,
        Math.round(total * 100),
      );
      validCount += 1;
    });
  });

  return encodeValues(encoded, validCount);
};

const pad2 = (value) => String(value).padStart(2, '0');
const formatUtcCycle = (date) =>
  `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}`;

const parseUtcCycle = (value) => Date.UTC(
  Number(value.slice(0, 4)),
  Number(value.slice(4, 6)) - 1,
  Number(value.slice(6, 8)),
  Number(value.slice(8, 10)),
);

const buildKimCycleCandidates = (nowMs = Date.now()) => {
  const now = new Date(nowMs);
  const availableHour = now.getUTCHours() >= 18 ? 12 : now.getUTCHours() >= 6 ? 0 : -12;
  const firstMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    availableHour,
  );
  return Array.from({ length: 4 }, (_, index) =>
    formatUtcCycle(new Date(firstMs - index * 12 * HOUR_MS)));
};

const parseKimBinary = (buffer) => {
  if (buffer.byteLength < 8) throw new KimNoDataError();
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const expectedWidth = KIM_SUBSET.xMax - KIM_SUBSET.xMin + 1;
  const expectedHeight = KIM_SUBSET.yMax - KIM_SUBSET.yMin + 1;
  if (
    width !== expectedWidth ||
    height !== expectedHeight ||
    buffer.byteLength < 8 + width * height * 4
  ) {
    throw new KimNoDataError('KIM 전구모델 격자 형식이 올바르지 않습니다.');
  }
  return { width, height, values: new Float32Array(buffer, 8, width * height) };
};

const fetchKimCumulative = async (context, cycle, leadHour) => {
  const cache = getEdgeCache();
  const cacheKey = new Request(
    `${new URL(context.request.url).origin}/__kim-global-raw/v1/${cycle}/${leadHour}`,
  );
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return parseKimBinary(await cached.arrayBuffer());

  const authKey = readAuthKey(context.env);
  if (!authKey) throw new Error('KIM 전구모델 기상청 인증키가 설정되지 않았습니다.');
  const query = new URLSearchParams({
    group: 'KIMG',
    nwp: 'NE57',
    data: 'U',
    name: 'prec_acc',
    map: 'S',
    sub: `${KIM_SUBSET.xMin},${KIM_SUBSET.yMin},${KIM_SUBSET.xMax},${KIM_SUBSET.yMax}`,
    tmfc: cycle,
    hf: String(leadHour),
    disp: 'B',
    help: '0',
    authKey,
  });
  const response = await fetch(`${KIM_GRID_URL}?${query}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 403) throw new Error('KIM 전구모델 API 활용 권한이 없습니다.');
  if (!response.ok) throw new KimNoDataError(`KIM 전구모델 요청 실패 (${response.status})`);
  const buffer = await response.arrayBuffer();
  const parsed = parseKimBinary(buffer);
  putCache(
    context,
    cacheKey,
    new Response(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=${RAW_KIM_CACHE_SECONDS}`,
      },
    }),
  );
  return parsed;
};

const fetchInBatches = async (items, batchSize, fetcher) => {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    results.push(...await Promise.all(batch.map(fetcher)));
  }
  return results;
};

const findKimCycle = async (context) => {
  let lastError = null;
  for (const cycle of buildKimCycleCandidates()) {
    try {
      return { cycle, firstFrame: await fetchKimCumulative(context, cycle, OUTPUT_STEP_HOURS) };
    } catch (error) {
      if (!(error instanceof KimNoDataError)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new KimNoDataError();
};

const sourceIndexForPoint = (point, sourceWidth, sourceHeight) => {
  const column = Math.round((point.lon - KIM_SUBSET.lonMin) / KIM_SUBSET.step);
  const row = Math.round((point.lat - KIM_SUBSET.latMin) / KIM_SUBSET.step);
  if (column < 0 || column >= sourceWidth || row < 0 || row >= sourceHeight) return -1;
  return row * sourceWidth + column;
};

const buildKimModel = async (context, points, leadHours) => {
  const { cycle, firstFrame } = await findKimCycle(context);
  const remaining = await fetchInBatches(
    leadHours.slice(1),
    KIM_CONCURRENCY,
    (leadHour) => fetchKimCumulative(context, cycle, leadHour),
  );
  const frames = [firstFrame, ...remaining];
  const encoded = new Uint16Array(leadHours.length * points.length);
  encoded.fill(MISSING_VALUE);
  const sourceIndexes = points.map((point) =>
    sourceIndexForPoint(point, firstFrame.width, firstFrame.height));
  let validCount = 0;

  frames.forEach((frame, frameIndex) => {
    const previous = frameIndex > 0 ? frames[frameIndex - 1] : null;
    sourceIndexes.forEach((sourceIndex, pointIndex) => {
      if (sourceIndex < 0) return;
      const currentValue = frame.values[sourceIndex];
      const previousValue = previous?.values[sourceIndex] ?? 0;
      if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return;
      const amount = Math.max(0, currentValue - previousValue);
      encoded[frameIndex * points.length + pointIndex] = Math.min(
        MISSING_VALUE - 1,
        Math.round(amount * 100),
      );
      validCount += 1;
    });
  });

  return {
    cycle,
    times: leadHours.map((hour) => parseUtcCycle(cycle) + hour * HOUR_MS),
    model: encodeValues(encoded, validCount),
  };
};

const buildPayload = async (context) => {
  const { width, height, points } = buildGridPoints();
  const leadHours = Array.from(
    { length: 240 / OUTPUT_STEP_HOURS },
    (_, index) => (index + 1) * OUTPUT_STEP_HOURS,
  );
  const chunks = [];
  for (let offset = 0; offset < points.length; offset += CHUNK_SIZE) {
    chunks.push(points.slice(offset, offset + CHUNK_SIZE));
  }
  const [kim, chunkRows] = await Promise.all([
    buildKimModel(context, points, leadHours),
    fetchInBatches(chunks, 1, fetchOpenMeteoChunk),
  ]);
  const targetTimes = kim.times;
  const rows = chunkRows.flat();
  if (rows.length !== points.length) {
    throw new Error(`전구모델 격자 수가 일치하지 않습니다. (${rows.length}/${points.length})`);
  }

  const models = {
    'kim-global': kim.model,
    ...Object.fromEntries(
      Object.entries(MODEL_FIELDS).map(([modelId, fieldName]) => [
        modelId,
        encodeOpenMeteoValues(rows, targetTimes, fieldName, points.length),
      ]),
    ),
  };

  return {
    generatedAt: new Date().toISOString(),
    source: 'KMA API Hub and Open-Meteo normalized provider grids',
    attribution: 'KMA · ECMWF · NOAA · Open-Meteo',
    sourceCycles: { 'kim-global': kim.cycle },
    horizonHours: 240,
    leadHours,
    stepHours: OUTPUT_STEP_HOURS,
    accumulationHours: OUTPUT_STEP_HOURS,
    unit: 'mm/6h',
    temporalPolicy: 'common-valid-time-window-no-downscaling',
    nativeIntervals: {
      'kim-global': '1h to +135h, 3h thereafter',
      ifs: '3h to +144h, 6h thereafter',
      aifs: '6h',
      gfs: '1h to +120h, 3h thereafter',
    },
    grid: { ...GRID, width, height, order: 'north-to-south-row-major' },
    times: targetTimes.map((time) => new Date(time).toISOString()),
    models,
  };
};

export const onRequestOptions = async () =>
  new Response(null, { status: 204, headers: corsHeaders });

export const onRequestGet = async (context) => {
  const requestUrl = new URL(context.request.url);
  const refresh = requestUrl.searchParams.get('_refresh') === '1';
  const cache = getEdgeCache();
  const cacheKey = new Request(`${requestUrl.origin}/__global-model-rain/v3`);

  if (!refresh && cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  try {
    const response = jsonResponse(
      await buildPayload(context),
      200,
      `public, max-age=300, s-maxage=${CACHE_SECONDS}`,
    );
    if (cache) putCache(context, cacheKey, response);
    return response;
  } catch (error) {
    return jsonResponse(
      { error: error.message || '전구모델 강수 자료를 불러오지 못했습니다.' },
      502,
    );
  }
};
