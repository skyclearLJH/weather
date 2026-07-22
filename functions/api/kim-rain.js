const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': [
    'X-Kim-Base-Time',
    'X-Kim-Valid-Time',
    'X-Kim-Lead-Hour',
    'X-Kim-Width',
    'X-Kim-Height',
    'X-Kim-Origin-X',
    'X-Kim-Origin-Y',
    'X-Kim-Grid-Km',
    'X-Kim-Unit',
    'X-Kim-Conversion',
    'X-Kim-Encoding',
    'X-Kim-Domain',
    'X-Kim-Data-Source',
  ].join(','),
};

const KIM_HEADER_URL = 'https://apihub.kma.go.kr/api/typ06/cgi-bin/url/nph-nwp_header';
const KIM_DOWNLOAD_URL = 'https://apihub.kma.go.kr/api/typ06/url/nwp_vars_down.php';
const MAX_LEAD_HOUR = 48;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const COMPLETE_CYCLE_CACHE_SECONDS = 5 * 60;
const FRAME_CACHE_SECONDS = 7 * 24 * 60 * 60;
const KIM_R2_VERSION = 'v1';
const DEFAULT_PRECOMPUTE_BATCH_SIZE = 6;
const DEFAULT_RETAINED_CYCLES = 3;
const STORED_META_FRESH_SECONDS = 30 * 60;
// KMA l010 GRIB uses a 1 km Lambert grid whose lower-left point is 119.82288E, 30.77852N.
const SOURCE_GRID = {
  width: 1176,
  height: 1536,
  gridKm: 1,
  originX: 587.5923527533838,
  originY: 767.6189673632407,
};
const DOWNSAMPLE = 2;
const SMOOTHING_PASSES = 1;
const LOCAL_KOREA_BOUNDS = {
  lonMin: 118.2,
  lonMax: 133.8,
  latMin: 30.7,
  latMax: 45.2,
};

class KimNoDataError extends Error {
  constructor(message = 'KIM 자료가 아직 생산되지 않았습니다.') {
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

const jsonResponse = (
  payload,
  status = 200,
  cacheControl = 'no-store',
  extraHeaders = {},
) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...extraHeaders,
    },
  });

const isPrecomputedKimDisabled = (env) =>
  ['1', 'true', 'yes', 'on'].includes(
    String(env?.DISABLE_PRECOMPUTED_KIM ?? '').trim().toLowerCase(),
  );

const getKimBucket = (env) =>
  !isPrecomputedKimDisabled(env) && env?.KIM_RAIN_CACHE ? env.KIM_RAIN_CACHE : null;

const isKvStorage = (storage) => typeof storage?.getWithMetadata === 'function';
const getKimStorageKind = (env) => {
  const storage = getKimBucket(env);
  if (!storage) return '';
  return isKvStorage(storage) ? 'kv' : 'r2';
};

const kimMetaR2Key = () => `kim-rain/${KIM_R2_VERSION}/meta/latest.json`;
const kimFrameR2Prefix = (baseTime = '') =>
  `kim-rain/${KIM_R2_VERSION}/frames/${baseTime ? `${baseTime}/` : ''}`;
const kimFrameR2Key = (baseTime, leadHour) =>
  `${kimFrameR2Prefix(baseTime)}${String(leadHour).padStart(2, '0')}.bin`;

const isStoredMetaFresh = (meta, nowMs = Date.now()) => {
  const generatedMs = Date.parse(meta?.generatedAt ?? '');
  return Number.isFinite(generatedMs) && nowMs - generatedMs <= STORED_META_FRESH_SECONDS * 1000;
};

const getEdgeCache = () =>
  typeof caches !== 'undefined' && caches.default ? caches.default : null;

const cacheKey = (requestUrl, suffix) => {
  const url = new URL(requestUrl);
  return new Request(`${url.origin}/__kim-rain-cache/v9/${suffix}`);
};

const putCache = (context, key, response) => {
  const cache = getEdgeCache();
  if (!cache) return;
  const task = cache.put(key, response.clone());
  if (typeof context.waitUntil === 'function') context.waitUntil(task);
  else task.catch(() => {});
};

const pad2 = (value) => String(value).padStart(2, '0');

