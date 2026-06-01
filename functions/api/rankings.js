const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const AWS_MINUTE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15];
const AWS_TEMPERATURE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15, 20, 30];
const AWS_MINUTE_REQUEST_TIMEOUT_MS = 6000;
const SLOW_DAILY_RAIN_TIMEOUT_MS = 30000;
const SLOW_DAILY_TEMPERATURE_TIMEOUT_MS = 20000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PRECOMPUTED_CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const PRECOMPUTED_CACHE_MAX_STALE_AGE_MS = 15 * 60 * 1000;
const SELECTED_TIME_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const SELECTED_TIME_CACHE_MAX_STALE_AGE_MS = 6 * 60 * 60 * 1000;
const PRECOMPUTED_CACHE_API_MAX_AGE_SECONDS = 60 * 60;
const RANKING_CACHE_VERSION = 'v2';
const PRECOMPUTED_REFRESH_IN_FLIGHT = new Map();
const KMA_TEXT_CACHE = new Map();
const KMA_TEXT_IN_FLIGHT = new Map();
const padZero = (value) => value.toString().padStart(2, '0');

export const RANKING_KINDS = [
  'temperature-current',
  'temperature-today',
  'precipitation-current',
  'precipitation-since-yesterday',
];

const getKstNow = () => new Date(Date.now() + KST_OFFSET_MS);

const readAuthKey = (context) =>
  context.env?.KMA_AUTH_KEY ||
  context.env?.VITE_KMA_AUTH_KEY ||
  process.env.KMA_AUTH_KEY ||
  process.env.VITE_KMA_AUTH_KEY ||
  '';

const isPrecomputedCacheDisabled = (context) =>
  ['1', 'true', 'yes', 'live', 'off', 'disabled'].includes(
    String(context.env?.DISABLE_PRECOMPUTED_WEATHER ?? '').toLowerCase(),
  );

const isManualRefreshRequest = (context) => {
  const requestUrl = new URL(context.request.url);
  return requestUrl.searchParams.has('_refresh');
};

const buildCacheApiRequest = (key) =>
  new Request(`https://weathernow-cache.local/${encodeURIComponent(key)}`);

