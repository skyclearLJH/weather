const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const AWS_MINUTE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15];
const AWS_TEMPERATURE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15, 20, 30];
const SLOW_DAILY_RAIN_TIMEOUT_MS = 30000;
const SLOW_DAILY_TEMPERATURE_TIMEOUT_MS = 20000;
const padZero = (value) => value.toString().padStart(2, '0');

const readAuthKey = (context) =>
  context.env?.KMA_AUTH_KEY ||
  context.env?.VITE_KMA_AUTH_KEY ||
  process.env.KMA_AUTH_KEY ||
  process.env.VITE_KMA_AUTH_KEY ||
  '';

const formatKmaMinuteTime = (date) => {
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  const hour = padZero(date.getHours());
  const minute = padZero(date.getMinutes());
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

const fetchKmaText = async (context, path, params = {}, timeoutMs = 12000, cacheTtl = 60) => {
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

  const response = await fetchWithTimeout(
    url.toString(),
    {
      cf: {
        cacheEverything: true,
        cacheTtl,
      },
    },
    timeoutMs,
  );
  const buffer = await response.arrayBuffer();
  return new TextDecoder('euc-kr').decode(buffer);
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
  const now = new Date();
  const candidateTimes = AWS_TEMPERATURE_LOOKBACK_STEPS.map((offset) => subtractMinutes(now, offset));
  return fetchAwsMinuteObservationsByTimes(context, stationMetadata, candidateTimes, hasValidAwsTemperatureObservation);
};

const fetchLatestAwsPrecipitationObservations = (context, stationMetadata) => {
  const now = new Date();
  const candidateTimes = AWS_MINUTE_LOOKBACK_STEPS.map((offset) => subtractMinutes(now, offset));
  return fetchAwsMinuteObservationsByTimes(context, stationMetadata, candidateTimes, hasValidAwsPrecipitationObservation);
};

const getAwsStationMetadata = async (context) => {
  const rawText = await fetchKmaText(
    context,
    'api/typ01/url/stn_inf.php',
    { inf: 'AWS', stn: '', tm: formatStationInfoTime(new Date()), help: 1 },
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

const buildTemperatureToday = async (context, stationMetadata) => {
  const now = new Date();
  const [minDailyRaw, maxDailyRaw] = await Promise.all([
    fetchKmaText(
      context,
      'api/typ01/url/sfc_aws_day.php',
      { tm2: formatKmaDay(now), obs: 'ta_min', stn: 0, disp: 0, help: 1 },
      SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
      300,
    ),
    fetchKmaText(
      context,
      'api/typ01/url/sfc_aws_day.php',
      { tm2: formatKmaDay(now), obs: 'ta_max', stn: 0, disp: 0, help: 1 },
      SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
      300,
    ),
  ]);

  const observedAt = formatKmaMinuteTime(now);
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
  const now = new Date();
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

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function onRequestGet(context) {
  try {
    const requestUrl = new URL(context.request.url);
    const kind = requestUrl.searchParams.get('kind');
    const stationMetadata = await getAwsStationMetadata(context);
    let payload;

    if (kind === 'temperature-current') {
      payload = await buildTemperatureCurrent(context, stationMetadata);
    } else if (kind === 'temperature-today') {
      payload = await buildTemperatureToday(context, stationMetadata);
    } else if (kind === 'precipitation-current') {
      payload = await buildPrecipitationCurrent(context, stationMetadata);
    } else if (kind === 'precipitation-since-yesterday') {
      payload = await buildPrecipitationSinceYesterday(context, stationMetadata);
    } else {
      return new Response(JSON.stringify({ error: 'Invalid rankings kind.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Cache-Control': 'public, max-age=30, s-maxage=60',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