const formatKstTm = (utcMs) => {
  const kst = new Date(utcMs + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}${pad2(kst.getUTCMonth() + 1)}${pad2(kst.getUTCDate())}${pad2(kst.getUTCHours())}${pad2(kst.getUTCMinutes())}`;
};

const parseKstTm = (value) => {
  if (!/^\d{12}$/.test(value ?? '')) return null;
  return (
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
      Number(value.slice(8, 10)),
      Number(value.slice(10, 12)),
    ) - KST_OFFSET_MS
  );
};

const formatUtcCycle = (kstBaseTime) => {
  const utcMs = parseKstTm(kstBaseTime);
  const date = new Date(utcMs);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}`;
};

const buildRecentCycleTimes = (nowMs = Date.now(), count = 8) => {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  const cycleHours = [21, 15, 9, 3];
  let cycleHour = cycleHours.find((hour) => hour <= kst.getUTCHours());
  let cycleMs;
  if (cycleHour === undefined) {
    cycleHour = 21;
    cycleMs =
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - 1, cycleHour) -
      KST_OFFSET_MS;
  } else {
    cycleMs =
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), cycleHour) -
      KST_OFFSET_MS;
  }
  return Array.from({ length: count }, (_, index) =>
    formatKstTm(cycleMs - index * 6 * 60 * 60 * 1000),
  );
};

