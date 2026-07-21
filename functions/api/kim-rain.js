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
  ].join(','),
};

const KIM_HEADER_URL = 'https://apihub.kma.go.kr/api/typ06/cgi-bin/url/nph-nwp_header';
const KIM_LDAPS_URL =
  'https://apihub.kma.go.kr/api/typ02/openApi/KIMModelInfoService/getKIMLdapsUnisAll';
const MAX_LEAD_HOUR = 48;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const COMPLETE_CYCLE_CACHE_SECONDS = 5 * 60;
const FRAME_CACHE_SECONDS = 7 * 24 * 60 * 60;
const DOWNSAMPLE = 1;
const SMOOTHING_PASSES = 1;
const LOCAL_KOREA_BOUNDS = {
  lonMin: 124.5,
  lonMax: 132.1,
  latMin: 31.75,
  latMax: 39.2,
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

const cacheKey = (requestUrl, suffix) => {
  const url = new URL(requestUrl);
  return new Request(`${url.origin}/__kim-rain-cache/v6/${suffix}`);
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

const parseCachedKimGrid = async (response) => {
  const width = Number(response.headers.get('X-Kim-Width'));
  const height = Number(response.headers.get('X-Kim-Height'));
  const buffer = await response.arrayBuffer();
  const values = new Uint16Array(buffer);
  if (!width || !height || values.length !== width * height) {
    throw new Error('KIM 국지모델 캐시 격자 크기가 올바르지 않습니다.');
  }
  return {
    width,
    height,
    gridKm: Number(response.headers.get('X-Kim-Grid-Km')),
    originX: Number(response.headers.get('X-Kim-Origin-X')),
    originY: Number(response.headers.get('X-Kim-Origin-Y')),
    validTime: response.headers.get('X-Kim-Valid-Time'),
    values,
  };
};

const encodeCumulativeValues = (valueText, expectedLength) => {
  const source = String(valueText ?? '').split(',');
  if (source.length !== expectedLength) {
    throw new Error(
      `KIM 국지모델 강수 격자 개수가 올바르지 않습니다. (${source.length}/${expectedLength})`,
    );
  }
  const encoded = new Uint16Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const value = Number(source[index]);
    encoded[index] =
      Number.isFinite(value) && value >= 0
        ? Math.min(65534, Math.round(value * 10))
        : 65535;
  }
  return encoded;
};

const fetchKimCumulative = async (context, baseTime, leadHour) => {
  const edgeCache = getEdgeCache();
  const key = cacheKey(context.request.url, `raw-local/${baseTime}/${leadHour}`);
  const cached = edgeCache ? await edgeCache.match(key) : null;
  if (cached) return parseCachedKimGrid(cached);

  const authKey = readAuthKey(context.env);
  if (!authKey) throw new Error('방송모드 기상청 인증키가 설정되지 않았습니다.');
  const query = new URLSearchParams({
    baseTime,
    leadHour: String(leadHour),
    dataTypeCd: 'Rain',
    dataType: 'JSON',
    authKey,
  });
  const response = await fetch(`${KIM_LDAPS_URL}?${query}`, {
    signal: AbortSignal.timeout(40000),
  });
  if (response.status === 403) throw new Error('KIM 국지모델 API 활용 권한이 없습니다.');
  if (!response.ok) throw new Error(`KIM 국지모델 요청 실패 (${response.status})`);
  const payload = await response.json();
  const resultCode = payload?.response?.header?.resultCode;
  if (resultCode !== '00') {
    throw new KimNoDataError(
      payload?.response?.header?.resultMsg || 'KIM 국지모델 자료가 아직 생산되지 않았습니다.',
    );
  }
  const items = payload?.response?.body?.items?.item;
  const item = Array.isArray(items) ? items[0] : items;
  const width = Number(item?.xdim);
  const height = Number(item?.ydim);
  const gridKm = Number(item?.gridKm);
  const originX = Number(item?.x0);
  const originY = Number(item?.y0);
  if (!width || !height || !gridKm || !Number.isFinite(originX) || !Number.isFinite(originY)) {
    throw new Error('KIM 국지모델 격자 메타데이터가 올바르지 않습니다.');
  }
  const values = encodeCumulativeValues(item.value, width * height);
  const parsed = {
    width,
    height,
    gridKm,
    originX,
    originY,
    validTime: item.fcstTime,
    values,
  };
  putCache(
    context,
    key,
    new Response(values.buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=${FRAME_CACHE_SECONDS}`,
        'X-Kim-Width': String(width),
        'X-Kim-Height': String(height),
        'X-Kim-Grid-Km': String(gridKm),
        'X-Kim-Origin-X': String(originX),
        'X-Kim-Origin-Y': String(originY),
        'X-Kim-Valid-Time': item.fcstTime,
      },
    }),
  );
  return parsed;
};

const isValidRainValue = (value) => value !== 65535;

const isCumulativePair = (currentValues, previousValues) => {
  let comparable = 0;
  let nonDecreasing = 0;
  const stride = Math.max(1, Math.floor(currentValues.length / 12000));
  for (let index = 0; index < currentValues.length; index += stride) {
    const current = currentValues[index];
    const previous = previousValues[index];
    if (!isValidRainValue(current) || !isValidRainValue(previous)) continue;
    comparable += 1;
    if (current + 1 >= previous) nonDecreasing += 1;
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
          if (!isValidRainValue(current)) continue;
          const hourly =
            cumulative && isValidRainValue(previous)
              ? Math.max(0, current - previous) / 10
              : Math.max(0, current) / 10;
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

const buildLatestMeta = async (context) => {
  for (const baseTime of buildRecentCycleTimes()) {
    try {
      await fetchLatestCycleHeader(context, baseTime);
      const sourceGrid = await fetchKimCumulative(context, baseTime, 0);
      const baseMs = parseKstTm(baseTime);
      return {
        baseTime,
        gridKm: sourceGrid.gridKm * DOWNSAMPLE,
        width: Math.floor(sourceGrid.width / DOWNSAMPLE),
        height: Math.floor(sourceGrid.height / DOWNSAMPLE),
        originX: (sourceGrid.originX - (DOWNSAMPLE - 1) / 2) / DOWNSAMPLE,
        originY: (sourceGrid.originY - (DOWNSAMPLE - 1) / 2) / DOWNSAMPLE,
        bounds: LOCAL_KOREA_BOUNDS,
        sourceGridKm: sourceGrid.gridKm,
        sourceWidth: sourceGrid.width,
        sourceHeight: sourceGrid.height,
        sourceUnit: 'mm',
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

export const onRequestOptions = async () =>
  new Response(null, { status: 204, headers: corsHeaders });

export const onRequestGet = async (context) => {
  const url = new URL(context.request.url);
  try {
    if (url.searchParams.get('meta') === 'latest') {
      const refresh = url.searchParams.get('_refresh') === '1';
      const edgeCache = getEdgeCache();
      const key = cacheKey(context.request.url, 'meta/latest');
      if (!refresh && edgeCache) {
        const cached = await edgeCache.match(key);
        if (cached) return cached;
      }
      const response = jsonResponse(
        await buildLatestMeta(context),
        200,
        `public, max-age=60, s-maxage=${COMPLETE_CYCLE_CACHE_SECONDS}`,
      );
      putCache(context, key, response);
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
    const edgeCache = getEdgeCache();
    const key = cacheKey(context.request.url, `hourly-local-smooth/${baseTime}/${leadHour}`);
    if (!refresh && edgeCache) {
      const cached = await edgeCache.match(key);
      if (cached) return cached;
    }

    const [currentGrid, previousGrid] = await Promise.all([
      fetchKimCumulative(context, baseTime, leadHour),
      fetchKimCumulative(context, baseTime, leadHour - 1),
    ]);
    const { values, cumulative, width, height, originX, originY, gridKm } = buildHourlyGrid(
      currentGrid,
      previousGrid,
    );
    const baseMs = parseKstTm(baseTime);
    const response = new Response(values.buffer, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=3600, s-maxage=${FRAME_CACHE_SECONDS}`,
        'X-Kim-Base-Time': baseTime,
        'X-Kim-Valid-Time': currentGrid.validTime || formatKstTm(baseMs + leadHour * 60 * 60 * 1000),
        'X-Kim-Lead-Hour': String(leadHour),
        'X-Kim-Width': String(width),
        'X-Kim-Height': String(height),
        'X-Kim-Origin-X': String(originX),
        'X-Kim-Origin-Y': String(originY),
        'X-Kim-Grid-Km': String(gridKm),
        'X-Kim-Unit': 'mm/h',
        'X-Kim-Conversion': cumulative ? 'cumulative-difference' : 'direct-hourly',
        'X-Kim-Encoding': 'uint16-centimm-le',
        'X-Kim-Domain': 'local-korea',
      },
    });
    putCache(context, key, response);
    return response;
  } catch (error) {
    const status = error instanceof KimNoDataError ? 404 : 502;
    return jsonResponse({ error: error.message || 'KIM 강수 예측 자료 요청에 실패했습니다.' }, status);
  }
};
