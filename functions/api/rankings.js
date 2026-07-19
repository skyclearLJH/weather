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
const CURRENT_CACHE_MAX_OBSERVED_AGE_MS = 8 * 60 * 1000;
const PRECOMPUTED_CACHE_API_MAX_AGE_SECONDS = 60 * 60;
// 15분 — 프런트가 65초마다 폴링하므로 이 값이 사실상 KMA 재계산 주기가 된다.
// 60초였을 때는 탭 하나만 열려 있어도 매 폴링마다 지점별 재계산(최대 42콜)이
// 돌아 장마철 KMA 일일 한도를 소진했다 (2026-07-19). 방송 직전 최신값이
// 필요하면 수동 새로고침(_refresh)을 쓰면 된다.
const PRECIPITATION_MAX_ONE_HOUR_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const PRECIPITATION_MAX_ONE_HOUR_CACHE_MAX_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const PRECIPITATION_MAX_ONE_HOUR_AGGREGATE_TTL_SECONDS = 3 * 24 * 60 * 60;
const ASOS_DAILY_RN_60M_MAX_INDEX = 41;
const ASOS_DAILY_RN_60M_MAX_TM_INDEX = 42;
const PRECIPITATION_MAX_ONE_HOUR_EXACT_FETCH_LIMIT = 42;
const PRECIPITATION_MAX_ONE_HOUR_PRIORITY_FETCH_LIMIT = 30;
const PRECIPITATION_MAX_ONE_HOUR_CLOSED_RECHECK_MS = 30 * 60 * 1000;
const AWS_MINUTE_RANGE_REQUEST_TIMEOUT_MS = 12000;
const RANKING_CACHE_VERSION = 'v8';
const TROPICAL_NIGHT_THRESHOLD_C = 25;
const TROPICAL_NIGHT_CONFIRMATION_DELAY_MINUTES = 5;
const TROPICAL_NIGHT_CACHE_MAX_AGE_MS = 60 * 1000;
const TROPICAL_NIGHT_CACHE_MAX_STALE_AGE_MS = 5 * 60 * 1000;
const HEAT_WARNING_UNSUPPORTED_AWS_STATION_IDS = new Set([
  '128',
  '139',
  '142',
  '153',
  '158',
  '161',
  '229',
  '334',
  '336',
  '403',
  '439',
  '457',
  '458',
  '460',
  '477',
  '485',
  '510',
]);
const PRECOMPUTED_REFRESH_IN_FLIGHT = new Map();
const KMA_TEXT_CACHE = new Map();
const KMA_TEXT_IN_FLIGHT = new Map();
const PRECIPITATION_MAX_ONE_HOUR_MEMORY_CACHE = new Map();
const padZero = (value) => value.toString().padStart(2, '0');

