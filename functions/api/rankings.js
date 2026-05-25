const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const AWS_MINUTE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15];
const AWS_TEMPERATURE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15, 20, 30];
const AWS_DAILY_TEMPERATURE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15, 20, 30, 60, 120, 180];
const SLOW_DAILY_RAIN_TIMEOUT_MS = 30000;
const SLOW_DAILY_TEMPERATURE_TIMEOUT_MS = 20000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PRECOMPUTED_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const PRECOMPUTED_CACHE_API_MAX_AGE_SECONDS = 60 * 60;
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

export const getRankingCacheKey = (kind) => `rankings:${kind}`;

const isFreshCacheRecord = (record) => {
  if (!record?.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= PRECOMPUTED_CACHE_MAX_AGE_MS;
};

const readPrecomputedRankingRecord = async (context, kind) => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || isPrecomputedCacheDisabled(context)) {
    return null;
  }

  return weatherCache.get(getRankingCacheKey(kind), 'json');
};

export const writePrecomputedRanking = async (context, kind, payload) => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || !payload) {
    return;
  }

  await weatherCache.put(
    getRankingCacheKey(kind),
    JSON.stringify({
      kind,
      generatedAt: new Date().toISOString(),
      payload,
    }),
  );
};

const refreshPrecomputedRanking = async (context, kind) => {
  const payload = await buildRankingPayload(context, kind);
  await writePrecomputedRanking(context, kind, payload);
  return payload;
};

const schedulePrecomputedRankingRefresh = (context, kind) => {
  if (isPrecomputedCacheDisabled(context) || !getWeatherCache(context)) {
    return null;
  }

  const cacheKey = getRankingCacheKey(kind);
  if (PRECOMPUTED_REFRESH_IN_FLIGHT.has(cacheKey)) {
    return PRECOMPUTED_REFRESH_IN_FLIGHT.get(cacheKey);
  }

  const refreshPromise = refreshPrecomputedRanking(context, kind)
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
  const cachedText = getCachedKmaText(cacheKey);
  if (cachedText !== null) {
    return cachedText;
  }

  if (KMA_TEXT_IN_FLIGHT.has(cacheKey)) {
    return KMA_TEXT_IN_FLIGHT.get(cacheKey);
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

  const requestOptions = {
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

  KMA_TEXT_IN_FLIGHT.set(cacheKey, requestPromise);
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

const fetchAwsMinuteObservationsByTimes = async (context, stationMetadata, candidateTimes, validator) => {
  for (const candidateTime of candidateTimes) {
    const observedAt = formatKmaMinuteTime(candidateTime);
    const rawText = await fetchKmaText(
      context,
      'api/typ01/cgi-bin/url/nph-aws2_min',
      { tm2: observedAt, stn: 0, disp: 0, help: 1 },
      12000,
      60,
    );
    const rows = parseAwsMinuteObservations(rawText, stationMetadata);
    if (validator(rows)) {
      return { observedAt, rows };
    }
  }

  throw new Error('유효한 AWS 분자료를 찾지 못했습니다.');
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

const buildTemperatureCurrent = async (context, stationMetadata) => {
  const { observedAt, rows } = await fetchLatestAwsTemperatureObservations(context, stationMetadata);
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

const fetchDailyTemperatureRawByTimes = async (context, candidateTimes) => {
  const seenDays = new Set();

  for (const candidateTime of candidateTimes) {
    const observedDay = formatKmaDay(candidateTime);
    if (seenDays.has(observedDay)) {
      continue;
    }

    seenDays.add(observedDay);

    const [minDailyRaw, maxDailyRaw] = await Promise.all([
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

    if (hasDailyObservationRows(minDailyRaw) || hasDailyObservationRows(maxDailyRaw)) {
      return {
        observedAt: formatKmaMinuteTime(candidateTime),
        minDailyRaw,
        maxDailyRaw,
      };
    }
  }

  throw new Error('No valid daily temperature observations were found.');
};

const buildTemperatureToday = async (context, stationMetadataPromise) => {
  const now = getKstNow();
  const candidateTimes = AWS_DAILY_TEMPERATURE_LOOKBACK_STEPS.map((offset) => subtractMinutes(now, offset));
  const [
    stationMetadata,
    { observedAt, minDailyRaw, maxDailyRaw },
  ] = await Promise.all([
    stationMetadataPromise,
    fetchDailyTemperatureRawByTimes(context, candidateTimes),
  ]);

  const dailyMinRows = parseAwsDailyObservations(minDailyRaw, stationMetadata);
  const dailyMaxRows = parseAwsDailyObservations(maxDailyRaw, stationMetadata);

  return {
    observedAt,
    observedLabel: formatDisplayKoreanDateTime(observedAt),
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

const buildPrecipitationCurrent = async (context, stationMetadata) => {
  const { observedAt, rows } = await fetchLatestAwsPrecipitationObservations(context, stationMetadata);
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

const buildPrecipitationSinceYesterday = async (context, stationMetadata) => {
  const now = getKstNow();
  const yesterday = subtractDays(now, 1);
  const yesterdayDailyRaw = await fetchKmaText(
    context,
    'api/typ01/url/sfc_aws_day.php',
    { tm2: formatKmaDay(yesterday), obs: 'rn_day', stn: 0, disp: 0, help: 0 },
    SLOW_DAILY_RAIN_TIMEOUT_MS,
    300,
  );

  let observedAt = formatKmaMinuteTime(now);
  let currentRows = [];
  try {
    const latestCurrent = await fetchLatestAwsPrecipitationObservations(context, stationMetadata);
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

export const buildRankingPayload = async (context, kind) => {
  if (kind === 'temperature-current') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildTemperatureCurrent(context, stationMetadata);
  }

  if (kind === 'temperature-today') {
    return buildTemperatureToday(context, getAwsStationMetadata(context));
  }

  if (kind === 'precipitation-current') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationCurrent(context, stationMetadata);
  }

  if (kind === 'precipitation-since-yesterday') {
    const stationMetadata = await getAwsStationMetadata(context);
    return buildPrecipitationSinceYesterday(context, stationMetadata);
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
  let cachedRecord = null;

  try {
    if (!RANKING_KINDS.includes(kind)) {
      return new Response(JSON.stringify({ error: 'Invalid rankings kind.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      cachedRecord = await readPrecomputedRankingRecord(context, kind);
    } catch {
      cachedRecord = null;
    }

    if (isFreshCacheRecord(cachedRecord)) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt,
      });
    }

    if (cachedRecord?.payload) {
      schedulePrecomputedRankingRefresh(context, kind);
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Refreshing weather ranking data in the background"',
      });
    }

    const payload = await refreshPrecomputedRanking(context, kind);

    return makeJsonResponse(payload, {
      'X-Weather-Data-Source': 'live',
    });
  } catch (error) {
    if (cachedRecord?.payload) {
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