const fetchLatestCycleHeader = async (context, baseTime) => {
  const authKey = readAuthKey(context.env);
  if (!authKey) throw new Error('방송모드 기상청 인증키가 설정되지 않았습니다.');
  const query = new URLSearchParams({
    model: 'kim',
    nwp: 'l010',
    sub: 'unis',
    tmfc: formatUtcCycle(baseTime),
    ef: String(MAX_LEAD_HOUR),
    help: '0',
    authKey,
  });
  const response = await fetch(`${KIM_HEADER_URL}?${query}`, {
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (response.status === 403) throw new Error('KIM 전체영역 API 활용 권한이 없습니다.');
  if (!response.ok) throw new Error(`KIM 헤더 요청 실패 (${response.status})`);
  if (!text.includes('#file =') || !/\bAPCP\b/.test(text)) {
    throw new KimNoDataError();
  }
};

const parseFullGridBinary = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const newlineIndex = bytes.indexOf(10);
  if (newlineIndex < 0 || newlineIndex + 9 > bytes.length) {
    throw new Error('KIM 국지모델 바이너리 헤더가 올바르지 않습니다.');
  }
  const headerOffset = newlineIndex + 1;
  const view = new DataView(buffer, headerOffset);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const dataOffset = headerOffset + 8;
  if (
    width !== SOURCE_GRID.width ||
    height !== SOURCE_GRID.height ||
    dataOffset + width * height * 4 > buffer.byteLength
  ) {
    throw new Error(`KIM 국지모델 격자 크기가 올바르지 않습니다. (${width}x${height})`);
  }
  return {
    ...SOURCE_GRID,
    values: new Float32Array(buffer, dataOffset, width * height),
  };
};

const fetchKimCumulative = async (context, baseTime, leadHour) => {
  const edgeCache = getEdgeCache();
  const key = cacheKey(context.request.url, `raw-local-full/${baseTime}/${leadHour}`);
  const cached = edgeCache ? await edgeCache.match(key) : null;
  if (cached) return parseFullGridBinary(await cached.arrayBuffer());

  const authKey = readAuthKey(context.env);
  if (!authKey) throw new Error('방송모드 기상청 인증키가 설정되지 않았습니다.');
  const query = new URLSearchParams({
    nwp: 'l010',
    sub: 'unis',
    vars: 'apcp',
    tmfc: formatUtcCycle(baseTime),
    ef: String(leadHour),
    dataType: 'BIN',
    authKey,
  });
  const response = await fetch(`${KIM_DOWNLOAD_URL}?${query}`, {
    signal: AbortSignal.timeout(40000),
  });
  if (response.status === 403) throw new Error('KIM 국지모델 API 활용 권한이 없습니다.');
  if (!response.ok) throw new Error(`KIM 국지모델 요청 실패 (${response.status})`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 1000) {
    throw new KimNoDataError(new TextDecoder().decode(buffer).trim());
  }
  const parsed = parseFullGridBinary(buffer);
  putCache(
    context,
    key,
    new Response(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=${FRAME_CACHE_SECONDS}`,
      },
    }),
  );
  return parsed;
};

const isValidRainValue = (value) => Number.isFinite(value) && value > -100;

const isCumulativePair = (currentValues, previousValues) => {
  let comparable = 0;
  let nonDecreasing = 0;
  const stride = Math.max(1, Math.floor(currentValues.length / 12000));
  for (let index = 0; index < currentValues.length; index += stride) {
    const current = currentValues[index];
    const previous = previousValues[index];
    if (!isValidRainValue(current) || !isValidRainValue(previous)) continue;
    comparable += 1;
    if (current + 0.01 >= previous) nonDecreasing += 1;
  }
  return comparable > 0 && nonDecreasing / comparable >= 0.97;
};

const smoothGrid = (source, width, height, passes) => {
  const kernel = [1, 4, 6, 4, 1];
  let current = source;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let weightSum = 0;
        for (let offset = -2; offset <= 2; offset += 1) {
          const sampleX = x + offset;
          if (sampleX < 0 || sampleX >= width) continue;
          const weight = kernel[offset + 2];
          sum += current[y * width + sampleX] * weight;
          weightSum += weight;
        }
        horizontal[y * width + x] = sum / weightSum;
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let weightSum = 0;
        for (let offset = -2; offset <= 2; offset += 1) {
          const sampleY = y + offset;
          if (sampleY < 0 || sampleY >= height) continue;
          const weight = kernel[offset + 2];
          sum += horizontal[sampleY * width + x] * weight;
          weightSum += weight;
        }
        output[y * width + x] = sum / weightSum;
      }
    }
    current = output;
  }
  return current;
};

const buildHourlyGrid = (currentGrid, previousGrid) => {
  if (
    currentGrid.width !== previousGrid.width ||
    currentGrid.height !== previousGrid.height
  ) {
    throw new Error('KIM 직전·현재 격자 크기가 일치하지 않습니다.');
  }
  const outputWidth = Math.floor(currentGrid.width / DOWNSAMPLE);
  const outputHeight = Math.floor(currentGrid.height / DOWNSAMPLE);
  const outputGridKm = currentGrid.gridKm * DOWNSAMPLE;
  const centerShift = (DOWNSAMPLE - 1) / 2;
  const outputOriginX = (currentGrid.originX - centerShift) / DOWNSAMPLE;
  const outputOriginY = (currentGrid.originY - centerShift) / DOWNSAMPLE;
  const cumulative = isCumulativePair(currentGrid.values, previousGrid.values);
  const downsampled = new Float32Array(outputWidth * outputHeight);
  for (let outY = 0; outY < outputHeight; outY += 1) {
    for (let outX = 0; outX < outputWidth; outX += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < DOWNSAMPLE; dy += 1) {
        for (let dx = 0; dx < DOWNSAMPLE; dx += 1) {
          const index =
            (outY * DOWNSAMPLE + dy) * currentGrid.width + outX * DOWNSAMPLE + dx;
          const current = currentGrid.values[index];
          const previous = previousGrid.values[index];
          if (!isValidRainValue(current) || (cumulative && !isValidRainValue(previous))) {
            continue;
          }
          const hourly = cumulative
            ? Math.max(0, current - previous)
            : Math.max(0, current);
          sum += hourly;
          count += 1;
        }
      }
      downsampled[outY * outputWidth + outX] = count > 0 ? sum / count : 0;
    }
  }

  const smoothed = smoothGrid(
    downsampled,
    outputWidth,
    outputHeight,
    SMOOTHING_PASSES,
  );
  const encoded = new Uint16Array(smoothed.length);
  for (let index = 0; index < smoothed.length; index += 1) {
    encoded[index] = Math.min(65535, Math.round(Math.max(0, smoothed[index]) * 100));
  }
  return {
    values: encoded,
    cumulative,
    width: outputWidth,
    height: outputHeight,
    gridKm: outputGridKm,
    originX: outputOriginX,
    originY: outputOriginY,
  };
};

const buildHourlyFrame = async (
  context,
  baseTime,
  leadHour,
  previousGrid = null,
  currentGrid = null,
) => {
  const [resolvedCurrent, resolvedPrevious] =
    currentGrid && previousGrid
      ? [currentGrid, previousGrid]
      : await Promise.all([
          fetchKimCumulative(context, baseTime, leadHour),
          fetchKimCumulative(context, baseTime, leadHour - 1),
        ]);
  const grid = buildHourlyGrid(resolvedCurrent, resolvedPrevious);
  const baseMs = parseKstTm(baseTime);
  return {
    ...grid,
    baseTime,
    leadHour,
    validTime: formatKstTm(baseMs + leadHour * 60 * 60 * 1000),
  };
};

const buildFrameHeaders = (frame, dataSource) => ({
  ...corsHeaders,
  'Content-Type': 'application/octet-stream',
  'Cache-Control': `public, max-age=3600, s-maxage=${FRAME_CACHE_SECONDS}`,
  'X-Kim-Base-Time': frame.baseTime,
  'X-Kim-Valid-Time': frame.validTime,
  'X-Kim-Lead-Hour': String(frame.leadHour),
  'X-Kim-Width': String(frame.width),
  'X-Kim-Height': String(frame.height),
  'X-Kim-Origin-X': String(frame.originX),
  'X-Kim-Origin-Y': String(frame.originY),
  'X-Kim-Grid-Km': String(frame.gridKm),
  'X-Kim-Unit': 'mm/h',
  'X-Kim-Conversion': frame.cumulative ? 'cumulative-difference' : 'direct-hourly',
  'X-Kim-Encoding': 'uint16-centimm-le',
  'X-Kim-Domain': 'local-korea',
  'X-Kim-Data-Source': dataSource,
});

const frameToCustomMetadata = (frame) => ({
  baseTime: frame.baseTime,
  validTime: frame.validTime,
  leadHour: String(frame.leadHour),
  width: String(frame.width),
  height: String(frame.height),
  originX: String(frame.originX),
  originY: String(frame.originY),
  gridKm: String(frame.gridKm),
  cumulative: frame.cumulative ? '1' : '0',
});

const customMetadataToFrame = (metadata = {}) => ({
  baseTime: metadata.baseTime ?? '',
  validTime: metadata.validTime ?? '',
  leadHour: Number(metadata.leadHour),
  width: Number(metadata.width),
  height: Number(metadata.height),
  originX: Number(metadata.originX),
  originY: Number(metadata.originY),
  gridKm: Number(metadata.gridKm),
  cumulative: metadata.cumulative === '1',
});

const buildLatestMeta = async (context) => {
  for (const baseTime of buildRecentCycleTimes()) {
    try {
      await fetchLatestCycleHeader(context, baseTime);
      const baseMs = parseKstTm(baseTime);
      return {
        baseTime,
        gridKm: SOURCE_GRID.gridKm * DOWNSAMPLE,
        width: Math.floor(SOURCE_GRID.width / DOWNSAMPLE),
        height: Math.floor(SOURCE_GRID.height / DOWNSAMPLE),
        originX: (SOURCE_GRID.originX - (DOWNSAMPLE - 1) / 2) / DOWNSAMPLE,
        originY: (SOURCE_GRID.originY - (DOWNSAMPLE - 1) / 2) / DOWNSAMPLE,
        bounds: LOCAL_KOREA_BOUNDS,
        sourceGridKm: SOURCE_GRID.gridKm,
        sourceWidth: SOURCE_GRID.width,
        sourceHeight: SOURCE_GRID.height,
        sourceUnit: 'kg/m^2',
        unit: 'mm/h',
        encoding: 'uint16-centimm-le',
        domain: 'local-korea',
        smoothingPasses: SMOOTHING_PASSES,
        accumulation: 'cumulative difference',
        maxLeadHour: MAX_LEAD_HOUR,
        frames: Array.from({ length: MAX_LEAD_HOUR }, (_, index) => {
          const leadHour = index + 1;
          return {
            leadHour,
            validTime: formatKstTm(baseMs + leadHour * 60 * 60 * 1000),
          };
        }),
      };
    } catch (error) {
      if (!(error instanceof KimNoDataError)) throw error;
    }
  }
  throw new KimNoDataError('최근 완성된 KIM 국지 48시간 예측 주기를 찾지 못했습니다.');
};

const readStoredKimMeta = async (env) => {
  const bucket = getKimBucket(env);
  if (!bucket) return null;
  if (isKvStorage(bucket)) return bucket.get(kimMetaR2Key(), 'json');
  const object = await bucket.get(kimMetaR2Key());
  if (!object) return null;
  try {
    return await object.json();
  } catch {
    return null;
  }
};

const writeStoredKimMeta = async (env, meta) => {
  const bucket = getKimBucket(env);
  if (!bucket) return;
  if (isKvStorage(bucket)) {
    await bucket.put(kimMetaR2Key(), JSON.stringify(meta));
    return;
  }
  await bucket.put(kimMetaR2Key(), JSON.stringify(meta), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=60',
    },
    customMetadata: {
      baseTime: meta.baseTime,
      generatedAt: meta.generatedAt ?? new Date().toISOString(),
    },
  });
};

const readStoredKimFrame = async (env, baseTime, leadHour) => {
  const bucket = getKimBucket(env);
  if (!bucket) return null;
  if (isKvStorage(bucket)) {
    const { value, metadata } = await bucket.getWithMetadata(
      kimFrameR2Key(baseTime, leadHour),
      'arrayBuffer',
    );
    if (!value) return null;
    const frame = customMetadataToFrame(metadata);
    if (!frame.width || !frame.height || !frame.validTime) return null;
    return new Response(value, {
      headers: buildFrameHeaders(frame, 'kv'),
    });
  }
  const object = await bucket.get(kimFrameR2Key(baseTime, leadHour));
  if (!object) return null;
  const frame = customMetadataToFrame(object.customMetadata);
  if (!frame.width || !frame.height || !frame.validTime) return null;
  return new Response(object.body, {
    headers: buildFrameHeaders(frame, 'r2'),
  });
};

const writeStoredKimFrame = async (env, frame) => {
  const bucket = getKimBucket(env);
  if (!bucket) return;
  if (isKvStorage(bucket)) {
    await bucket.put(kimFrameR2Key(frame.baseTime, frame.leadHour), frame.values.buffer, {
      metadata: frameToCustomMetadata(frame),
    });
    return;
  }
  await bucket.put(kimFrameR2Key(frame.baseTime, frame.leadHour), frame.values.buffer, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      cacheControl: `public, max-age=${FRAME_CACHE_SECONDS}`,
    },
    customMetadata: frameToCustomMetadata(frame),
  });
};

const listStoredLeadHours = async (env, baseTime) => {
  const bucket = getKimBucket(env);
  if (!bucket) return [];
  const prefix = kimFrameR2Prefix(baseTime);
  const result = await bucket.list({ prefix, limit: MAX_LEAD_HOUR + 1 });
  const keys = isKvStorage(bucket)
    ? result.keys.map((key) => key.name)
    : result.objects.map((object) => object.key);
  return keys
    .map((key) => Number(key.slice(prefix.length).replace(/\.bin$/, '')))
    .filter((leadHour) => Number.isInteger(leadHour) && leadHour >= 1)
    .sort((left, right) => left - right);
};

const pruneStoredKimCycles = async (env, retainedCycles = DEFAULT_RETAINED_CYCLES) => {
  const bucket = getKimBucket(env);
  if (!bucket) return [];
  const prefix = kimFrameR2Prefix();
  const result = await bucket.list({ prefix, limit: 1000 });
  const objectKeys = isKvStorage(bucket)
    ? result.keys.map((key) => key.name)
    : result.objects.map((object) => object.key);
  const cycles = [
    ...new Set(
      objectKeys
        .map((key) => key.slice(prefix.length).split('/')[0])
        .filter((value) => /^\d{12}$/.test(value)),
    ),
  ].sort().reverse();
  const expiredCycles = cycles.slice(Math.max(1, retainedCycles));
  if (expiredCycles.length === 0) return [];
  const keys = objectKeys.filter((key) =>
    expiredCycles.some((cycle) => key.startsWith(`${prefix}${cycle}/`)),
  );
  if (keys.length > 0) {
    if (isKvStorage(bucket)) await Promise.all(keys.map((key) => bucket.delete(key)));
    else await bucket.delete(keys);
  }
  return expiredCycles;
};

const normalizeBatchSize = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_PRECOMPUTE_BATCH_SIZE;
  return Math.min(12, Math.max(1, parsed));
};

export const precomputeLatestKimRain = async (
  env,
  {
    request = new Request('https://weathernow.local/kim-precompute'),
    waitUntil,
    batchSize = env?.KIM_PRECOMPUTE_BATCH_SIZE,
    force = false,
    nowMs = Date.now(),
  } = {},
) => {
  const bucket = getKimBucket(env);
  if (!bucket) throw new Error('KIM_RAIN_CACHE storage binding is required.');
  const backgroundTasks = [];
  const context = {
    env,
    request,
    waitUntil: (task) => {
      if (typeof waitUntil === 'function') waitUntil(task);
      else backgroundTasks.push(Promise.resolve(task).catch(() => {}));
    },
  };
  const previousMeta = await readStoredKimMeta(env);
  const latestMeta = await buildLatestMeta(context);
  const existingLeadHours = await listStoredLeadHours(env, latestMeta.baseTime);
  const existingSet = new Set(existingLeadHours);
  const futureFrames = latestMeta.frames.filter(
    (frame) => (parseKstTm(frame.validTime) ?? 0) >= nowMs,
  );
  const pendingFrames = futureFrames
    .filter((frame) => force || !existingSet.has(frame.leadHour))
    .slice(0, normalizeBatchSize(batchSize));
  const results = [];
  let reusableGrid = null;
  let reusableLeadHour = null;

  for (const frameDefinition of pendingFrames) {
    try {
      let previousGrid;
      let currentGrid;
      if (reusableGrid && reusableLeadHour === frameDefinition.leadHour - 1) {
        previousGrid = reusableGrid;
        currentGrid = await fetchKimCumulative(
          context,
          latestMeta.baseTime,
          frameDefinition.leadHour,
        );
      } else {
        [currentGrid, previousGrid] = await Promise.all([
          fetchKimCumulative(context, latestMeta.baseTime, frameDefinition.leadHour),
          fetchKimCumulative(context, latestMeta.baseTime, frameDefinition.leadHour - 1),
        ]);
      }
      const frame = await buildHourlyFrame(
        context,
        latestMeta.baseTime,
        frameDefinition.leadHour,
        previousGrid,
        currentGrid,
      );
      await writeStoredKimFrame(env, frame);
      existingSet.add(frameDefinition.leadHour);
      reusableGrid = currentGrid;
      reusableLeadHour = frameDefinition.leadHour;
      results.push({ leadHour: frameDefinition.leadHour, ok: true });
    } catch (error) {
      reusableGrid = null;
      reusableLeadHour = null;
      results.push({
        leadHour: frameDefinition.leadHour,
        ok: false,
        error: error.message,
      });
    }
  }

  const precomputedLeadHours = [...existingSet].sort((left, right) => left - right);
  const precomputedFutureCount = futureFrames.filter((frame) =>
    existingSet.has(frame.leadHour),
  ).length;
  const storedMeta = {
    ...latestMeta,
    generatedAt: new Date().toISOString(),
    storage: getKimStorageKind(env),
    precomputedLeadHours,
  };
  await writeStoredKimMeta(env, storedMeta);
  let prunedCycles = [];
  if (previousMeta?.baseTime !== latestMeta.baseTime) {
    prunedCycles = await pruneStoredKimCycles(
      env,
      Number(env?.KIM_RETAINED_CYCLES) || DEFAULT_RETAINED_CYCLES,
    );
  }
  if (backgroundTasks.length > 0) await Promise.allSettled(backgroundTasks);

  return {
    generatedAt: storedMeta.generatedAt,
    baseTime: latestMeta.baseTime,
    futureFrameCount: futureFrames.length,
    precomputedFrameCount: precomputedLeadHours.length,
    remainingFrameCount: Math.max(0, futureFrames.length - precomputedFutureCount),
    results,
    prunedCycles,
  };
};

export const readKimPrecomputeStatus = async (env) => {
  const meta = await readStoredKimMeta(env);
  if (!meta) {
    return {
      checkedAt: new Date().toISOString(),
      ready: false,
      precomputedFrameCount: 0,
    };
  }
  const leadHours = await listStoredLeadHours(env, meta.baseTime);
  return {
    checkedAt: new Date().toISOString(),
    ready: true,
    baseTime: meta.baseTime,
    generatedAt: meta.generatedAt ?? '',
    precomputedFrameCount: leadHours.length,
    precomputedLeadHours: leadHours,
  };
};

export const onRequestOptions = async () =>
  new Response(null, { status: 204, headers: corsHeaders });

export const onRequestGet = async (context) => {
  const url = new URL(context.request.url);
  try {
    if (url.searchParams.get('meta') === 'latest') {
      const refresh = url.searchParams.get('_refresh') === '1';
      let storedMeta = null;
      if (!refresh) {
        storedMeta = await readStoredKimMeta(context.env);
        if (storedMeta && isStoredMetaFresh(storedMeta)) {
          return jsonResponse(
            storedMeta,
            200,
            `public, max-age=60, s-maxage=${COMPLETE_CYCLE_CACHE_SECONDS}`,
            { 'X-Kim-Data-Source': getKimStorageKind(context.env) },
          );
        }
      }
      const edgeCache = getEdgeCache();
      const key = cacheKey(context.request.url, 'meta/latest');
      if (!refresh && edgeCache) {
        const cached = await edgeCache.match(key);
        if (cached) return cached;
      }
      let liveMeta;
      try {
        const latestMeta = await buildLatestMeta(context);
        liveMeta = {
          ...latestMeta,
          generatedAt: new Date().toISOString(),
          storage: getKimStorageKind(context.env) || undefined,
          precomputedLeadHours:
            storedMeta?.baseTime === latestMeta.baseTime
              ? storedMeta.precomputedLeadHours ?? []
              : [],
        };
      } catch (error) {
        if (!storedMeta) throw error;
        return jsonResponse(
          storedMeta,
          200,
          'public, max-age=60, s-maxage=300',
          { 'X-Kim-Data-Source': `stale-${getKimStorageKind(context.env)}` },
        );
      }
      const response = jsonResponse(
        liveMeta,
        200,
        `public, max-age=60, s-maxage=${COMPLETE_CYCLE_CACHE_SECONDS}`,
        { 'X-Kim-Data-Source': 'live' },
      );
      putCache(context, key, response);
      if (getKimBucket(context.env)) {
        const writeTask = writeStoredKimMeta(context.env, liveMeta);
        if (typeof context.waitUntil === 'function') context.waitUntil(writeTask);
        else await writeTask;
      }
      return response;
    }

    const baseTime = url.searchParams.get('baseTime');
    const leadHour = Number(url.searchParams.get('leadHour'));
    if (
      !/^\d{12}$/.test(baseTime ?? '') ||
      !Number.isInteger(leadHour) ||
      leadHour < 1 ||
      leadHour > MAX_LEAD_HOUR
    ) {
      return jsonResponse({ error: 'baseTime과 1~48 범위의 leadHour가 필요합니다.' }, 400);
    }

    const refresh = url.searchParams.get('_refresh') === '1';
    if (!refresh) {
      const storedFrame = await readStoredKimFrame(context.env, baseTime, leadHour);
      if (storedFrame) return storedFrame;
    }
    const edgeCache = getEdgeCache();
    const key = cacheKey(context.request.url, `hourly-local-full-smooth/${baseTime}/${leadHour}`);
    if (!refresh && edgeCache) {
      const cached = await edgeCache.match(key);
      if (cached) return cached;
    }

    const frame = await buildHourlyFrame(context, baseTime, leadHour);
    const response = new Response(frame.values.buffer, {
      headers: buildFrameHeaders(frame, 'live'),
    });
    putCache(context, key, response);
    if (getKimBucket(context.env)) {
      const writeTask = writeStoredKimFrame(context.env, frame);
      if (typeof context.waitUntil === 'function') context.waitUntil(writeTask);
      else await writeTask;
    }
    return response;
  } catch (error) {
    const status = error instanceof KimNoDataError ? 404 : 502;
    return jsonResponse({ error: error.message || 'KIM 강수 예측 자료 요청에 실패했습니다.' }, status);
  }
};