export const RANKING_KINDS = [
  'temperature-current',
  'temperature-today',
  'temperature-tropical-night',
  'precipitation-current',
  'precipitation-max-one-hour',
  'precipitation-since-yesterday',
  'precipitation-since-day-before-yesterday',
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
    async put(key, value, options = {}) {
      const maxAgeSeconds = options.expirationTtl ?? PRECOMPUTED_CACHE_API_MAX_AGE_SECONDS;
      await caches.default.put(
        buildCacheApiRequest(key),
        new Response(value, {
          headers: {
            'Cache-Control': `public, max-age=${maxAgeSeconds}`,
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

const getFreshCacheMaxAgeMs = (observedAt = '', kind = '') => {
  if (kind === 'temperature-tropical-night') {
    return TROPICAL_NIGHT_CACHE_MAX_AGE_MS;
  }

  if (kind === 'precipitation-max-one-hour') {
    return PRECIPITATION_MAX_ONE_HOUR_CACHE_MAX_AGE_MS;
  }

  return observedAt ? SELECTED_TIME_CACHE_MAX_AGE_MS : PRECOMPUTED_CACHE_MAX_AGE_MS;
};

const getStaleCacheMaxAgeMs = (observedAt = '', kind = '') => {
  if (kind === 'temperature-tropical-night') {
    return TROPICAL_NIGHT_CACHE_MAX_STALE_AGE_MS;
  }

  if (kind === 'precipitation-max-one-hour') {
    return PRECIPITATION_MAX_ONE_HOUR_CACHE_MAX_STALE_AGE_MS;
  }

  return observedAt ? SELECTED_TIME_CACHE_MAX_STALE_AGE_MS : PRECOMPUTED_CACHE_MAX_STALE_AGE_MS;
};

const isFreshCacheRecord = (record, observedAt = '', kind = '') => {
  if (!record?.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= getFreshCacheMaxAgeMs(observedAt, kind);
};

const isUsableStaleCacheRecord = (record, observedAt = '', kind = '') => {
  if (!record?.payload || !record.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= getStaleCacheMaxAgeMs(observedAt, kind);
};

const isLatestCurrentRanking = (kind, observedAt = '') =>
  !observedAt && (kind === 'temperature-current' || kind === 'precipitation-current');

const getObservedAgeMs = (timestamp = '') => {
  const observedDate = parseKmaMinuteTime(timestamp);
  if (!observedDate) {
    return Number.POSITIVE_INFINITY;
  }

  return getKstNow().getTime() - observedDate.getTime();
};

const isCacheFastReturnAllowed = (record, kind, observedAt = '') => {
  if (!isLatestCurrentRanking(kind, observedAt)) {
    return true;
  }

  const observedAgeMs = getObservedAgeMs(record?.payload?.observedAt);
  return observedAgeMs >= 0 && observedAgeMs <= CURRENT_CACHE_MAX_OBSERVED_AGE_MS;
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

const refreshPrecomputedRanking = async (context, kind, observedAt = '', options = {}) => {
  const payload = await buildRankingPayload(context, kind, {
    ...options,
    observedAt: options.observedAt ?? (/^\d{12}$/.test(observedAt) ? observedAt : ''),
  });
  await writePrecomputedRanking(context, kind, payload, observedAt);
  return payload;
};

const schedulePrecomputedRankingRefresh = (context, kind, observedAt = '', options = {}) => {
  if (isPrecomputedCacheDisabled(context) || !getWeatherCache(context)) {
    return null;
  }

  const cacheKey = getRankingCacheKey(kind, observedAt);
  if (PRECOMPUTED_REFRESH_IN_FLIGHT.has(cacheKey)) {
    return PRECOMPUTED_REFRESH_IN_FLIGHT.get(cacheKey);
  }

  const refreshPromise = refreshPrecomputedRanking(context, kind, observedAt, options)
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

const getKstDayStart = (date) => {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  return dayStart;
};

const setKstTime = (date, hour, minute = 0) => {
  const result = new Date(date);
  result.setUTCHours(hour, minute, 0, 0);
  return result;
};

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

const formatDisplayKoreanWindowMinute = (date) => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = padZero(date.getUTCHours());
  const minute = padZero(date.getUTCMinutes());
  return `${month}월 ${day}일 ${hour}시 ${minute}분`;
};

const buildTropicalNightWindowLabel = (start, end) =>
  `${formatDisplayKoreanWindowMinute(start)} ~ ${formatDisplayKoreanWindowMinute(end)}`;

const parseNumericValue = (value) => {
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const isFiniteObservation = (value) => Number.isFinite(value) && value > -50;
const isHeatWarningSupportedStation = (stationId) =>
  !HEAT_WARNING_UNSUPPORTED_AWS_STATION_IDS.has(String(stationId));

const buildRankingRows = (items, unit, sortDirection = 'desc') =>
  [...items]
    .sort((left, right) => (sortDirection === 'asc' ? left.value - right.value : right.value - left.value))
    .map((item, index) => ({
      rank: index + 1,
      name: item.name,
      record: `${item.value.toFixed(1)}${unit}`,
      address: item.address,
    }));

const normalizeStationAddress = (value = '') =>
  value
    .replace(/^(?:(?:\d+|-{2,}|_+|\*+|[xX]+)\s*)+/, '')
    .trim();

const getPrecipitationMaxOneHourAggregateKey = (day) =>
  `precipitation-max-one-hour:${RANKING_CACHE_VERSION}:${day}`;

const readPrecipitationMaxOneHourAggregate = async (context, day) => {
  const key = getPrecipitationMaxOneHourAggregateKey(day);
  const weatherCache = getWeatherCache(context);

  try {
    if (weatherCache && !isPrecomputedCacheDisabled(context)) {
      return weatherCache.get(key, 'json');
    }
  } catch {
    return null;
  }

  const cached = PRECIPITATION_MAX_ONE_HOUR_MEMORY_CACHE.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    PRECIPITATION_MAX_ONE_HOUR_MEMORY_CACHE.delete(key);
    return null;
  }

  return cached.value;
};

const writePrecipitationMaxOneHourAggregate = async (context, day, aggregate) => {
  const key = getPrecipitationMaxOneHourAggregateKey(day);
  const weatherCache = getWeatherCache(context);

  if (weatherCache && !isPrecomputedCacheDisabled(context)) {
    await weatherCache.put(key, JSON.stringify(aggregate), {
      expirationTtl: PRECIPITATION_MAX_ONE_HOUR_AGGREGATE_TTL_SECONDS,
    });
    return;
  }

  PRECIPITATION_MAX_ONE_HOUR_MEMORY_CACHE.set(key, {
    value: aggregate,
    expiresAt: Date.now() + PRECIPITATION_MAX_ONE_HOUR_AGGREGATE_TTL_SECONDS * 1000,
  });
};

const createPrecipitationMaxOneHourAggregate = (day, previous) => ({
  day,
  observedAt: previous?.observedAt ?? '',
  updatedAt: previous?.updatedAt ?? '',
  stations: { ...(previous?.stations ?? {}) },
  sampledTimes: Array.isArray(previous?.sampledTimes) ? [...previous.sampledTimes] : [],
  exactUpTo: { ...(previous?.exactUpTo ?? {}) },
  exactCheckedAt: { ...(previous?.exactCheckedAt ?? {}) },
});

const mergePrecipitationMaxOneHourRows = (aggregate, observedAt, rows = []) => {
  if (!aggregate || !observedAt) {
    return false;
  }

  const sampledTimes = new Set(aggregate.sampledTimes ?? []);
  let hasChanged = false;

  if (!sampledTimes.has(observedAt)) {
    sampledTimes.add(observedAt);
    hasChanged = true;
  }

  if (!aggregate.observedAt || observedAt > aggregate.observedAt) {
    aggregate.observedAt = observedAt;
    hasChanged = true;
  }

  rows.forEach((item) => {
    const stationId = String(item.stationId ?? '');
    const value = item.precipitationOneHour;
    if (!stationId || !Number.isFinite(value) || value <= 0) {
      return;
    }

    const existing = aggregate.stations[stationId];
    if (!existing || value > existing.value || (value === existing.value && observedAt > existing.observedAt)) {
      aggregate.stations[stationId] = {
        stationId,
        name: item.name,
        address: item.address,
        value,
        observedAt,
      };
      hasChanged = true;
    }
  });

  aggregate.sampledTimes = [...sampledTimes].sort();
  if (hasChanged) {
    aggregate.updatedAt = new Date().toISOString();
  }

  return hasChanged;
};

const updatePrecipitationMaxOneHourAggregate = async (context, observedAt, rows = []) => {
  if (!observedAt) {
    return null;
  }

  const day = observedAt.slice(0, 8);
  const previous = await readPrecipitationMaxOneHourAggregate(context, day);
  const aggregate = createPrecipitationMaxOneHourAggregate(day, previous);
  const hasChanged = mergePrecipitationMaxOneHourRows(aggregate, observedAt, rows);

  if (hasChanged) {
    await writePrecipitationMaxOneHourAggregate(context, day, aggregate);
  }

  return aggregate;
};

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
    const lawAddress = normalizeStationAddress(fields.slice(13).join(' '));
    stationMetadata.set(stationId, {
      name: stationName,
      address: lawAddress || stationName,
    });
  });

  return stationMetadata;
};

const parseSfcStationMetadata = (rawText) => {
  const stationMetadata = new Map();

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length < 16) {
      return;
    }

    const stationId = fields[0];
    const stationName = fields[10] || fields[9] || stationId;
    const address = normalizeStationAddress(fields.slice(15).join(' '));
    stationMetadata.set(stationId, {
      name: stationName,
      address: address || stationName,
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

const parseAsosDailyMaxOneHourRows = (rawText, stationMetadata) =>
  rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length > ASOS_DAILY_RN_60M_MAX_TM_INDEX)
    .map((fields) => {
      const stationId = fields[1];
      const metadata = stationMetadata.get(stationId) ?? { name: stationId, address: stationId };
      const occurredClock = fields[ASOS_DAILY_RN_60M_MAX_TM_INDEX] ?? '';
      return {
        stationId,
        name: metadata.name,
        address: metadata.address,
        value: parseNumericValue(fields[ASOS_DAILY_RN_60M_MAX_INDEX]),
        occurredClock: /^\d{1,4}$/.test(occurredClock) ? occurredClock.padStart(4, '0') : '',
      };
    });

const parseAwsStationMinuteSeries = (rawText) =>
  rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((fields) => fields.length >= 14)
    .map((fields) => ({
      observedAt: fields[0],
      value: parseNumericValue(fields[11]),
    }));

// 후보 풀은 현재 스냅샷의 일 강수량 지점과 기존 집계에 잡힌 지점의 합집합이라,
// 중간에 결측된 지점도 과거 구간의 정밀 계산 대상에서 빠지지 않는다.
const buildExactFetchCandidates = (aggregate, dayTotals, windowEnd, isClosedWindow) => {
  const potentials = new Map();
  dayTotals.forEach(({ stationId, total }) => {
    if (Number.isFinite(total) && total > 0) {
      potentials.set(stationId, total);
    }
  });
  Object.values(aggregate.stations ?? {}).forEach((item) => {
    const stationId = String(item.stationId);
    if (Number.isFinite(item.value) && item.value > 0) {
      potentials.set(stationId, Math.max(potentials.get(stationId) ?? 0, item.value));
    }
  });

  const candidates = [...potentials.entries()]
    .map(([stationId, potential]) => ({
      stationId,
      potential,
      exactUpTo: aggregate.exactUpTo?.[stationId] ?? '',
      exactCheckedAt: aggregate.exactCheckedAt?.[stationId] ?? '',
    }))
    .filter(({ exactUpTo, exactCheckedAt }) => {
      if (!isClosedWindow) {
        return true;
      }

      if (!exactUpTo || exactUpTo < windowEnd) {
        return true;
      }

      const checkedAt = Date.parse(exactCheckedAt);
      return !Number.isFinite(checkedAt) || Date.now() - checkedAt >= PRECIPITATION_MAX_ONE_HOUR_CLOSED_RECHECK_MS;
    })
    .sort((left, right) => right.potential - left.potential);

  if (isClosedWindow) {
    return candidates
      .sort((left, right) => {
        if (left.exactCheckedAt !== right.exactCheckedAt) {
          return left.exactCheckedAt < right.exactCheckedAt ? -1 : 1;
        }
        return right.potential - left.potential;
      })
      .slice(0, PRECIPITATION_MAX_ONE_HOUR_EXACT_FETCH_LIMIT);
  }

  const priority = candidates.slice(0, PRECIPITATION_MAX_ONE_HOUR_PRIORITY_FETCH_LIMIT);
  const priorityStationIds = new Set(priority.map((item) => item.stationId));
  const rotation = candidates
    .filter((item) => !priorityStationIds.has(item.stationId))
    .sort((left, right) => {
      if (left.exactCheckedAt !== right.exactCheckedAt) {
        return left.exactCheckedAt < right.exactCheckedAt ? -1 : 1;
      }
      return right.potential - left.potential;
    })
    .slice(0, PRECIPITATION_MAX_ONE_HOUR_EXACT_FETCH_LIMIT - priority.length);

  return [...priority, ...rotation];
};

// 선정된 지점의 당일 분자료(RN-60m)를 매번 처음부터 다시 받아 지연 수집과
// 사후 품질관리로 같은 시각의 값이 정정되는 경우까지 최대값에 반영한다.
const refreshExactStationMaxima = async (
  context,
  stationMetadata,
  aggregate,
  dayTotals,
  targetDay,
  windowEnd,
) => {
  if (!parseKmaMinuteTime(windowEnd)) {
    return false;
  }

  const isClosedWindow = windowEnd === `${targetDay}2359`;
  const candidates = buildExactFetchCandidates(
    aggregate,
    dayTotals,
    windowEnd,
    isClosedWindow,
  );
  if (candidates.length === 0) {
    return false;
  }

  const dayStartTime = `${targetDay}0001`;
  const results = await Promise.allSettled(
    candidates.map(async ({ stationId }) => {
      const rawText = await fetchKmaText(
        context,
        'api/typ01/cgi-bin/url/nph-aws2_min',
        { tm1: dayStartTime, tm2: windowEnd, stn: stationId, disp: 0, help: 0 },
        AWS_MINUTE_RANGE_REQUEST_TIMEOUT_MS,
        300,
      );

      let best = null;
      let coveredThrough = '';
      parseAwsStationMinuteSeries(rawText).forEach((row) => {
        if (parseKmaMinuteTime(row.observedAt) && row.observedAt > coveredThrough) {
          coveredThrough = row.observedAt;
        }
        if (Number.isFinite(row.value) && row.value > 0 && (!best || row.value > best.value)) {
          best = row;
        }
      });
      return { stationId, best, coveredThrough };
    }),
  );

  let hasChanged = false;
  results.forEach((result) => {
    if (result.status !== 'fulfilled' || !result.value) {
      return;
    }

    const { stationId, best, coveredThrough } = result.value;
    const metadata = stationMetadata.get(stationId) ?? { name: stationId, address: stationId };
    const existing = aggregate.stations[stationId];
    if (
      best &&
      (!existing || best.value > existing.value || coveredThrough >= existing.observedAt) &&
      (best.value !== existing?.value || best.observedAt !== existing?.observedAt)
    ) {
      aggregate.stations[stationId] = {
        stationId,
        name: metadata.name,
        address: metadata.address,
        value: best.value,
        observedAt: best.observedAt,
      };
      hasChanged = true;
    }

    if (coveredThrough && (aggregate.exactUpTo[stationId] ?? '') !== coveredThrough) {
      aggregate.exactUpTo[stationId] = coveredThrough;
      hasChanged = true;
    }

    if (coveredThrough) {
      aggregate.exactCheckedAt[stationId] = new Date().toISOString();
      hasChanged = true;
    }
  });

  if (hasChanged) {
    aggregate.updatedAt = new Date().toISOString();
  }

  return hasChanged;
};

const fetchAsosDailyMaxOneHourRows = async (context, targetDay, isConfirmedDay) => {
  const [sfcStationMetadata, rawText] = await Promise.all([
    getSfcStationMetadata(context),
    fetchKmaText(
      context,
      'api/typ01/url/kma_sfcdd3.php',
      { tm1: targetDay, tm2: targetDay, stn: 0, disp: 0, help: 0 },
      SLOW_DAILY_RAIN_TIMEOUT_MS,
      isConfirmedDay ? 600 : 60,
    ),
  ]);
  return parseAsosDailyMaxOneHourRows(rawText, sfcStationMetadata);
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

const getSfcStationMetadata = async (context) => {
  const rawText = await fetchKmaText(
    context,
    'api/typ01/url/stn_inf.php',
    { inf: 'SFC', stn: '', tm: formatStationInfoTime(getKstNow()), help: 1 },
    12000,
    86400,
  );
  return parseSfcStationMetadata(rawText);
};

const buildTropicalNightWindow = (now = getKstNow()) => {
  const todayStart = getKstDayStart(now);
  const officialEnd = setKstTime(todayStart, 9, 0);
  const currentMinuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const confirmationMinute = 9 * 60 + TROPICAL_NIGHT_CONFIRMATION_DELAY_MINUTES;
  const isProvisional = currentMinuteOfDay < confirmationMinute;
  const start = setKstTime(subtractDays(todayStart, 1), 18, 1);
  const end = isProvisional ? now : officialEnd;

  return {
    start,
    end: end.getTime() >= start.getTime() ? end : start,
    status: isProvisional ? 'provisional' : 'confirmed',
  };
};

const buildTropicalNightNote = ({ start, end, status }) => {
  const windowLabel = buildTropicalNightWindowLabel(start, end);

  if (status === 'provisional') {
    return `ASOS 일 최저기온 기준 열대야 진행 상황입니다. ${windowLabel}까지 25°C 이상 유지 중인 지점이며, 최종 기록은 09시 이후 확인하세요.`;
  }

  return `ASOS 일 최저기온 기준 확정 열대야 기록입니다. ${windowLabel} 최저기온이 25°C 이상인 지점입니다.`;
};

const buildTemperatureTropicalNight = async (context) => {
  const stationMetadata = await getSfcStationMetadata(context);
  const windowInfo = buildTropicalNightWindow();
  const observedDay = formatKmaDay(windowInfo.end);
  const dailyMinRaw = await fetchKmaText(
    context,
    'api/typ01/url/sfc_aws_day.php',
    { tm2: observedDay, obs: 'ta_min', stn: 0, disp: 0, help: 0 },
    SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
    windowInfo.status === 'provisional' ? 60 : 10 * 60,
  );
  const dailyMinRows = parseAwsDailyObservations(dailyMinRaw, stationMetadata).filter((item) =>
    stationMetadata.has(item.stationId),
  );

  if (dailyMinRows.length === 0) {
    throw new Error('No valid ASOS daily minimum temperature observations were found.');
  }

  const candidates = dailyMinRows.filter(
    (item) => isFiniteObservation(item.value) && item.value >= TROPICAL_NIGHT_THRESHOLD_C,
  );
  const note = buildTropicalNightNote(windowInfo);

  return {
    observedAt: formatKmaMinuteTime(windowInfo.end),
    observedLabel: formatDisplayKoreanDateTime(formatKmaMinuteTime(windowInfo.end)),
    tropicalNight: buildRankingRows(candidates, '°C', 'desc'),
    tropicalNightNote: note,
    tropicalNightStatus: windowInfo.status,
    tropicalNightWindow: {
      start: formatKmaMinuteTime(windowInfo.start),
      end: formatKmaMinuteTime(windowInfo.end),
    },
    tropicalNightSource: 'sfc_aws_day:ta_min',
    tropicalNightStationCount: dailyMinRows.length,
  };
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
      rows
        .filter((item) => isFiniteObservation(item.temperature) && isHeatWarningSupportedStation(item.stationId))
        .map((item) => ({
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
      dailyMaxRows
        .filter((item) => isFiniteObservation(item.value) && isHeatWarningSupportedStation(item.stationId))
        .map((item) => ({
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

  // 최대 60분 집계 갱신은 응답을 막지 않도록 백그라운드에서 처리한다.
  const aggregateUpdate = updatePrecipitationMaxOneHourAggregate(context, observedAt, rows).catch(
    () => {},
  );
  if (context.waitUntil) {
    context.waitUntil(aggregateUpdate);
  }

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

const buildPrecipitationMaxOneHour = async (context, stationMetadata, period = 'today') => {
  const now = getKstNow();
  const normalizedPeriod = period === 'yesterday' ? 'yesterday' : 'today';
  const targetDate = normalizedPeriod === 'yesterday' ? subtractDays(now, 1) : now;
  const targetDay = formatKmaDay(targetDate);

  // ASOS 일자료의 RN_60M_MAX는 관측소가 매분 굴림합으로 계산한 공식 통계라
  // 분자료 샘플링 횟수와 무관하게 하루 전체가 누락 없이 반영된다.
  const officialRowsPromise = fetchAsosDailyMaxOneHourRows(
    context,
    targetDay,
    normalizedPeriod === 'yesterday',
  );
  officialRowsPromise.catch(() => {});

  // 집계 읽기(KV)와 관측 데이터 요청은 서로 독립이므로 동시에 시작한다.
  const previousAggregatePromise = readPrecipitationMaxOneHourAggregate(context, targetDay);
  const observationPromise =
    normalizedPeriod === 'today'
      ? fetchLatestAwsPrecipitationObservations(context, stationMetadata)
      : fetchKmaText(
          context,
          'api/typ01/url/sfc_aws_day.php',
          { tm2: targetDay, obs: 'rn_day', stn: 0, disp: 0, help: 0 },
          SLOW_DAILY_RAIN_TIMEOUT_MS,
          600,
        );
  observationPromise.catch(() => {});

  const previousAggregate = await previousAggregatePromise;
  const aggregate = createPrecipitationMaxOneHourAggregate(targetDay, previousAggregate);
  let hasAggregateChanged = false;
  let dayTotals = [];
  let exactWindowEnd = '';

  if (normalizedPeriod === 'today') {
    try {
      const latestCurrent = await observationPromise;
      hasAggregateChanged = mergePrecipitationMaxOneHourRows(
        aggregate,
        latestCurrent.observedAt,
        latestCurrent.rows,
      );
      exactWindowEnd = latestCurrent.observedAt;
      dayTotals = latestCurrent.rows
        .filter((item) => Number.isFinite(item.precipitationToday) && item.precipitationToday > 0)
        .map((item) => ({ stationId: String(item.stationId), total: item.precipitationToday }));
    } catch {
      // AWS 지점 보완이 실패해도 공식 일자료만으로 순위를 만든다.
    }
  } else {
    exactWindowEnd = `${targetDay}2359`;
    try {
      const dailyRaw = await observationPromise;
      dayTotals = parseAwsDailyObservations(dailyRaw, stationMetadata)
        .filter((item) => Number.isFinite(item.value) && item.value > 0)
        .map((item) => ({ stationId: String(item.stationId), total: item.value }));
    } catch {
      // 어제 일 강수량 목록이 없으면 기존 집계와 공식 일자료만으로 순위를 만든다.
    }
  }

  try {
    hasAggregateChanged = (await refreshExactStationMaxima(
      context,
      stationMetadata,
      aggregate,
      dayTotals,
      targetDay,
      exactWindowEnd,
    )) || hasAggregateChanged;
  } catch {
    // 지점별 정밀 계산이 실패해도 나머지 데이터로 순위를 만든다.
  }

  let officialRows = [];
  let officialError = null;
  try {
    officialRows = await officialRowsPromise;
  } catch (error) {
    officialError = error;
  }

  if (hasAggregateChanged) {
    await writePrecipitationMaxOneHourAggregate(context, targetDay, aggregate);
  }

  const stationValues = new Map();
  Object.values(aggregate?.stations ?? {})
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .forEach((item) => {
      stationValues.set(String(item.stationId), {
        name: item.name,
        address: item.address,
        value: item.value,
      });
    });

  officialRows
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .forEach((item) => {
      const existing = stationValues.get(item.stationId);
      if (!existing || item.value >= existing.value) {
        stationValues.set(item.stationId, {
          name: item.name,
          address: item.address,
          value: item.value,
        });
      }
    });

  if (officialError && stationValues.size === 0) {
    throw officialError;
  }

  const observedAt =
    normalizedPeriod === 'yesterday'
      ? `${targetDay}2359`
      : aggregate?.observedAt || formatKmaMinuteTime(now);

  return {
    observedAt,
    observedLabel: formatDisplayKoreanDateTime(observedAt),
    maxOneHour: buildRankingRows([...stationValues.values()], 'mm', 'desc'),
    maxOneHourPeriod: normalizedPeriod,
    maxOneHourDay: targetDay,
    maxOneHourSource: 'kma-sfcdd-daily+aws-minute-exact',
    maxOneHourSampledCount: aggregate?.sampledTimes?.length ?? 0,
  };
};

// 오늘 현시점 누적에 지난 daysBack일치 일 강수량을 더한 누적 순위를 만든다.
const buildPrecipitationCumulative = async (
  context,
  stationMetadata,
  requestedObservedAt,
  daysBack,
  payloadKey,
) => {
  const requestedDate = requestedObservedAt ? parseKmaMinuteTime(requestedObservedAt) : null;
  const baseDate = requestedDate ?? getKstNow();

  // 일자료 응답이 느린 편이라 현재 분자료 조회를 같이 시작해 대기 시간을 겹친다.
  const latestCurrentPromise = requestedObservedAt
    ? fetchAwsMinuteObservationsAtTime(
        context,
        stationMetadata,
        requestedObservedAt,
        hasValidAwsPrecipitationObservation,
      )
    : fetchLatestAwsPrecipitationObservations(context, stationMetadata);
  latestCurrentPromise.catch(() => {});

  const pastDailyRaws = await Promise.all(
    Array.from({ length: daysBack }, (_, index) =>
      fetchKmaText(
        context,
        'api/typ01/url/sfc_aws_day.php',
        { tm2: formatKmaDay(subtractDays(baseDate, index + 1)), obs: 'rn_day', stn: 0, disp: 0, help: 0 },
        SLOW_DAILY_RAIN_TIMEOUT_MS,
        300,
      ),
    ),
  );

  let observedAt = requestedObservedAt || formatKmaMinuteTime(baseDate);
  let currentRows = [];
  try {
    const latestCurrent = await latestCurrentPromise;
    observedAt = latestCurrent.observedAt;
    currentRows = latestCurrent.rows;
  } catch {
    // Keep past-day totals even when current minute data is unavailable.
  }

  const pastTotals = new Map();
  const pastRowsByStation = new Map();
  pastDailyRaws.forEach((dailyRaw) => {
    parseAwsDailyObservations(dailyRaw, stationMetadata).forEach((item) => {
      if (!Number.isFinite(item.value) || item.value <= 0) {
        return;
      }
      pastTotals.set(item.stationId, (pastTotals.get(item.stationId) ?? 0) + item.value);
      if (!pastRowsByStation.has(item.stationId)) {
        pastRowsByStation.set(item.stationId, item);
      }
    });
  });

  const currentMap = new Map(currentRows.map((item) => [item.stationId, item]));
  const allStationIds = new Set([...currentMap.keys(), ...pastTotals.keys()]);

  return {
    observedAt,
    observedLabel: formatDisplayKoreanDateTime(observedAt),
    [payloadKey]: buildRankingRows(
      [...allStationIds]
        .map((stationId) => {
          const currentItem = currentMap.get(stationId);
          const pastItem = pastRowsByStation.get(stationId);
          const name = currentItem?.name ?? pastItem?.name ?? stationId;
          const address = currentItem?.address ?? pastItem?.address ?? stationId;
          const todayValue = Math.max(0, currentItem?.precipitationToday ?? Number.NaN);
          return {
            name,
            address,
            value: (Number.isFinite(todayValue) ? todayValue : 0) + (pastTotals.get(stationId) ?? 0),
          };
        })
        .filter((item) => item.value > 0),
      'mm',
      'desc',
    ),
  };
};

const buildPrecipitationSinceYesterday = (context, stationMetadata, requestedObservedAt = '') =>
  buildPrecipitationCumulative(context, stationMetadata, requestedObservedAt, 1, 'sinceYesterday');

const buildPrecipitationSinceDayBeforeYesterday = (context, stationMetadata, requestedObservedAt = '') =>
  buildPrecipitationCumulative(context, stationMetadata, requestedObservedAt, 2, 'sinceDayBeforeYesterday');

export const buildRankingPayload = async (context, kind, options = {}) => {
  const { observedAt = '', period = 'today' } = options;

  if (kind === 'temperature-current') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildTemperatureCurrent(context, stationMetadata, observedAt);
  }

  if (kind === 'temperature-today') {
    return buildTemperatureToday(context, getAwsStationMetadata(context));
  }

  if (kind === 'temperature-tropical-night') {
    return buildTemperatureTropicalNight(context);
  }

  if (kind === 'precipitation-current') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationCurrent(context, stationMetadata, observedAt);
  }

  if (kind === 'precipitation-max-one-hour') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationMaxOneHour(context, stationMetadata, period);
  }

  if (kind === 'precipitation-since-yesterday') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationSinceYesterday(context, stationMetadata, observedAt);
  }

  if (kind === 'precipitation-since-day-before-yesterday') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationSinceDayBeforeYesterday(context, stationMetadata, observedAt);
  }

  throw new Error('Invalid rankings kind.');
};

// '어제' 집계는 어제 탭을 열 때만 진행되면 하루 뒤에나 수렴하므로,
// 트래픽이 많은 '오늘' 조회에 편승해 백그라운드로 계속 채워 둔다.
const scheduleYesterdayMaxOneHourRefresh = async (context) => {
  const kind = 'precipitation-max-one-hour';
  const variant = 'period:yesterday';

  try {
    const record = await readPrecomputedRankingRecord(context, kind, variant);
    if (isFreshCacheRecord(record, variant, kind)) {
      return;
    }
  } catch {
    // 캐시 확인에 실패하면 갱신을 시도한다.
  }

  schedulePrecomputedRankingRefresh(context, kind, variant, { period: 'yesterday' });
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
  const requestedPeriod = requestUrl.searchParams.get('period') || 'today';
  const cacheVariant =
    kind === 'precipitation-max-one-hour' ? `period:${requestedPeriod}` : requestedObservedAt;
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

    if (
      kind === 'precipitation-max-one-hour' &&
      requestedPeriod !== 'today' &&
      requestedPeriod !== 'yesterday'
    ) {
      return new Response(JSON.stringify({ error: 'Invalid precipitation period.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (kind === 'precipitation-max-one-hour' && requestedPeriod === 'today') {
      const yesterdayRefresh = scheduleYesterdayMaxOneHourRefresh(context);
      if (context.waitUntil) {
        context.waitUntil(yesterdayRefresh);
      } else {
        yesterdayRefresh.catch(() => {});
      }
    }

    try {
      cachedRecord = await readPrecomputedRankingRecord(context, kind, cacheVariant);
    } catch {
      cachedRecord = null;
    }

    if (
      !forceRefresh &&
      isFreshCacheRecord(cachedRecord, cacheVariant, kind) &&
      isCacheFastReturnAllowed(cachedRecord, kind, cacheVariant)
    ) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt,
      });
    }

    if (
      !forceRefresh &&
      isUsableStaleCacheRecord(cachedRecord, cacheVariant, kind) &&
      isCacheFastReturnAllowed(cachedRecord, kind, cacheVariant)
    ) {
      schedulePrecomputedRankingRefresh(context, kind, cacheVariant, {
        observedAt: requestedObservedAt,
        period: requestedPeriod,
      });

      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Refreshing weather ranking data in the background"',
      });
    }

    // 동시에 들어온 요청들이 각자 전체 재계산을 돌리지 않도록,
    // 수동 새로고침이 아니면 진행 중인 재계산에 합류한다.
    const refreshOptions = { observedAt: requestedObservedAt, period: requestedPeriod };
    const payload = forceRefresh
      ? await refreshPrecomputedRanking(context, kind, cacheVariant, refreshOptions)
      : await (schedulePrecomputedRankingRefresh(context, kind, cacheVariant, refreshOptions) ??
          refreshPrecomputedRanking(context, kind, cacheVariant, refreshOptions));

    return makeJsonResponse(payload, {
      'X-Weather-Data-Source': forceRefresh ? 'manual-refresh' : 'live',
    });
  } catch (error) {
    if (isUsableStaleCacheRecord(cachedRecord, cacheVariant, kind)) {
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
