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
  ].join(','),
};

const KIM_API_URL =
  'https://apihub.kma.go.kr/api/typ02/openApi/KIMModelInfoService/getKIMRdapsUnisAll';
const MAX_LEAD_HOUR = 72;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const COMPLETE_CYCLE_CACHE_SECONDS = 5 * 60;
const FRAME_CACHE_SECONDS = 7 * 24 * 60 * 60;
const RAIN_THRESHOLDS = [
  0.1, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 60, 70, 90, 110, 150,
];

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
  return new Request(`${url.origin}/__kim-rain-cache/v2/${suffix}`);
};

const putCache = (context, key, response) => {
  const cache = getEdgeCache();
  if (!cache) return;
  const task = cache.put(key, response.clone());
  if (typeof context.waitUntil === 'function') {
    context.waitUntil(task);
  } else {
    task.catch(() => {});
  }
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
  return Array.from({ length: count }, (_, index) => formatKstTm(cycleMs - index * 6 * 60 * 60 * 1000));
};

const normalizeKimItem = (payload) => {
  const header = payload?.response?.header;
  const resultCode = String(header?.resultCode ?? '');
  if (resultCode !== '00') {
    if (resultCode === '03') {
      throw new KimNoDataError(header?.resultMsg);
    }
    throw new Error(header?.resultMsg || `KIM API 오류 (${resultCode || 'unknown'})`);
  }
  const itemNode = payload?.response?.body?.items?.item;
  const item = Array.isArray(itemNode) ? itemNode[0] : itemNode;
  if (!item?.value) {
    throw new KimNoDataError();
  }
  return item;
};

const fetchKimCumulative = async (context, baseTime, leadHour) => {
  const edgeCache = getEdgeCache();
  const key = cacheKey(context.request.url, `raw/${baseTime}/${leadHour}`);
  const cached = edgeCache ? await edgeCache.match(key) : null;
  if (cached) {
    return normalizeKimItem(await cached.json());
  }

  const authKey = readAuthKey(context.env);
  if (!authKey) {
    throw new Error('방송모드 기상청 인증키가 설정되지 않았습니다.');
  }

  const query = new URLSearchParams({
    baseTime,
    leadHour: String(leadHour),
    dataTypeCd: 'Rain',
    dataType: 'JSON',
    authKey,
  });
  const response = await fetch(`${KIM_API_URL}?${query}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`KIM API 요청 실패 (${response.status})`);
  }
  const payload = await response.json();
  const item = normalizeKimItem(payload);
  const cachedResponse = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${FRAME_CACHE_SECONDS}`,
    },
  });
  putCache(context, key, cachedResponse);
  return item;
};

const parseGridValues = (item) => {
  const width = Number(item.xdim);
  const height = Number(item.ydim);
  const values = String(item.value).split(',');
  if (!Number.isInteger(width) || !Number.isInteger(height) || values.length !== width * height) {
    throw new Error('KIM 격자 크기와 자료 개수가 일치하지 않습니다.');
  }
  return { width, height, values };
};

const isValidRainValue = (value) => Number.isFinite(value) && value > -100;

const isCumulativePair = (currentValues, previousValues) => {
  let comparable = 0;
  let nonDecreasing = 0;
  const stride = Math.max(1, Math.floor(currentValues.length / 12000));
  for (let index = 0; index < currentValues.length; index += stride) {
    const current = Number(currentValues[index]);
    const previous = Number(previousValues[index]);
    if (!isValidRainValue(current) || !isValidRainValue(previous)) continue;
    comparable += 1;
    if (current + 0.05 >= previous) nonDecreasing += 1;
  }
  return comparable > 0 && nonDecreasing / comparable >= 0.97;
};

const rainBucket = (mmPerHour) => {
  let bucket = 0;
  for (let index = 0; index < RAIN_THRESHOLDS.length; index += 1) {
    if (mmPerHour < RAIN_THRESHOLDS[index]) break;
    bucket = index + 1;
  }
  return bucket;
};