const createCacheApiStore = () => {
  if (typeof caches === 'undefined' || !caches.default) {
    return null;
  }

  return {
    async get(key, type) {
      const response = await caches.default.match(buildCacheApiRequest(key));
      if (!response) {
        return null;
      }

      const value = await response.text();
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      await caches.default.put(
        buildCacheApiRequest(key),
        new Response(value, {
          headers: {
            'Cache-Control': `public, max-age=${PRECOMPUTED_CACHE_API_MAX_AGE_SECONDS}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        }),
      );
    },
  };
};

const getWeatherCache = (context) => context.env?.WEATHER_CACHE ?? createCacheApiStore();

export const getRankingCacheKey = (kind, observedAt = '') =>
  observedAt
    ? `rankings:${RANKING_CACHE_VERSION}:${kind}:tm:${observedAt}`
    : `rankings:${RANKING_CACHE_VERSION}:${kind}`;

const getFreshCacheMaxAgeMs = (observedAt = '') =>
  observedAt ? SELECTED_TIME_CACHE_MAX_AGE_MS : PRECOMPUTED_CACHE_MAX_AGE_MS;

const getStaleCacheMaxAgeMs = (observedAt = '') =>
  observedAt ? SELECTED_TIME_CACHE_MAX_STALE_AGE_MS : PRECOMPUTED_CACHE_MAX_STALE_AGE_MS;

const isFreshCacheRecord = (record, observedAt = '') => {
  if (!record?.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= getFreshCacheMaxAgeMs(observedAt);
};

const isUsableStaleCacheRecord = (record, observedAt = '') => {
  if (!record?.payload || !record.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= getStaleCacheMaxAgeMs(observedAt);
};

const readPrecomputedRankingRecord = async (context, kind, observedAt = '') => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || isPrecomputedCacheDisabled(context)) {
    return null;
  }

  return weatherCache.get(getRankingCacheKey(kind, observedAt), 'json');
};

export const writePrecomputedRanking = async (context, kind, payload, observedAt = '') => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || !payload) {
    return;
  }

  await weatherCache.put(
    getRankingCacheKey(kind, observedAt),
    JSON.stringify({
      kind,
      observedAt,
      generatedAt: new Date().toISOString(),
      payload,
    }),
  );
};

const refreshPrecomputedRanking = async (context, kind, observedAt = '') => {
  const payload = await buildRankingPayload(context, kind, { observedAt });
  await writePrecomputedRanking(context, kind, payload, observedAt);
  return payload;
};

const schedulePrecomputedRankingRefresh = (context, kind, observedAt = '') => {
  if (isPrecomputedCacheDisabled(context) || !getWeatherCache(context)) {
    return null;
  }

  const cacheKey = getRankingCacheKey(kind, observedAt);
  if (PRECOMPUTED_REFRESH_IN_FLIGHT.has(cacheKey)) {
    return PRECOMPUTED_REFRESH_IN_FLIGHT.get(cacheKey);
  }

  const refreshPromise = refreshPrecomputedRanking(context, kind, observedAt)
    .finally(() => {
      PRECOMPUTED_REFRESH_IN_FLIGHT.delete(cacheKey);
    });

  PRECOMPUTED_REFRESH_IN_FLIGHT.set(cacheKey, refreshPromise);

  if (context.waitUntil) {
    context.waitUntil(refreshPromise);
  } else {
    refreshPromise.catch(() => {});
  }

  return refreshPromise;
};

const makeJsonResponse = (payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Cache-Control': 'public, max-age=30, s-maxage=60',
      ...headers,
    },
  });

const formatKmaMinuteTime = (date) => {
  const year = date.getUTCFullYear();
  const month = padZero(date.getUTCMonth() + 1);
  const day = padZero(date.getUTCDate());
  const hour = padZero(date.getUTCHours());
  const minute = padZero(date.getUTCMinutes());
  return `${year}${month}${day}${hour}${minute}`;
};

const formatKmaDay = (date) => formatKmaMinuteTime(date).slice(0, 8);
const formatStationInfoTime = (date) => `${formatKmaMinuteTime(date).slice(0, 10)}00`;
const subtractMinutes = (date, minutes) => new Date(date.getTime() - minutes * 60 * 1000);
const subtractDays = (date, days) => new Date(date.getTime() - days * 24 * 60 * 60 * 1000);

const parseKmaMinuteTime = (timestamp) => {
  if (!/^\d{12}$/.test(timestamp ?? '')) {
    return null;
  }

  const year = Number.parseInt(timestamp.slice(0, 4), 10);
  const month = Number.parseInt(timestamp.slice(4, 6), 10) - 1;
  const day = Number.parseInt(timestamp.slice(6, 8), 10);
  const hour = Number.parseInt(timestamp.slice(8, 10), 10);
  const minute = Number.parseInt(timestamp.slice(10, 12), 10);
  const parsedDate = new Date(Date.UTC(year, month, day, hour, minute));
  return formatKmaMinuteTime(parsedDate) === timestamp ? parsedDate : null;
};

const formatDisplayKoreanDateTime = (timestamp) => {
  if (!timestamp || timestamp.length < 12) {
    return '';
  }

  const year = timestamp.slice(0, 4);
  const month = Number.parseInt(timestamp.slice(4, 6), 10);
  const day = Number.parseInt(timestamp.slice(6, 8), 10);
  const hour = timestamp.slice(8, 10);
  const minute = timestamp.slice(10, 12);
  return `${year}년 ${month}월 ${day}일 ${hour}시 ${minute}분 현재`;
};

const parseNumericValue = (value) => {
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const isFiniteObservation = (value) => Number.isFinite(value) && value > -50;

const buildRankingRows = (items, unit, sortDirection = 'desc') =>
  [...items]
    .sort((left, right) => (sortDirection === 'asc' ? left.value - right.value : right.value - left.value))
    .map((item, index) => ({
      rank: index + 1,
      name: item.name,
      record: `${item.value.toFixed(1)}${unit}`,
      address: item.address,
    }));

const fetchWithTimeout = async (url, options = {}, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP Error Status: ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timerId);
  }
};

const isUnauthorizedError = (error) => error?.message === 'HTTP Error Status: 401';

const buildKmaTextCacheKey = (path, params) => `${path}?${new URLSearchParams(params).toString()}`;

const getCachedKmaText = (cacheKey) => {
  const cached = KMA_TEXT_CACHE.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    KMA_TEXT_CACHE.delete(cacheKey);
    return null;
  }

  return cached.value;
};

const fetchKmaText = async (context, path, params = {}, timeoutMs = 12000, cacheTtl = 60) => {
  const cacheKey = buildKmaTextCacheKey(path, params);
  const forceRefresh = isManualRefreshRequest(context);

  if (!forceRefresh) {
    const cachedText = getCachedKmaText(cacheKey);
    if (cachedText !== null) {
      return cachedText;
    }

    if (KMA_TEXT_IN_FLIGHT.has(cacheKey)) {
      return KMA_TEXT_IN_FLIGHT.get(cacheKey);
    }
  }

  const url = new URL(`https://apihub.kma.go.kr/${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const authKey = readAuthKey(context);
  if (authKey) {
    url.searchParams.set('authKey', authKey);
  }

  const requestOptions = forceRefresh
    ? { cache: 'no-store' }
    : {
        cf: {
          cacheEverything: true,
          cacheTtl,
        },
      };

  const requestPromise = (async () => {
    let response;
    try {
      response = await fetchWithTimeout(url.toString(), requestOptions, timeoutMs);
    } catch (error) {
      if (!authKey || !isUnauthorizedError(error)) {
        throw error;
      }

      url.searchParams.delete('authKey');
      response = await fetchWithTimeout(url.toString(), requestOptions, timeoutMs);
    }

    const buffer = await response.arrayBuffer();
    const decoded = new TextDecoder('euc-kr').decode(buffer);
    KMA_TEXT_CACHE.set(cacheKey, {
      value: decoded,
      expiresAt: Date.now() + cacheTtl * 1000,
    });
    return decoded;
  })()
    .finally(() => {
      KMA_TEXT_IN_FLIGHT.delete(cacheKey);
    });

  if (!forceRefresh) {
    KMA_TEXT_IN_FLIGHT.set(cacheKey, requestPromise);
  }

  return requestPromise;
};

const parseAwsStationMetadata = (rawText) => {
  const stationMetadata = new Map();

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length < 14) {
      return;
    }

    const stationId = fields[0];
    const stationName = fields[8];
    const lawAddress = fields.slice(13).join(' ').replace(/^\d+\s+/, '').trim();
    stationMetadata.set(stationId, {
      name: stationName,
      address: lawAddress || stationName,
    });
  });

  return stationMetadata;
};

const parseAwsMinuteObservations = (rawText, stationMetadata) =>
  rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length >= 18)
    .map((fields) => {
      const stationId = fields[1];
      const metadata = stationMetadata.get(stationId) ?? { name: stationId, address: stationId };
      return {
        stationId,
        name: metadata.name,
        address: metadata.address,
        temperature: parseNumericValue(fields[8]),
        precipitationOneHour: parseNumericValue(fields[11]),
        precipitationToday: parseNumericValue(fields[13]),
      };
    });

const parseAwsDailyObservations = (rawText, stationMetadata) =>
  rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length >= 7)
    .map((fields) => {
      const stationId = fields[1];
      const metadata = stationMetadata.get(stationId) ?? {
        name: fields.slice(6).join(' ').trim() || stationId,
        address: fields.slice(6).join(' ').trim() || stationId,
      };
      return {
        stationId,
        name: metadata.name,
        address: metadata.address,
        value: parseNumericValue(fields[5]),
      };
    });

const hasDailyObservationRows = (rawText) =>
  rawText
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('#') && !trimmed.includes('7777END');
    });