const buildHourlyBuckets = (currentItem, previousItem) => {
  const currentGrid = parseGridValues(currentItem);
  const previousGrid = parseGridValues(previousItem);
  if (currentGrid.width !== previousGrid.width || currentGrid.height !== previousGrid.height) {
    throw new Error('KIM 직전·현재 격자 크기가 일치하지 않습니다.');
  }

  const cumulative = isCumulativePair(currentGrid.values, previousGrid.values);
  const buckets = new Uint8Array(currentGrid.values.length);
  for (let index = 0; index < currentGrid.values.length; index += 1) {
    const current = Number(currentGrid.values[index]);
    const previous = Number(previousGrid.values[index]);
    if (!isValidRainValue(current)) continue;
    const hourly = cumulative && isValidRainValue(previous) ? Math.max(0, current - previous) : Math.max(0, current);
    buckets[index] = rainBucket(Math.round(hourly * 10) / 10);
  }
  return { ...currentGrid, buckets, cumulative };
};

const buildLatestMeta = async (context) => {
  for (const baseTime of buildRecentCycleTimes()) {
    try {
      const item = await fetchKimCumulative(context, baseTime, MAX_LEAD_HOUR);
      const baseMs = parseKstTm(baseTime);
      const frames = Array.from({ length: MAX_LEAD_HOUR }, (_, index) => {
        const leadHour = index + 1;
        return { leadHour, validTime: formatKstTm(baseMs + leadHour * 60 * 60 * 1000) };
      });
      return {
        baseTime,
        gridKm: Number(item.gridKm),
        width: Number(item.xdim),
        height: Number(item.ydim),
        originX: Number(item.x0),
        originY: Number(item.y0),
        sourceUnit: String(item.unit || 'mm'),
        unit: 'mm/h',
        accumulation: 'auto-detected cumulative difference',
        maxLeadHour: MAX_LEAD_HOUR,
        frames,
      };
    } catch (error) {
      if (!(error instanceof KimNoDataError)) throw error;
    }
  }
  throw new KimNoDataError('최근 완성된 KIM 72시간 강수 예측 주기를 찾지 못했습니다.');
};

export const onRequestOptions = async () => new Response(null, { status: 204, headers: corsHeaders });

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
      const meta = await buildLatestMeta(context);
      const response = jsonResponse(
        meta,
        200,
        `public, max-age=60, s-maxage=${COMPLETE_CYCLE_CACHE_SECONDS}`,
      );
      putCache(context, key, response);
      return response;
    }

    const baseTime = url.searchParams.get('baseTime');
    const leadHour = Number(url.searchParams.get('leadHour'));
    if (!/^\d{12}$/.test(baseTime ?? '') || !Number.isInteger(leadHour) || leadHour < 1 || leadHour > MAX_LEAD_HOUR) {
      return jsonResponse({ error: 'baseTime과 1~72 범위의 leadHour가 필요합니다.' }, 400);
    }

    const refresh = url.searchParams.get('_refresh') === '1';
    const edgeCache = getEdgeCache();
    const key = cacheKey(context.request.url, `hourly/${baseTime}/${leadHour}`);
    if (!refresh && edgeCache) {
      const cached = await edgeCache.match(key);
      if (cached) return cached;
    }

    const [currentItem, previousItem] = await Promise.all([
      fetchKimCumulative(context, baseTime, leadHour),
      fetchKimCumulative(context, baseTime, leadHour - 1),
    ]);
    const { width, height, buckets, cumulative } = buildHourlyBuckets(currentItem, previousItem);
    const response = new Response(buckets, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/octet-stream',
        'Cache-Control': `public, max-age=3600, s-maxage=${FRAME_CACHE_SECONDS}`,
        'X-Kim-Base-Time': baseTime,
        'X-Kim-Valid-Time': String(currentItem.fcstTime || ''),
        'X-Kim-Lead-Hour': String(leadHour),
        'X-Kim-Width': String(width),
        'X-Kim-Height': String(height),
        'X-Kim-Origin-X': String(currentItem.x0),
        'X-Kim-Origin-Y': String(currentItem.y0),
        'X-Kim-Grid-Km': String(currentItem.gridKm),
        'X-Kim-Unit': 'mm/h',
        'X-Kim-Conversion': cumulative ? 'cumulative-difference' : 'direct-hourly',
      },
    });
    putCache(context, key, response);
    return response;
  } catch (error) {
    const status = error instanceof KimNoDataError ? 404 : 502;
    return jsonResponse({ error: error.message || 'KIM 강수 예측 자료 요청에 실패했습니다.' }, status);
  }
};