const hasValidAwsTemperatureObservation = (rows) => rows.some((item) => isFiniteObservation(item.temperature));
const hasValidAwsPrecipitationObservation = (rows) =>
  rows.some((item) => item.precipitationOneHour >= 0 || item.precipitationToday >= 0);

const fetchAwsMinuteObservationCandidate = async (context, stationMetadata, candidateTime, validator) => {
  const observedAt = formatKmaMinuteTime(candidateTime);
  const rawText = await fetchKmaText(
    context,
    'api/typ01/cgi-bin/url/nph-aws2_min',
    { tm2: observedAt, stn: 0, disp: 0, help: 0 },
    AWS_MINUTE_REQUEST_TIMEOUT_MS,
    60,
  );
  const rows = parseAwsMinuteObservations(rawText, stationMetadata);
  return validator(rows) ? { observedAt, rows } : null;
};

const fetchAwsMinuteObservationsByTimes = async (context, stationMetadata, candidateTimes, validator) => {
  let lastError = null;

  for (const candidateTime of candidateTimes) {
    try {
      const result = await fetchAwsMinuteObservationCandidate(context, stationMetadata, candidateTime, validator);
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('유효한 AWS 분자료를 찾지 못했습니다.');
};

const fetchAwsMinuteObservationsAtTime = async (context, stationMetadata, observedAt, validator) => {
  const observedDate = parseKmaMinuteTime(observedAt);
  if (!observedDate) {
    throw new Error('Invalid AWS observation time.');
  }

  const result = await fetchAwsMinuteObservationCandidate(context, stationMetadata, observedDate, validator);
  if (!result) {
    throw new Error('선택한 시각의 유효한 AWS 분자료를 찾지 못했습니다.');
  }

  return result;
};

const fetchLatestAwsTemperatureObservations = (context, stationMetadata) => {
  const now = getKstNow();
  const candidateTimes = AWS_TEMPERATURE_LOOKBACK_STEPS.map((offset) => subtractMinutes(now, offset));
  return fetchAwsMinuteObservationsByTimes(context, stationMetadata, candidateTimes, hasValidAwsTemperatureObservation);
};

const fetchLatestAwsPrecipitationObservations = (context, stationMetadata) => {
  const now = getKstNow();
  const candidateTimes = AWS_MINUTE_LOOKBACK_STEPS.map((offset) => subtractMinutes(now, offset));
  return fetchAwsMinuteObservationsByTimes(context, stationMetadata, candidateTimes, hasValidAwsPrecipitationObservation);
};

const getAwsStationMetadata = async (context) => {
  const rawText = await fetchKmaText(
    context,
    'api/typ01/url/stn_inf.php',
    { inf: 'AWS', stn: '', tm: formatStationInfoTime(getKstNow()), help: 1 },
    12000,
    86400,
  );
  return parseAwsStationMetadata(rawText);
};

const buildTemperatureCurrent = async (context, stationMetadata, requestedObservedAt = '') => {
  const { observedAt, rows } = requestedObservedAt
    ? await fetchAwsMinuteObservationsAtTime(
        context,
        stationMetadata,
        requestedObservedAt,
        hasValidAwsTemperatureObservation,
      )
    : await fetchLatestAwsTemperatureObservations(context, stationMetadata);
  return {
    observedAt,
    observedLabel: formatDisplayKoreanDateTime(observedAt),
    minCurrent: buildRankingRows(
      rows.filter((item) => isFiniteObservation(item.temperature)).map((item) => ({
        name: item.name,
        address: item.address,
        value: item.temperature,
      })),
      '°C',
      'asc',
    ),
    maxCurrent: buildRankingRows(
      rows.filter((item) => isFiniteObservation(item.temperature)).map((item) => ({
        name: item.name,
        address: item.address,
        value: item.temperature,
      })),
      '°C',
      'desc',
    ),
  };
};

const buildTemperatureToday = async (context, stationMetadataPromise) => {
  const now = getKstNow();
  const observedDay = formatKmaDay(now);
  const [
    stationMetadata,
    minDailyRaw,
    maxDailyRaw,
  ] = await Promise.all([
    stationMetadataPromise,
    fetchKmaText(
      context,
      'api/typ01/url/sfc_aws_day.php',
      { tm2: observedDay, obs: 'ta_min', stn: 0, disp: 0, help: 1 },
      SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
      300,
    ),
    fetchKmaText(
      context,
      'api/typ01/url/sfc_aws_day.php',
      { tm2: observedDay, obs: 'ta_max', stn: 0, disp: 0, help: 1 },
      SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
      300,
    ),
  ]);

  if (!hasDailyObservationRows(minDailyRaw) && !hasDailyObservationRows(maxDailyRaw)) {
    throw new Error('No valid daily temperature observations were found.');
  }

  const dailyMinRows = parseAwsDailyObservations(minDailyRaw, stationMetadata);
  const dailyMaxRows = parseAwsDailyObservations(maxDailyRaw, stationMetadata);

  return {
    observedAt: formatKmaMinuteTime(now),
    observedLabel: formatDisplayKoreanDateTime(formatKmaMinuteTime(now)),
    minToday: buildRankingRows(
      dailyMinRows.filter((item) => isFiniteObservation(item.value)).map((item) => ({
        name: item.name,
        address: item.address,
        value: item.value,
      })),
      '°C',
      'asc',
    ),
    maxToday: buildRankingRows(
      dailyMaxRows.filter((item) => isFiniteObservation(item.value)).map((item) => ({
        name: item.name,
        address: item.address,
        value: item.value,
      })),
      '°C',
      'desc',
    ),
  };
};

const buildPrecipitationCurrent = async (context, stationMetadata, requestedObservedAt = '') => {
  const { observedAt, rows } = requestedObservedAt
    ? await fetchAwsMinuteObservationsAtTime(
        context,
        stationMetadata,
        requestedObservedAt,
        hasValidAwsPrecipitationObservation,
      )
    : await fetchLatestAwsPrecipitationObservations(context, stationMetadata);
  return {
    observedAt,
    observedLabel: formatDisplayKoreanDateTime(observedAt),
    oneHour: buildRankingRows(
      rows.filter((item) => item.precipitationOneHour > 0).map((item) => ({
        name: item.name,
        address: item.address,
        value: item.precipitationOneHour,
      })),
      'mm',
      'desc',
    ),
    today: buildRankingRows(
      rows.filter((item) => item.precipitationToday > 0).map((item) => ({
        name: item.name,
        address: item.address,
        value: item.precipitationToday,
      })),
      'mm',
      'desc',
    ),
  };
};

const buildPrecipitationSinceYesterday = async (context, stationMetadata, requestedObservedAt = '') => {
  const requestedDate = requestedObservedAt ? parseKmaMinuteTime(requestedObservedAt) : null;
  const baseDate = requestedDate ?? getKstNow();
  const yesterday = subtractDays(baseDate, 1);
  const yesterdayDailyRaw = await fetchKmaText(
    context,
    'api/typ01/url/sfc_aws_day.php',
    { tm2: formatKmaDay(yesterday), obs: 'rn_day', stn: 0, disp: 0, help: 0 },
    SLOW_DAILY_RAIN_TIMEOUT_MS,
    300,
  );

  let observedAt = requestedObservedAt || formatKmaMinuteTime(baseDate);
  let currentRows = [];
  try {
    const latestCurrent = requestedObservedAt
      ? await fetchAwsMinuteObservationsAtTime(
          context,
          stationMetadata,
          requestedObservedAt,
          hasValidAwsPrecipitationObservation,
        )
      : await fetchLatestAwsPrecipitationObservations(context, stationMetadata);
    observedAt = latestCurrent.observedAt;
    currentRows = latestCurrent.rows;
  } catch {
    // Keep yesterday totals even when current minute data is unavailable.
  }

  const yesterdayDailyRows = parseAwsDailyObservations(yesterdayDailyRaw, stationMetadata);
  const yesterdayMap = new Map(yesterdayDailyRows.map((item) => [item.stationId, Math.max(0, item.value)]));
  const currentMap = new Map(currentRows.map((item) => [item.stationId, item]));
  const allStationIds = new Set([
    ...currentRows.map((item) => item.stationId),
    ...yesterdayDailyRows.map((item) => item.stationId),
  ]);

  return {
    observedAt,
    observedLabel: formatDisplayKoreanDateTime(observedAt),
    sinceYesterday: buildRankingRows(
      [...allStationIds]
        .map((stationId) => {
          const currentItem = currentMap.get(stationId);
          const yesterdayItem = yesterdayDailyRows.find((item) => item.stationId === stationId);
          const name = currentItem?.name ?? yesterdayItem?.name ?? stationId;
          const address = currentItem?.address ?? yesterdayItem?.address ?? stationId;
          const todayValue = Math.max(0, currentItem?.precipitationToday ?? Number.NaN);
          const yesterdayValue = Math.max(0, yesterdayMap.get(stationId) ?? 0);
          return {
            name,
            address,
            value: (Number.isFinite(todayValue) ? todayValue : 0) + yesterdayValue,
          };
        })
        .filter((item) => item.value > 0),
      'mm',
      'desc',
    ),
  };
};

export const buildRankingPayload = async (context, kind, options = {}) => {
  const { observedAt = '' } = options;

  if (kind === 'temperature-current') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildTemperatureCurrent(context, stationMetadata, observedAt);
  }

  if (kind === 'temperature-today') {
    return buildTemperatureToday(context, getAwsStationMetadata(context));
  }

  if (kind === 'precipitation-current') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationCurrent(context, stationMetadata, observedAt);
  }

  if (kind === 'precipitation-since-yesterday') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationSinceYesterday(context, stationMetadata, observedAt);
  }

  throw new Error('Invalid rankings kind.');
};

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const kind = requestUrl.searchParams.get('kind');
  const requestedObservedAt = requestUrl.searchParams.get('tm') || '';
  const forceRefresh = requestUrl.searchParams.has('_refresh');
  let cachedRecord = null;

  try {
    if (!RANKING_KINDS.includes(kind)) {
      return new Response(JSON.stringify({ error: 'Invalid rankings kind.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (requestedObservedAt && !parseKmaMinuteTime(requestedObservedAt)) {
      return new Response(JSON.stringify({ error: 'Invalid observation time.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      cachedRecord = await readPrecomputedRankingRecord(context, kind, requestedObservedAt);
    } catch {
      cachedRecord = null;
    }

    if (!forceRefresh && isFreshCacheRecord(cachedRecord, requestedObservedAt)) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt,
      });
    }

    if (!forceRefresh && isUsableStaleCacheRecord(cachedRecord, requestedObservedAt)) {
      schedulePrecomputedRankingRefresh(context, kind, requestedObservedAt);

      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Refreshing weather ranking data in the background"',
      });
    }

    const payload = await refreshPrecomputedRanking(context, kind, requestedObservedAt);

    return makeJsonResponse(payload, {
      'X-Weather-Data-Source': forceRefresh ? 'manual-refresh' : 'live',
    });
  } catch (error) {
    if (isUsableStaleCacheRecord(cachedRecord, requestedObservedAt)) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Serving stale weather ranking data"',
      });
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
