import { REGIONS } from '../data/mockData';
import { KMA_SNOW_LAW_ADDRESS_MAP } from '../data/kmaSnowLawAddressMap';
import { KMA_PROXY_BASE } from '../utils/constants';

const padZero = (value) => value.toString().padStart(2, '0');
const REQUEST_TIMEOUT_MS = 12000;
const REQUEST_RETRY_COUNT = 1;
const AWS_MINUTE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15];
const AWS_TEMPERATURE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15, 20, 30];
const AWS_MINUTE_REQUEST_TIMEOUT_MS = 6000;
const COMMENTARY_LOOKBACK_HOURS = [12, 24, 48, 72];
const DOC_ISSUANCE_HOURS = [5, 11, 17];
const SLOW_DAILY_RAIN_TIMEOUT_MS = 30000;
const SLOW_DAILY_TEMPERATURE_TIMEOUT_MS = 20000;
const TEXT_CACHE = new Map();
const TEXT_IN_FLIGHT = new Map();
const DATA_CACHE = new Map();
const DATA_IN_FLIGHT = new Map();
const LAST_SUCCESS_DATA = new Map();
const SNOW_DATA_CACHE_VERSION = 'v2';
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
const TTL = {
  awsMinute: 60 * 1000,
  awsDaily: 5 * 60 * 1000,
  commentary: 3 * 60 * 1000,
  doc: 3 * 60 * 1000,
  snow: 60 * 1000,
  snowHistory: 24 * 60 * 60 * 1000,
  stationInfo: 24 * 60 * 60 * 1000,
  warnings: 60 * 1000,
};

const formatKmaMinuteTime = (date) => {
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1);
  const day = padZero(date.getDate());
  const hour = padZero(date.getHours());
  const minute = padZero(date.getMinutes());
  return `${year}${month}${day}${hour}${minute}`;
};

const formatKmaHourTime = (date) => formatKmaMinuteTime(date).slice(0, 10);

const subtractMinutes = (date, minutes) => new Date(date.getTime() - minutes * 60 * 1000);
const subtractHours = (date, hours) => new Date(date.getTime() - hours * 60 * 60 * 1000);
const subtractDays = (date, days) => new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
const formatKmaDay = (date) => formatKmaMinuteTime(date).slice(0, 8);
const formatStationInfoTime = (date) => formatKmaMinuteTime(date).slice(0, 10) + '00';
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

const getStnByRegion = (regionId) => {
  const stnMap = {
    all: 108,
    hq: 109,
    daejeon: 133,
    cheongju: 131,
    jeonju: 146,
    gwangju: 156,
    jeju: 184,
    chuncheon: 105,
    daegu: 143,
    busan: 159,
    changwon: 159,
  };

  return stnMap[regionId] ?? 108;
};

const getIssuingOfficeName = (stn) => {
  const officeMap = {
    108: '기상청',
    109: '수도권기상청',
    133: '대전지방기상청',
    131: '청주기상지청',
    146: '전주기상지청',
    156: '광주지방기상청',
    184: '제주지방기상청',
    105: '강원지방기상청',
    143: '대구지방기상청',
    159: '부산지방기상청',
  };

  return officeMap[stn] ?? '기상청';
};

const buildKmaUrl = (path, params = {}) => {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `${KMA_PROXY_BASE}/${path}${query ? `?${query}` : ''}`;
};

const buildAppUrl = (path, params = {}) => {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  return `${path}${query ? `?${query}` : ''}`;
};

const buildCacheKey = (path, params = {}) => `${path}?${new URLSearchParams(params).toString()}`;

const getCachedValue = (cache, key) => {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return cached.value;
};

const setCachedValue = (cache, key, value, ttlMs) => {
  if (ttlMs <= 0) {
    return value;
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });

  return value;
};

export const clearWeatherApiCaches = () => {
  TEXT_CACHE.clear();
  DATA_CACHE.clear();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithRetry = async (url, options = {}, retryCount = REQUEST_RETRY_COUNT, timeoutMs = REQUEST_TIMEOUT_MS) => {
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
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
    } catch (error) {
      if (attempt === retryCount) {
        throw error;
      }

      await sleep(300 * (attempt + 1));
    } finally {
      clearTimeout(timerId);
    }
  }

  throw new Error('Request failed.');
};

const withRefreshParam = (params = {}, refreshToken = '') => {
  if (!refreshToken) {
    return params;
  }

  return {
    ...params,
    _refresh: refreshToken,
  };
};

const fetchKmaArrayBuffer = async (path, params = {}, options = {}) => {
  const response = await fetchWithRetry(
    buildKmaUrl(path, withRefreshParam(params, options.refreshToken)),
    options.refreshToken ? { cache: 'no-store' } : {},
    options.retryCount ?? REQUEST_RETRY_COUNT,
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  return response.arrayBuffer();
};

const fetchKmaText = async (path, params = {}, options = {}) => {
  const {
    ttlMs = 0,
    cacheKey = buildCacheKey(path, params),
    retryCount = REQUEST_RETRY_COUNT,
    timeoutMs = REQUEST_TIMEOUT_MS,
    refreshToken = '',
  } = options;

  if (!refreshToken) {
    const cachedValue = getCachedValue(TEXT_CACHE, cacheKey);
    if (cachedValue !== null) {
      return cachedValue;
    }

    if (TEXT_IN_FLIGHT.has(cacheKey)) {
      return TEXT_IN_FLIGHT.get(cacheKey);
    }
  }

  const requestPromise = fetchKmaArrayBuffer(path, params, { retryCount, timeoutMs, refreshToken })
    .then((buffer) => {
      const decoded = new TextDecoder('euc-kr').decode(buffer);
      return setCachedValue(TEXT_CACHE, cacheKey, decoded, ttlMs);
    })
    .finally(() => {
      TEXT_IN_FLIGHT.delete(cacheKey);
    });

  TEXT_IN_FLIGHT.set(cacheKey, requestPromise);
  return requestPromise;
};

let awsStationMetadataPromise = null;

const withDataCache = async (cacheKey, ttlMs, loader, options = {}) => {
  const effectiveCacheKey = options.refreshToken
    ? `${cacheKey}:refresh:${options.refreshToken}`
    : cacheKey;
  const cachedValue = getCachedValue(DATA_CACHE, effectiveCacheKey);
  if (cachedValue !== null) {
    return cachedValue;
  }

  if (DATA_IN_FLIGHT.has(effectiveCacheKey)) {
    return DATA_IN_FLIGHT.get(effectiveCacheKey);
  }

  const requestPromise = loader()
    .then((value) => setCachedValue(DATA_CACHE, effectiveCacheKey, value, ttlMs))
    .finally(() => {
      DATA_IN_FLIGHT.delete(effectiveCacheKey);
    });

  DATA_IN_FLIGHT.set(effectiveCacheKey, requestPromise);
  return requestPromise;
};

const isFiniteObservation = (value) => Number.isFinite(value) && value > -50;
const isHeatWarningSupportedStation = (stationId) =>
  !HEAT_WARNING_UNSUPPORTED_AWS_STATION_IDS.has(String(stationId));

const parseNumericValue = (value) => {
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const buildRankingRows = (items, unit, sortDirection = 'desc') =>
  [...items]
    .sort((left, right) => {
      if (sortDirection === 'asc') {
        return left.value - right.value;
      }
      return right.value - left.value;
    })
    .map((item, index) => ({
      rank: index + 1,
      name: item.name,
      record: `${item.value.toFixed(1)}${unit}`,
      address: item.address,
    }));

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
    const lawAddress = fields
      .slice(13)
      .join(' ')
      .replace(/^\d+\s+/, '')
      .trim();

    stationMetadata.set(stationId, {
      name: stationName,
      address: lawAddress || stationName,
    });
  });

  return stationMetadata;
};

const fetchAwsStationMetadata = async () => {
  if (!awsStationMetadataPromise) {
    awsStationMetadataPromise = fetchKmaText('api/typ01/url/stn_inf.php', {
      inf: 'AWS',
      stn: '',
      tm: formatStationInfoTime(new Date()),
      help: 1,
    }, {
      ttlMs: TTL.stationInfo,
      cacheKey: 'aws-station-metadata',
    })
      .then(parseAwsStationMetadata)
      .catch((error) => {
        awsStationMetadataPromise = null;
        throw error;
      });
  }

  return awsStationMetadataPromise;
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

const hasValidAwsTemperatureObservation = (rows) =>
  rows.some((item) => isFiniteObservation(item.temperature));

const hasValidAwsPrecipitationObservation = (rows) =>
  rows.some((item) => item.precipitationOneHour >= 0 || item.precipitationToday >= 0);

const fetchAwsMinuteObservationCandidate = async (stationMetadata, candidateTime, validator) => {
  const observedAt = formatKmaMinuteTime(candidateTime);
  const rawText = await fetchKmaText('api/typ01/cgi-bin/url/nph-aws2_min', {
    tm2: observedAt,
    stn: 0,
    disp: 0,
    help: 0,
  }, {
    ttlMs: TTL.awsMinute,
    timeoutMs: AWS_MINUTE_REQUEST_TIMEOUT_MS,
  });
  const rows = parseAwsMinuteObservations(rawText, stationMetadata);
  return validator(rows) ? { observedAt, rows } : null;
};

const fetchAwsMinuteObservationsByTimes = async (stationMetadata, candidateTimes, validator) => {
  let lastError = null;

  for (const candidateTime of candidateTimes) {
    try {
      const result = await fetchAwsMinuteObservationCandidate(stationMetadata, candidateTime, validator);
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

const fetchLatestAwsMinuteObservations = async (stationMetadata, validator) => {
  const now = new Date();
  const candidateTimes = AWS_MINUTE_LOOKBACK_STEPS.map((offsetMinutes) => subtractMinutes(now, offsetMinutes));

  return fetchAwsMinuteObservationsByTimes(stationMetadata, candidateTimes, validator);
};

const fetchLatestAwsTemperatureObservations = async (stationMetadata) => {
  const now = new Date();
  const candidateTimes = AWS_TEMPERATURE_LOOKBACK_STEPS.map((offsetMinutes) => subtractMinutes(now, offsetMinutes));

  return fetchAwsMinuteObservationsByTimes(
    stationMetadata,
    candidateTimes,
    hasValidAwsTemperatureObservation,
  );
};

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

const parseSnowObservationFields = (line) => {
  const normalizedLine = line.trim().replace(/,?=$/, '');
  if (!normalizedLine || normalizedLine.startsWith('#')) {
    return null;
  }

  return normalizedLine.includes(',')
    ? normalizedLine.split(',').map((field) => field.trim())
    : normalizedLine.split(/\s+/);
};

const parseSnowObservations = (rawText, stationMetadata) =>
  rawText
    .split('\n')
    .map(parseSnowObservationFields)
    .filter((fields) => fields?.length >= 7)
    .map((fields) => {
      const stationId = fields[1];
      const metadata = stationMetadata.get(stationId) ?? { name: fields[2], address: fields[2] };
      const snowValue = parseNumericValue(fields[6]);

      return {
        name: metadata.name,
        address: metadata.address,
        value: snowValue,
      };
    });

const parseSnowStationMetadata = (rawText) => {
  const stationMetadata = new Map();

  rawText.split('\n').forEach((line) => {
    if (!line || line.trim().startsWith('#')) {
      return;
    }

    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) {
      return;
    }

    const stationId = fields[0];
    const stationName = fields[6];
    const legalCode = fields.find((field) => /^\d{10}$/.test(field)) ?? fields[8];
    const address = KMA_SNOW_LAW_ADDRESS_MAP[legalCode] ?? stationName;

    stationMetadata.set(stationId, { name: stationName, address });
  });

  return stationMetadata;
};

const buildSnowRankingRows = (rawText, stationMetadata) =>
  parseSnowObservations(rawText, stationMetadata)
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((item, index) => ({
      rank: index + 1,
      name: item.name,
      record: `${item.value.toFixed(1)}cm`,
      address: item.address,
    }));

export const fetchTemperatureCurrentRankings = async () =>
  withDataCache('temperature-current-rankings', TTL.awsMinute, async () => {
    try {
      const stationMetadata = await fetchAwsStationMetadata();
      const { observedAt, rows: currentRows } = await fetchLatestAwsTemperatureObservations(stationMetadata);

      return {
        observedAt,
        observedLabel: formatDisplayKoreanDateTime(observedAt),
        minCurrent: buildRankingRows(
          currentRows
            .filter((item) => isFiniteObservation(item.temperature))
            .map((item) => ({ name: item.name, address: item.address, value: item.temperature })),
          '°C',
          'asc',
        ),
        maxCurrent: buildRankingRows(
          currentRows
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
    } catch (error) {
      console.error('[API Fetch Error] 현재 기온 랭킹 실패', error);
      throw new Error('현재 기온 랭킹 데이터를 불러오지 못했습니다.');
    }
  });

export const fetchTemperatureTodayRankings = async () =>
  withDataCache('temperature-today-rankings', TTL.awsDaily, async () => {
    try {
      const now = new Date();
      const stationMetadata = await fetchAwsStationMetadata();
      const [minDailyRaw, maxDailyRaw] = await Promise.all([
        fetchKmaText('api/typ01/url/sfc_aws_day.php', {
          tm2: formatKmaDay(now),
          obs: 'ta_min',
          stn: 0,
          disp: 0,
          help: 1,
        }, {
          ttlMs: TTL.awsDaily,
          timeoutMs: SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
        }),
        fetchKmaText('api/typ01/url/sfc_aws_day.php', {
          tm2: formatKmaDay(now),
          obs: 'ta_max',
          stn: 0,
          disp: 0,
          help: 1,
        }, {
          ttlMs: TTL.awsDaily,
          timeoutMs: SLOW_DAILY_TEMPERATURE_TIMEOUT_MS,
        }),
      ]);

      const observedAt = formatKmaMinuteTime(now);
      const dailyMinRows = parseAwsDailyObservations(minDailyRaw, stationMetadata);
      const dailyMaxRows = parseAwsDailyObservations(maxDailyRaw, stationMetadata);

      return {
        observedAt,
        observedLabel: formatDisplayKoreanDateTime(observedAt),
        minToday: buildRankingRows(
          dailyMinRows
            .filter((item) => isFiniteObservation(item.value))
            .map((item) => ({ name: item.name, address: item.address, value: item.value })),
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
    } catch (error) {
      console.error('[API Fetch Error] 오늘 기온 랭킹 실패', error);
      throw new Error('오늘 기온 랭킹 데이터를 불러오지 못했습니다.');
    }
  });

export const fetchPrecipitationCurrentRankings = async () =>
  withDataCache('precipitation-current-rankings', TTL.awsMinute, async () => {
    try {
      const stationMetadata = await fetchAwsStationMetadata();
      const { observedAt, rows: currentRows } = await fetchLatestAwsMinuteObservations(
        stationMetadata,
        hasValidAwsPrecipitationObservation,
      );

      return {
        observedAt,
        observedLabel: formatDisplayKoreanDateTime(observedAt),
        oneHour: buildRankingRows(
          currentRows
            .filter((item) => item.precipitationOneHour > 0)
            .map((item) => ({
              name: item.name,
              address: item.address,
              value: item.precipitationOneHour,
            })),
          'mm',
          'desc',
        ),
        today: buildRankingRows(
          currentRows
            .filter((item) => item.precipitationToday > 0)
            .map((item) => ({
              name: item.name,
              address: item.address,
              value: item.precipitationToday,
            })),
          'mm',
          'desc',
        ),
      };
    } catch (error) {
      console.error('[API Fetch Error] 현재 강수 랭킹 실패', error);
      throw new Error('강수량 랭킹 데이터를 불러오지 못했습니다.');
    }
  });

export const fetchPrecipitationSinceYesterdayRankings = async () =>
  withDataCache('precipitation-since-yesterday-rankings', TTL.awsMinute, async () => {
    try {
      const now = new Date();
      const yesterday = subtractDays(now, 1);
      const stationMetadata = await fetchAwsStationMetadata();

      const yesterdayDailyRaw = await fetchKmaText('api/typ01/url/sfc_aws_day.php', {
          tm2: formatKmaDay(yesterday),
          obs: 'rn_day',
          stn: 0,
          disp: 0,
          help: 0,
        }, {
          ttlMs: TTL.awsDaily,
          timeoutMs: SLOW_DAILY_RAIN_TIMEOUT_MS,
        });

      let observedAt = formatKmaMinuteTime(now);
      let currentRows = [];

      try {
        const latestCurrent = await fetchLatestAwsMinuteObservations(
          stationMetadata,
          hasValidAwsPrecipitationObservation,
        );
        observedAt = latestCurrent.observedAt;
        currentRows = latestCurrent.rows;
      } catch (error) {
        console.warn('[API Fetch Warning] 현재 강수 분자료를 찾지 못해 어제 일강수량만으로 표출합니다.', error);
      }

      const yesterdayDailyRows = parseAwsDailyObservations(yesterdayDailyRaw, stationMetadata);
      const yesterdayMap = new Map(
        yesterdayDailyRows.map((item) => [item.stationId, Math.max(0, item.value)]),
      );
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
    } catch (error) {
      console.error('[API Fetch Error] 어제부터 누적 강수 랭킹 실패', error);
      throw new Error('어제부터 누적 강수량 데이터를 불러오지 못했습니다.');
    }
  });

const normalizeReportText = (content) =>
  content
    .replace(/#/g, '\n\n')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^[ \t]+/g, '').replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/7777END/g, '')
    .replace(/[=\s]+$/g, '')
    .trim();

const parseKmaReport = (rawData, targetStn, titleFieldIndex) => {
  if (!rawData) {
    return { content: '', tmfc: '' };
  }

  const blocks = rawData
    .split('$')
    .map((block) => block.trim())
    .filter(Boolean);

  const reportsByTmfc = new Map();
  let activeReport = null;

  for (const block of blocks) {
    const fields = block.split('#');
    const recordIndex = fields[0];

    if (recordIndex === '0') {
      const stn = Number.parseInt(fields[1], 10);
      const tmfc = fields[2];

      if (stn === targetStn || (targetStn === 0 && stn === 108)) {
        const title = fields.slice(titleFieldIndex).join('#').trim();
        const payload = { tmfc, contentParts: [title] };

        if (!reportsByTmfc.has(tmfc)) {
          reportsByTmfc.set(tmfc, []);
        }

        reportsByTmfc.get(tmfc).push(payload);
        activeReport = payload;
      } else {
        activeReport = null;
      }
    } else if (activeReport && !Number.isNaN(Number.parseInt(recordIndex, 10))) {
      const fragment = fields.slice(1).join('#').trim();
      if (fragment) {
        activeReport.contentParts.push(fragment);
      }
    }
  }

  const latestTmfc = [...reportsByTmfc.keys()].sort().reverse()[0];
  if (!latestTmfc) {
    return { content: '', tmfc: '' };
  }

  const latestReport = reportsByTmfc.get(latestTmfc)?.[0];
  return {
    content: normalizeReportText(latestReport?.contentParts.join('\n\n') ?? ''),
    tmfc: latestTmfc,
  };
};

const formatDisplayTime = (tmfc) => {
  if (!tmfc || tmfc.length < 10) {
    return '';
  }

  const year = tmfc.slice(0, 4);
  const month = tmfc.slice(4, 6);
  const day = tmfc.slice(6, 8);
  const hour = tmfc.slice(8, 10);
  const minute = tmfc.length >= 12 ? tmfc.slice(10, 12) : '00';
  return `${year}.${month}.${day} ${hour}:${minute} 발표`;
};

const KNOWN_LAND_BROAD_REGIONS = new Set([
  '서울',
  '인천',
  '경기',
  '강원',
  '충북',
  '충남',
  '대전',
  '세종',
  '전북',
  '전남광주',
  '경북',
  '경남',
  '대구',
  '울산',
  '부산',
  '제주',
]);
const WARNING_SPECIAL_CITY_ORDER = ['서울'];
const WARNING_METROPOLITAN_CITY_ORDER = ['인천', '대전', '세종', '전남광주', '대구', '부산', '울산'];
const WARNING_PROVINCE_ORDER = ['경기', '강원', '충북', '충남', '전북', '경북', '경남', '제주'];
const WARNING_SELECTED_BROAD_REGION_ORDER = [
  ...WARNING_SPECIAL_CITY_ORDER,
  ...WARNING_METROPOLITAN_CITY_ORDER,
  ...WARNING_PROVINCE_ORDER,
];
const WARNING_NATIONWIDE_BROAD_REGION_ORDER = [
  '서울',
  '인천',
  '경기',
  '강원',
  '대전',
  '세종',
  '충북',
  '충남',
  '전남광주',
  '전북',
  '대구',
  '부산',
  '울산',
  '경북',
  '경남',
  '제주',
];
const createRegionOrderMap = (regions) => new Map(regions.map((region, index) => [region, index]));
const WARNING_SELECTED_BROAD_REGION_ORDER_MAP = createRegionOrderMap(WARNING_SELECTED_BROAD_REGION_ORDER);
const WARNING_NATIONWIDE_BROAD_REGION_ORDER_MAP = createRegionOrderMap(WARNING_NATIONWIDE_BROAD_REGION_ORDER);
const METROPOLITAN_DETAIL_SORT_REGIONS = new Set([
  '서울',
  '인천',
  '대전',
  '대구',
  '부산',
  '울산',
  '전남광주',
  '제주',
]);
const LAND_BROAD_REGION_RULES = [
  { broad: '서울', pattern: /^서울/ },
  { broad: '인천', pattern: /^인천/ },
  { broad: '대전', pattern: /^대전/ },
  { broad: '대구', pattern: /^(대구|달성|군위)(시|군)?/ },
  { broad: '부산', pattern: /^부산/ },
  { broad: '울산', pattern: /^울산/ },
  { broad: '전남광주', pattern: /^광주(광역|동부|서부|남부|북부|중부)/ },
  { broad: '세종', pattern: /^세종/ },
  { broad: '제주', pattern: /^(제주|서귀포)(시)?/ },
  {
    broad: '경남',
    pattern: /^(창원|김해|함안|진주|밀양|창녕|양산|의령|하동|산청|함양|거창|합천|통영|사천|거제|고성|남해)(시|군)?/,
  },
  {
    broad: '경북',
    pattern: /^(포항|경주|김천|안동|구미|영주|영천|상주|문경|경산|의성|청송|영양|영덕|청도|고령|성주|칠곡|예천|봉화|울진|울릉)(시|군)?/,
  },
  {
    broad: '전남광주',
    pattern: /^(목포|여수|순천|나주|광양|담양|곡성|구례|고흥|보성|화순|장흥|강진|해남|영암|무안|함평|영광|장성|완도|진도|신안)(시|군)?/,
  },
  {
    broad: '전북',
    pattern: /^(전주|군산|익산|정읍|남원|김제|완주|진안|무주|장수|임실|순창|고창|부안)(시|군)?/,
  },
  {
    broad: '충남',
    pattern: /^(천안|공주|보령|아산|서산|논산|계룡|당진|금산|부여|서천|청양|홍성|예산|태안)(시|군)?/,
  },
  {
    broad: '충북',
    pattern: /^(청주|충주|제천|보은|옥천|영동|증평|진천|괴산|음성|단양)(시|군)?/,
  },
  {
    broad: '강원',
    pattern: /^(춘천|원주|강릉|동해|태백|속초|삼척|홍천|횡성|영월|평창|정선|철원|화천|양구|인제|고성|양양)(시|군)?/,
  },
  {
    broad: '경기',
    pattern: /^(수원|성남|의정부|안양|부천|광명|평택|동두천|안산|고양|과천|구리|남양주|오산|시흥|군포|의왕|하남|용인|파주|이천|안성|김포|화성|광주|양주|포천|여주|연천|가평|양평)(시|군)?/,
  },
];

const normalizeBroadRegionName = (value = '') =>
  value
    .replace('경상북도', '경북')
    .replace('경상남도', '경남')
    .replace('전북특별자치도', '전북')
    .replace('전라북도', '전북')
    .replace('전라남도', '전남')
    .replace('충청북도', '충북')
    .replace('충청남도', '충남')
    .replace('제주도', '제주')
    .replace('특별자치도', '')
    .replace('특별시', '')
    .replace('광역시', '')
    .trim();

const getLandBroadRegionFromDetail = (value = '') => {
  const normalizedValue = normalizeBroadRegionName(value).replace(/\s+/g, '');
  return LAND_BROAD_REGION_RULES.find((rule) => rule.pattern.test(normalizedValue))?.broad ?? '';
};

const getBroadRegion = (upperRegion, detailRegion) => {
  const combined = `${upperRegion} ${detailRegion}`;

  if (combined.includes('서해') && combined.includes('앞바다')) return '서해 앞바다';
  if (combined.includes('서해') && combined.includes('먼바다')) return '서해 먼바다';
  if (combined.includes('남해') && combined.includes('앞바다')) return '남해 앞바다';
  if (combined.includes('남해') && combined.includes('먼바다')) return '남해 먼바다';
  if (combined.includes('동해') && combined.includes('앞바다')) return '동해 앞바다';
  if (combined.includes('동해') && combined.includes('먼바다')) return '동해 먼바다';
  if (combined.includes('제주도') && combined.includes('앞바다')) return '제주도 앞바다';
  if (combined.includes('제주도') && combined.includes('먼바다')) return '제주도 먼바다';
  if (combined.includes('울릉도') || combined.includes('독도')) return '경북';
  if (combined.includes('흑산도') || combined.includes('홍도')) return '전남광주';
  if (combined.includes('서해5도')) return '인천';

  const normalizedUpperRegion = normalizeBroadRegionName(upperRegion);
  if (normalizedUpperRegion === '전남' || normalizedUpperRegion === '광주') {
    return '전남광주';
  }

  if (KNOWN_LAND_BROAD_REGIONS.has(normalizedUpperRegion)) {
    return normalizedUpperRegion;
  }

  return (
    getLandBroadRegionFromDetail(detailRegion) ||
    getLandBroadRegionFromDetail(upperRegion) ||
    normalizedUpperRegion
  );
};

const formatDetailOcean = (value) =>
  value
    .replace(/^(서해|남해|동해|제주도)/, '')
    .replace(/\s+/g, ' ')
    .replace(/먼바다/g, '먼바다')
    .replace(/앞바다/g, '앞바다')
    .trim();

const formatDetailLand = (value) =>
  value
    .replace(
      /^(강원도|경기도|충청북도|충청남도|전라북도|전북특별자치도|전라남도|경상북도|경상남도|제주도|서울특별시|인천광역시|대전광역시|대구광역시|부산광역시|울산광역시|광주광역시|세종특별자치시)/,
      '',
    )
    .trim();

const stripRepeatedBroadRegionPrefix = (detailRegion, broadRegion) => {
  const detail = detailRegion.trim();
  const broadAliases = broadRegion === '제주' ? ['제주도'] : [broadRegion];
  const matchedAlias = broadAliases.find((alias) => detail.startsWith(alias) && detail.length > alias.length);
  return matchedAlias ? detail.slice(matchedAlias.length).trim() : detail;
};

const METROPOLITAN_COUNTY_DETAIL_ORDER = ['달성군', '군위군', '울주군', '기장군', '강화군', '옹진군'];

const getMetropolitanCountyDetailOrder = (detail) =>
  METROPOLITAN_COUNTY_DETAIL_ORDER.findIndex((countyName) => detail.startsWith(countyName));

const sortDetailsForDisplay = (broadRegion, details) => {
  if (!METROPOLITAN_DETAIL_SORT_REGIONS.has(broadRegion)) {
    return details;
  }

  return details
    .map((detail, index) => ({ detail, index }))
    .sort((left, right) => {
      if (broadRegion === '전남광주') {
        const metropolitanOrder = Number(right.detail.startsWith('광주')) - Number(left.detail.startsWith('광주'));
        if (metropolitanOrder) {
          return metropolitanOrder;
        }
      }

      const leftCountyOrder = getMetropolitanCountyDetailOrder(left.detail);
      const rightCountyOrder = getMetropolitanCountyDetailOrder(right.detail);
      const countyGroupOrder = Number(leftCountyOrder >= 0) - Number(rightCountyOrder >= 0);
      const countyDetailOrder =
        leftCountyOrder >= 0 && rightCountyOrder >= 0 ? leftCountyOrder - rightCountyOrder : 0;
      return countyGroupOrder || countyDetailOrder || left.index - right.index;
    })
    .map((item) => item.detail);
};

const sortWarningBroadRegionEntries = (entries, regionId) => {
  const orderMap =
    regionId === 'all'
      ? WARNING_NATIONWIDE_BROAD_REGION_ORDER_MAP
      : WARNING_SELECTED_BROAD_REGION_ORDER_MAP;

  return entries
    .map((entry, index) => ({
      entry,
      index,
      order: orderMap.get(entry[0]) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map((item) => item.entry);
};

const getRegionParenthesisSeparator = () => ' ';

// 행정구역상 같은 시군이지만 기상청 특보구역 계층에서는 분리되어 있는 섬 구역들.
// 구성 구역이 모두 발령되면 시군명(전 지역)으로 축약한다.
const WARNING_CITY_UNION_RULES = [
  { name: '신안군', zoneNames: ['신안군(흑산면제외)', '흑산도.홍도'] },
  { name: '여수시', zoneNames: ['여수시', '거문도.초도'] },
  { name: '옹진군', zoneNames: ['옹진군', '백령도.대청도', '연평도.우도'] },
];

const isWarningLeafZone = (regSp = '') => regSp.endsWith('13') || regSp.endsWith('14');
const isSubdividedCityZone = (regSp = '') => regSp.endsWith('03');

const parseWarningRegionZones = (rawText) => {
  const nowTm = formatKmaMinuteTime(new Date());
  const zones = new Map();

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const match = trimmed.match(/^(L\S+)\s+(\d{12})\s+(\d{12})\s+(\d{8})\s+(\S+)\s+(.+)$/);
    if (!match) {
      return;
    }

    const [, regId, tmSt, tmEd, regSp, parentId, namePart] = match;
    if (tmSt > nowTm || tmEd < nowTm) {
      return;
    }

    // REG_KO와 REG_NAME은 2칸 이상의 공백으로 구분된다(이름 안의 공백은 1칸).
    const nameFields = namePart
      .split(/\s{2,}/)
      .map((item) => item.trim())
      .filter(Boolean);

    zones.set(regId, {
      regSp,
      parentId,
      name: nameFields[nameFields.length - 1] || nameFields[0] || regId,
    });
  });

  return zones;
};

const buildWarningRegionIndex = (zones) => {
  const childIdsByParent = new Map();
  zones.forEach((zone, regId) => {
    if (!childIdsByParent.has(zone.parentId)) {
      childIdsByParent.set(zone.parentId, []);
    }
    childIdsByParent.get(zone.parentId).push(regId);
  });

  const broadLeafIds = new Map();
  const leafIdsByName = new Map();
  zones.forEach((zone, regId) => {
    if (!isWarningLeafZone(zone.regSp)) {
      return;
    }

    const parentName = zones.get(zone.parentId)?.name ?? '';
    const broad = getBroadRegion(parentName, zone.name);
    if (KNOWN_LAND_BROAD_REGIONS.has(broad)) {
      if (!broadLeafIds.has(broad)) {
        broadLeafIds.set(broad, new Set());
      }
      broadLeafIds.get(broad).add(regId);
    }

    if (!leafIdsByName.has(zone.name)) {
      leafIdsByName.set(zone.name, regId);
    }
  });

  // 하위 권역이 모두 발령 대상 구역(leaf)인 시군/도서 그룹만 축약 후보로 삼는다.
  // 인천처럼 중간 그룹이 섞여 있으면 leaf 자식만으로는 전체가 아니므로 제외한다.
  const cityGroups = [];
  childIdsByParent.forEach((ids, parentId) => {
    const parent = zones.get(parentId);
    if (!parent) {
      return;
    }

    const isCityParent = isSubdividedCityZone(parent.regSp) || parent.regSp === '00000102';
    if (!isCityParent) {
      return;
    }

    const leafIds = ids.filter((id) => isWarningLeafZone(zones.get(id)?.regSp ?? ''));
    if (leafIds.length < 2 || leafIds.length !== ids.length) {
      return;
    }

    cityGroups.push({ name: parent.name, memberIds: new Set(leafIds) });
  });

  WARNING_CITY_UNION_RULES.forEach(({ name, zoneNames }) => {
    const memberIds = zoneNames.map((zoneName) => leafIdsByName.get(zoneName)).filter(Boolean);
    if (memberIds.length === zoneNames.length) {
      cityGroups.push({ name, memberIds: new Set(memberIds) });
    }
  });

  // 구성원이 많은 그룹부터 적용해, 겹치는 그룹(예: 옹진군 ↔ 서해5도)에서
  // 더 넓은 축약이 우선되도록 한다.
  cityGroups.sort((left, right) => right.memberIds.size - left.memberIds.size);

  return { broadLeafIds, cityGroups };
};

let warningRegionIndexPromise = null;

const fetchWarningRegionIndex = async () => {
  if (!warningRegionIndexPromise) {
    warningRegionIndexPromise = fetchKmaText('api/typ01/url/wrn_reg.php', { tmfc: 0 }, {
      ttlMs: TTL.stationInfo,
      cacheKey: 'warning-region-list',
      timeoutMs: 9000,
    })
      .then((rawText) => buildWarningRegionIndex(parseWarningRegionZones(rawText)))
      .catch((error) => {
        warningRegionIndexPromise = null;
        throw error;
      });
  }

  return warningRegionIndexPromise;
};

const collapseWarningRegionDetails = (broadRegion, detailEntries, regionIndex) => {
  const allDetails = [...new Set([...detailEntries.values()].filter(Boolean))];
  if (!regionIndex || !KNOWN_LAND_BROAD_REGIONS.has(broadRegion)) {
    return { isEntireBroadRegion: false, details: allDetails };
  }

  const issuedIds = new Set([...detailEntries.keys()].filter((key) => key.startsWith('L')));
  const broadIds = regionIndex.broadLeafIds.get(broadRegion);
  if (broadIds && broadIds.size >= 2 && [...broadIds].every((id) => issuedIds.has(id))) {
    return { isEntireBroadRegion: true, details: [] };
  }

  const consumed = new Set();
  const labelByEntryKey = new Map();
  regionIndex.cityGroups.forEach((group) => {
    const memberIds = [...group.memberIds];
    if (!memberIds.every((id) => issuedIds.has(id) && !consumed.has(id))) {
      return;
    }

    const firstKey = [...detailEntries.keys()].find((key) => group.memberIds.has(key));
    memberIds.forEach((id) => consumed.add(id));
    labelByEntryKey.set(firstKey, group.name);
  });

  if (labelByEntryKey.size === 0) {
    return { isEntireBroadRegion: false, details: allDetails };
  }

  const details = [...detailEntries.entries()]
    .map(([key, detail]) => labelByEntryKey.get(key) ?? (consumed.has(key) ? null : detail))
    .filter(Boolean);
  return { isEntireBroadRegion: false, details: [...new Set(details)] };
};

// 전국 보기: 특별·광역시 + KBS 총국·을지국 소재 도시 (북→남 순서)
const NATIONAL_TEMP_CITIES = [
  { id: '11B10101', name: '서울' },
  { id: '11B20201', name: '인천' },
  { id: '11D10301', name: '춘천' },
  { id: '11D10401', name: '원주' },
  { id: '11D20501', name: '강릉' },
  { id: '11C10301', name: '청주' },
  { id: '11C10101', name: '충주' },
  { id: '11C20404', name: '세종' },
  { id: '11C20401', name: '대전' },
  { id: '11F10201', name: '전주' },
  { id: '11F20501', name: '광주' },
  { id: '21F20801', name: '목포' },
  { id: '11F20405', name: '순천' },
  { id: '11H10701', name: '대구' },
  { id: '11H10501', name: '안동' },
  { id: '11H10201', name: '포항' },
  { id: '11H20201', name: '부산' },
  { id: '11H20101', name: '울산' },
  { id: '11H20301', name: '창원' },
  { id: '11H20701', name: '진주' },
  { id: '11G00201', name: '제주' },
];

const REGION_TEMP_PRIORITY_ZONE_ORDER = new Map(
  NATIONAL_TEMP_CITIES.map(({ id }, index) => [id, index]),
);

// 예보구역코드 앞자리로 총국 권역을 가른다. 부산총국만 도시 단위(부산·울산)로 지정한다.
const REGION_TEMP_ZONE_FILTERS = {
  hq: { prefixes: ['11B', '11A'] },
  chuncheon: { prefixes: ['11D'] },
  daejeon: { prefixes: ['11C2'] },
  cheongju: { prefixes: ['11C1'] },
  jeonju: { prefixes: ['11F1', '21F1'] },
  gwangju: { prefixes: ['11F2', '21F2'] },
  jeju: { prefixes: ['11G'] },
  daegu: { prefixes: ['11H1', '11E'] },
  busan: { ids: ['11H20201', '11H20101'] },
  changwon: { prefixes: ['11H2'], excludeIds: ['11H20201', '11H20101'] },
};

const REGION_TEMP_EXCLUDED_ZONE_IDS = new Set([
  '11F20603', // 순천(구역 중복, 순천시 구역 사용)
  '11H20406', // 하동(해안) — 통합 구역인 하동으로 표기
  '11H20702', // 하동(내륙)
  '21F20202', // 해남(화원) — 해남으로 표기
  '11G00601', // 이어도
]);

const parseForecastCityZones = (rawText) => {
  const nowTm = formatKmaMinuteTime(new Date());
  const zones = [];

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length < 5) {
      return;
    }

    const [regId, tmSt, tmEd, regSp] = fields;
    if (regSp !== 'C' || tmSt > nowTm || tmEd < nowTm) {
      return;
    }

    zones.push({ id: regId, name: fields.slice(4).join(' ').trim() });
  });

  return zones;
};

let forecastCityZonesPromise = null;

const fetchForecastCityZones = async () => {
  if (!forecastCityZonesPromise) {
    forecastCityZonesPromise = fetchKmaText('api/typ01/url/fct_shrt_reg.php', { tmfc: 0 }, {
      ttlMs: TTL.stationInfo,
      cacheKey: 'forecast-city-zones',
      timeoutMs: 9000,
    })
      .then(parseForecastCityZones)
      .catch((error) => {
        forecastCityZonesPromise = null;
        throw error;
      });
  }

  return forecastCityZonesPromise;
};

// 육상 단기예보에서 구역별 최신 발표의 발효시각별 기온(TA)을 뽑는다.
// 발효 00시 구간의 TA가 아침 최저기온, 12시 구간의 TA가 낮 최고기온이다.
const parseLandForecastTemps = (rawText) => {
  const byRegion = new Map();

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length < 13 || !/^\d{12}$/.test(fields[1]) || !/^\d{12}$/.test(fields[2])) {
      return;
    }

    const [regId, tmFc, tmEf] = fields;
    let entry = byRegion.get(regId);
    if (!entry || tmFc > entry.tmFc) {
      entry = { tmFc, temps: new Map() };
      byRegion.set(regId, entry);
    }

    if (entry.tmFc === tmFc) {
      entry.temps.set(tmEf, Number.parseInt(fields[12], 10));
    }
  });

  return byRegion;
};

const buildRegionTempColumns = (latestTmFc, now) => {
  const today = formatKmaDay(now);
  const tomorrow = formatKmaDay(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const fcDay = latestTmFc.slice(0, 8);
  const fcHour = Number.parseInt(latestTmFc.slice(8, 10), 10);
  const todayMin = { key: `${today}0000`, label: '오늘 최저', date: today, metric: 'min', prevLabel: '어제' };
  const todayMax = { key: `${today}1200`, label: '오늘 최고', date: today, metric: 'max', prevLabel: '어제' };
  const tomorrowMin = { key: `${tomorrow}0000`, label: '내일 최저', date: tomorrow, metric: 'min', prevLabel: '오늘' };
  const tomorrowMax = { key: `${tomorrow}1200`, label: '내일 최고', date: tomorrow, metric: 'max', prevLabel: '오늘' };

  // 5시 발표 전에는 오늘 최저/최고, 5시·11시 발표 후에는 오늘 최고와 내일
  // 최저/최고, 17시 발표 후에는 내일 최저/최고를 보여준다.
  if (fcDay < today || fcHour < 5) {
    return [todayMin, todayMax];
  }

  if (fcHour < 17) {
    return [todayMax, tomorrowMin, tomorrowMax];
  }

  return [tomorrowMin, tomorrowMax];
};

// 예보구역코드 앞자리 → 관측지점 주소로 지점명 중복(예: 강원/경남 고성)을 가려낸다.
const ZONE_PREFIX_ADDRESS_KEYWORDS = [
  { prefix: '21F1', keywords: ['전북'] },
  { prefix: '21F2', keywords: ['전남'] },
  { prefix: '11C1', keywords: ['충청북도', '충북'] },
  { prefix: '11C2', keywords: ['대전', '세종', '충청남도', '충남'] },
  { prefix: '11F1', keywords: ['전북'] },
  { prefix: '11F2', keywords: ['전남', '광주'] },
  { prefix: '11H1', keywords: ['대구', '경상북도', '경북'] },
  { prefix: '11H2', keywords: ['부산', '울산', '경상남도', '경남'] },
  { prefix: '11A', keywords: ['인천'] },
  { prefix: '11B', keywords: ['서울', '인천', '경기'] },
  { prefix: '11D', keywords: ['강원'] },
  { prefix: '11E', keywords: ['경상북도', '경북'] },
  { prefix: '11G', keywords: ['제주'] },
];

const buildStationNameIndex = (stationMetadata) => {
  const idsByName = new Map();
  stationMetadata.forEach(({ name }, stationId) => {
    if (!name) {
      return;
    }
    if (!idsByName.has(name)) {
      idsByName.set(name, []);
    }
    idsByName.get(name).push(stationId);
  });

  // 지점번호가 작은 쪽(종관관측소)을 우선한다. 평년값은 종관관측소만 제공된다.
  idsByName.forEach((ids) => ids.sort((left, right) => Number(left) - Number(right)));
  return idsByName;
};

// 같은 이름의 지점이 여러 개면 권역이 맞는 지점들만 남긴다. 관측소 이전 등으로
// 평년값과 관측값이 서로 다른 지점번호에 있을 수 있어 후보 전체를 돌려준다.
const resolveZoneStationIds = (zoneId, zoneName, idsByName, stationMetadata) => {
  const candidates = idsByName.get(zoneName) ?? [];
  if (candidates.length <= 1) {
    return candidates;
  }

  const rule = ZONE_PREFIX_ADDRESS_KEYWORDS.find(({ prefix }) => zoneId.startsWith(prefix));
  if (!rule) {
    return candidates;
  }

  const matched = candidates.filter((stationId) => {
    const address = stationMetadata.get(stationId)?.address ?? '';
    return rule.keywords.some((keyword) => address.includes(keyword));
  });

  return matched.length > 0 ? matched : candidates;
};

// 평년값(1991~2020)을 지점별로 파싱한다. CSV 형태: ST,STN,MM,DD,TA,TA_MAX,TA_MIN,...
const parseDailyNormals = (rawText) => {
  const byStation = new Map();

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const fields = trimmed.split(',').map((item) => item.trim());
    if (fields.length < 7) {
      return;
    }

    const stationId = fields[1];
    const max = parseNumericValue(fields[5]);
    const min = parseNumericValue(fields[6]);
    byStation.set(stationId, {
      min: Number.isFinite(min) && min > -90 ? min : null,
      max: Number.isFinite(max) && max > -90 ? max : null,
    });
  });

  return byStation;
};

const fetchDailyNormalsByPeriod = async (day, tmst) => {
  const month = Number.parseInt(day.slice(4, 6), 10);
  const date = Number.parseInt(day.slice(6, 8), 10);
  const rawText = await fetchKmaText('api/typ01/url/sfc_norm1.php', {
    norm: 'D',
    tmst,
    stn: 0,
    MM1: month,
    DD1: date,
    MM2: month,
    DD2: date,
  }, {
    ttlMs: TTL.stationInfo,
    cacheKey: `daily-normals-${tmst}-${day.slice(4)}`,
    timeoutMs: 9000,
  });

  return parseDailyNormals(rawText);
};

// 신평년(1991~2020)을 우선 쓰되, 관측소 이전으로 신평년이 없는 지점(대구,
// 전주 등)은 구평년(1981~2010)으로 보완한다.
const fetchDailyNormals = async (day) => {
  const [current, legacy] = await Promise.all([
    fetchDailyNormalsByPeriod(day, 2021),
    fetchDailyNormalsByPeriod(day, 2011).catch(() => new Map()),
  ]);

  const merged = new Map(legacy);
  current.forEach((value, stationId) => {
    merged.set(stationId, value);
  });
  return merged;
};

const parseDailyObservedTemps = (rawText) => {
  const byStation = new Map();

  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length < 6) {
      return;
    }

    const value = parseNumericValue(fields[5]);
    if (Number.isFinite(value) && value > -90) {
      byStation.set(fields[1], value);
    }
  });

  return byStation;
};

const fetchDailyObservedTemps = async (day, metric, isToday, refreshToken) => {
  const rawText = await fetchKmaText('api/typ01/url/sfc_aws_day.php', {
    tm2: day,
    obs: metric === 'min' ? 'ta_min' : 'ta_max',
    stn: 0,
    disp: 0,
    help: 0,
  }, {
    ttlMs: isToday ? TTL.awsDaily : TTL.stationInfo,
    cacheKey: `daily-observed-${metric}-${day}`,
    timeoutMs: 20000,
    refreshToken: isToday ? refreshToken : '',
  });

  return parseDailyObservedTemps(rawText);
};

const roundTempDiff = (value) => Math.round(value * 10) / 10;

const formatForecastIssueLabel = (tmFc) => {
  if (!tmFc || tmFc.length < 10) {
    return '';
  }

  const month = Number.parseInt(tmFc.slice(4, 6), 10);
  const day = Number.parseInt(tmFc.slice(6, 8), 10);
  const hour = Number.parseInt(tmFc.slice(8, 10), 10);
  return `${month}월 ${day}일 ${hour}시 발표`;
};

const sortRegionTempTargets = (targets) =>
  targets
    .map((zone, index) => ({
      zone,
      index,
      priority: REGION_TEMP_PRIORITY_ZONE_ORDER.get(zone.id) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => {
      const leftIsPriority = Number.isFinite(left.priority);
      const rightIsPriority = Number.isFinite(right.priority);

      if (leftIsPriority !== rightIsPriority) {
        return leftIsPriority ? -1 : 1;
      }

      if (leftIsPriority && left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.index - right.index;
    })
    .map(({ zone }) => zone);

const resolveRegionTempTargets = async (regionId) => {
  const filter = REGION_TEMP_ZONE_FILTERS[regionId];
  if (!filter) {
    return NATIONAL_TEMP_CITIES;
  }

  const zones = await fetchForecastCityZones();
  const availableZones = zones.filter((zone) => !REGION_TEMP_EXCLUDED_ZONE_IDS.has(zone.id));

  if (filter.ids) {
    return sortRegionTempTargets(filter.ids
      .map((zoneId) => availableZones.find((zone) => zone.id === zoneId))
      .filter(Boolean));
  }

  return sortRegionTempTargets(
    availableZones.filter(
      (zone) =>
        filter.prefixes.some((prefix) => zone.id.startsWith(prefix)) &&
        !(filter.excludeIds ?? []).includes(zone.id),
    ),
  );
};

export const fetchRegionTemperatureForecast = async (regionId, options = {}) => {
  const { refreshToken = '' } = options;

  return withDataCache(`region-temp-forecast-${regionId}`, TTL.doc, async () => {
    const [rawText, targets] = await Promise.all([
      fetchKmaText('api/typ01/url/fct_afs_dl.php', { reg: '', tmfc: 0, disp: 0, help: 0 }, {
        ttlMs: TTL.doc,
        cacheKey: 'land-forecast-latest',
        timeoutMs: 15000,
        refreshToken,
      }),
      resolveRegionTempTargets(regionId),
    ]);

    const byRegion = parseLandForecastTemps(rawText);
    const latestTmFc = targets.reduce((latest, { id }) => {
      const tmFc = byRegion.get(id)?.tmFc ?? '';
      return tmFc > latest ? tmFc : latest;
    }, '');

    if (!latestTmFc) {
      throw new Error('지역별 기온 예보 데이터를 불러오지 못했습니다.');
    }

    const now = new Date();
    const today = formatKmaDay(now);
    const yesterday = formatKmaDay(subtractDays(now, 1));
    const columns = buildRegionTempColumns(latestTmFc, now);

    // 평년값·전날 관측값은 비교용 부가 정보라 실패해도 기온 표는 그대로 낸다.
    const columnDates = [...new Set(columns.map(({ date }) => date))];
    const prevDates = [...new Set(columns.map(({ date }) => (date === today ? yesterday : today)))];
    const [stationMetadata, normalsByDate, observedByDay] = await Promise.all([
      fetchAwsStationMetadata().catch(() => null),
      Promise.all(
        columnDates.map(async (date) => [date, await fetchDailyNormals(date).catch(() => null)]),
      ).then((entries) => new Map(entries)),
      Promise.all(
        prevDates.flatMap((day) =>
          ['min', 'max'].map(async (metric) => [
            `${day}-${metric}`,
            await fetchDailyObservedTemps(day, metric, day === today, refreshToken).catch(() => null),
          ]),
        ),
      ).then((entries) => new Map(entries)),
    ]);

    const idsByName = stationMetadata ? buildStationNameIndex(stationMetadata) : null;

    const buildComparisons = (zoneId, zoneName, column, forecastTa, temps) => {
      if (!idsByName) {
        return [];
      }

      const stationIds = resolveZoneStationIds(zoneId, zoneName, idsByName, stationMetadata);
      if (stationIds.length === 0) {
        return [];
      }

      const firstFinite = (values) => values.find((value) => Number.isFinite(value)) ?? null;
      const readObserved = (day, metric) =>
        firstFinite(stationIds.map((id) => observedByDay.get(`${day}-${metric}`)?.get(id)));

      const comparisons = [];
      const normal = firstFinite(
        stationIds.map((id) => normalsByDate.get(column.date)?.get(id)?.[column.metric]),
      );
      if (Number.isFinite(normal)) {
        comparisons.push({ label: '평년', diff: roundTempDiff(forecastTa - normal) });
      }

      // 내일 최고의 비교 대상인 오늘 최고는 아직 관측이 끝나지 않았을 수
      // 있으므로, 같은 발표문의 오늘 최고 예보값을 우선 사용한다.
      const prevDay = column.date === today ? yesterday : today;
      let prevValue = null;
      if (column.metric === 'max' && prevDay === today) {
        const bulletinTodayMax = temps?.get(`${today}1200`);
        prevValue =
          Number.isFinite(bulletinTodayMax) && bulletinTodayMax > -90
            ? bulletinTodayMax
            : readObserved(prevDay, 'max');
      } else {
        prevValue = readObserved(prevDay, column.metric);
        if (!Number.isFinite(prevValue) && column.metric === 'min' && prevDay === today) {
          const bulletinTodayMin = temps?.get(`${today}0000`);
          prevValue =
            Number.isFinite(bulletinTodayMin) && bulletinTodayMin > -90 ? bulletinTodayMin : null;
        }
      }

      if (Number.isFinite(prevValue)) {
        comparisons.push({ label: column.prevLabel, diff: roundTempDiff(forecastTa - prevValue) });
      }

      return comparisons;
    };

    const rows = targets
      .map(({ id, name }) => {
        const temps = byRegion.get(id)?.temps;
        return {
          id,
          name,
          cells: columns.map((column) => {
            const ta = temps?.get(column.key);
            if (!Number.isFinite(ta) || ta <= -90) {
              return { value: '-', comparisons: [] };
            }

            return {
              value: `${ta}°`,
              comparisons: buildComparisons(id, name, column, ta, temps),
            };
          }),
        };
      })
      .filter((row) => row.cells.some((cell) => cell.value !== '-'));

    return {
      issuedLabel: formatForecastIssueLabel(latestTmFc),
      columns: columns.map(({ label }) => label),
      rows,
    };
  }, { refreshToken });
};

const buildForecastDocCandidates = (now) =>
  [0, 1, 2]
    .flatMap((dayOffset) => {
      const baseDate = subtractDays(now, dayOffset);

      return DOC_ISSUANCE_HOURS.map((hour) => {
        const issuedAt = new Date(baseDate);
        issuedAt.setHours(hour, 0, 0, 0);

        return {
          issuedAt,
          endAt: new Date(issuedAt.getTime() + 60 * 60 * 1000),
        };
      });
    })
    .filter((candidate) => candidate.issuedAt <= now)
    .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());

const fetchWeatherCommentaryFromApiHub = async (regionId, options = {}) => {
  const { refreshToken = '' } = options;
  return withDataCache(`commentary-${regionId}`, TTL.commentary, async () => {
    const now = new Date();
    const stn = getStnByRegion(regionId);
    const fallbackKey = `commentary-last-success-${regionId}`;
    let lastError = null;

    for (const lookbackHours of COMMENTARY_LOOKBACK_HOURS) {
      try {
        const rawText = await fetchKmaText('api/typ01/url/wthr_cmt_rpt.php', {
          tmfc1: formatKmaMinuteTime(subtractHours(now, lookbackHours)),
          tmfc2: formatKmaMinuteTime(now),
          stn,
          subcd: 12,
          disp: 0,
          help: 1,
        }, {
          ttlMs: TTL.commentary,
          cacheKey: `commentary-${regionId}-${lookbackHours}h`,
          timeoutMs: 9000,
          refreshToken,
        });

        const { content, tmfc } = parseKmaReport(rawText, stn, 9);
        if (!tmfc && !content) {
          continue;
        }

        const payload = [
          {
            id: `commentary-${regionId}-${tmfc || Date.now()}`,
            title: `날씨해설 (${getIssuingOfficeName(stn)})`,
            time: formatDisplayTime(tmfc),
            content: content || '표출 가능한 날씨해설이 아직 없습니다.',
            region: regionId === 'all' ? '전국' : REGIONS.find((item) => item.id === regionId)?.label ?? '',
          },
        ];

        LAST_SUCCESS_DATA.set(fallbackKey, payload);
        return payload;
      } catch (error) {
        lastError = error;
      }
    }

    const cachedFallback = LAST_SUCCESS_DATA.get(fallbackKey);
    if (cachedFallback) {
      return cachedFallback;
    }

    console.error('[API Fetch Error] 날씨해설 실패', lastError);
    throw new Error('기상청 날씨해설 데이터를 불러오지 못했습니다.');
  }, { refreshToken });
};

const fetchOfficialWeatherCommentary = async (regionId, options = {}) => {
  const { refreshToken = '' } = options;

  return withDataCache(`official-commentary-${regionId}`, TTL.commentary, async () => {
    const response = await fetchWithRetry(
      buildAppUrl('/api/weather-commentary', withRefreshParam({ region: regionId }, refreshToken)),
      refreshToken ? { cache: 'no-store' } : {},
      0,
      8000,
    );
    const payload = await response.json();

    if (!Array.isArray(payload) || !payload[0]?.content) {
      throw new Error('Official weather commentary payload is empty.');
    }

    return payload;
  }, { refreshToken });
};

export const fetchWeatherCommentary = async (regionId, options = {}) => {
  try {
    return await fetchOfficialWeatherCommentary(regionId, options);
  } catch (error) {
    console.warn('[API Fetch Warning] Official commentary failed. Falling back to API Hub.', error);
    return fetchWeatherCommentaryFromApiHub(regionId, options);
  }
};

const fetchWeatherDocFromApiHub = async (regionId, options = {}) => {
  const { refreshToken = '' } = options;
  return withDataCache(`forecast-doc-${regionId}`, TTL.doc, async () => {
    const now = new Date();
    const stn = getStnByRegion(regionId);
    const fallbackKey = `forecast-doc-last-success-${regionId}`;
    let lastError = null;

    for (const candidate of buildForecastDocCandidates(now)) {
      try {
        const rawText = await fetchKmaText('api/typ01/url/fct_afs_ds.php', {
          tmfc1: formatKmaHourTime(candidate.issuedAt),
          tmfc2: formatKmaHourTime(candidate.endAt),
          stn,
          disp: 0,
          help: 1,
        }, {
          ttlMs: TTL.doc,
          cacheKey: `forecast-doc-${regionId}-${formatKmaHourTime(candidate.issuedAt)}`,
          timeoutMs: 15000,
          refreshToken,
        });

        const { content, tmfc } = parseKmaReport(rawText, stn, 7);
        if (!tmfc && !content) {
          continue;
        }

        const payload = [
          {
            id: `forecast-doc-${regionId}-${tmfc || Date.now()}`,
            title: `통보문 (${getIssuingOfficeName(stn)})`,
            time: formatDisplayTime(tmfc),
            content: content || '표출 가능한 통보문이 아직 없습니다.',
            region: regionId === 'all' ? '전국' : REGIONS.find((item) => item.id === regionId)?.label ?? '',
          },
        ];

        LAST_SUCCESS_DATA.set(fallbackKey, payload);
        return payload;
      } catch (error) {
        lastError = error;
      }
    }

    try {
      const rawText = await fetchKmaText('api/typ01/url/fct_afs_ds.php', {
        tmfc1: formatKmaHourTime(subtractDays(now, 2)),
        tmfc2: formatKmaHourTime(new Date(now.getTime() + 60 * 60 * 1000)),
        stn,
        disp: 0,
        help: 1,
      }, {
        ttlMs: TTL.doc,
        cacheKey: `forecast-doc-${regionId}-lookback`,
        timeoutMs: 15000,
        refreshToken,
      });

      const { content, tmfc } = parseKmaReport(rawText, stn, 7);
      if (tmfc || content) {
        const payload = [
          {
            id: `forecast-doc-${regionId}-${tmfc || Date.now()}`,
            title: `?듬낫臾?(${getIssuingOfficeName(stn)})`,
            time: formatDisplayTime(tmfc),
            content: content || '?쒖텧 媛?ν븳 ?듬낫臾몄씠 ?꾩쭅 ?놁뒿?덈떎.',
            region: regionId === 'all' ? '?꾧뎅' : REGIONS.find((item) => item.id === regionId)?.label ?? '',
          },
        ];

        LAST_SUCCESS_DATA.set(fallbackKey, payload);
        return payload;
      }
    } catch (error) {
      lastError = error;
    }

    const cachedFallback = LAST_SUCCESS_DATA.get(fallbackKey);
    if (cachedFallback) {
      return cachedFallback;
    }

    console.error('[API Fetch Error] 통보문 실패', lastError);
    throw new Error('기상청 통보문 데이터를 불러오지 못했습니다.');
  }, { refreshToken });
};

const fetchOfficialForecastDoc = async (regionId, options = {}) => {
  const { refreshToken = '' } = options;

  return withDataCache(`official-forecast-doc-${regionId}`, TTL.doc, async () => {
    const response = await fetchWithRetry(
      buildAppUrl('/api/forecast-doc', withRefreshParam({ region: regionId }, refreshToken)),
      refreshToken ? { cache: 'no-store' } : {},
      0,
      8000,
    );
    const payload = await response.json();

    if (!Array.isArray(payload) || !payload[0]?.content) {
      throw new Error('Official forecast notice payload is empty.');
    }

    return payload;
  }, { refreshToken });
};

export const fetchWeatherDoc = async (regionId, options = {}) => {
  try {
    return await fetchOfficialForecastDoc(regionId, options);
  } catch (officialError) {
    console.warn('[API Fetch Warning] Official forecast notice failed. Falling back to API Hub.', officialError);
    return fetchWeatherDocFromApiHub(regionId, options);
  }
};

export const fetchWeatherWarnings = async (regionId, options = {}) => {
  const { refreshToken = '' } = options;
  try {
    // 구역 계층 목록은 24시간 캐시되므로 특보 데이터와 병렬로 준비한다.
    const regionIndexPromise = fetchWarningRegionIndex().catch(() => null);
    const rawText = await fetchKmaText('api/typ01/url/wrn_now_data.php', {
      fe: 'f',
      tm: '',
      disp: 0,
      help: 1,
    }, {
      ttlMs: TTL.warnings,
      cacheKey: 'weather-warnings-raw',
      refreshToken,
    });
    const regionIndex = await regionIndexPromise;

    const records = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const fields = line.split(',').map((item) => item.trim());
        return {
          regUpKo: fields[1],
          regId: fields[2],
          regKo: fields[3],
          tmFc: fields[4],
          tmEf: fields[5],
          wrn: fields[6],
          lvl: fields[7],
          cmd: fields[8],
          edTm: fields[9],
        };
      });

    const currentMap = new Map();
    const preliminaryMap = new Map();
    const targetRegion = REGIONS.find((item) => item.id === regionId);

    records.forEach((record) => {
      const isMarine =
        /(해상|바다|앞바다|먼바다)/.test(record.regUpKo) || /(해상|바다|앞바다|먼바다)/.test(record.regKo);
      const broadRegion = getBroadRegion(record.regUpKo, record.regKo || record.regUpKo);
      const recordSearchText = `${record.regUpKo ?? ''} ${record.regKo ?? ''} ${broadRegion}`.trim();
      const isExcluded = targetRegion?.excludeKeywords?.some((keyword) => recordSearchText.includes(keyword));
      const regionMatches =
        regionId === 'all' ||
        isMarine ||
        (!isExcluded &&
          targetRegion?.keywords?.some((keyword) => recordSearchText.includes(keyword)));

      if (!regionMatches) {
        return;
      }

      if (isMarine && regionId !== 'all') {
        return;
      }

      const isPreliminary = record.tmEf?.endsWith('58') || record.tmEf?.endsWith('59');
      const targetMap = isPreliminary ? preliminaryMap : currentMap;
      const levelLabel = record.lvl === '주의' ? '주의보' : record.lvl === '경보' ? '경보' : record.lvl;
      const typeName = isPreliminary
        ? `${record.wrn} ${levelLabel} 특보`
        : `${record.wrn} ${levelLabel}`;
      const rawDetailRegion = isMarine
        ? formatDetailOcean(record.regKo || record.regUpKo)
        : formatDetailLand(record.regKo || record.regUpKo);
      const normalizedDetailRegion = isMarine
        ? rawDetailRegion
        : stripRepeatedBroadRegionPrefix(rawDetailRegion, broadRegion);
      const detailRegion =
        broadRegion === '전남광주' &&
        record.regUpKo?.includes('광주광역시') &&
        normalizedDetailRegion &&
        !normalizedDetailRegion.startsWith('광주')
          ? `광주${normalizedDetailRegion}`
          : normalizedDetailRegion;

      if (!targetMap.has(typeName)) {
        targetMap.set(typeName, new Map());
      }

      if (!targetMap.get(typeName).has(broadRegion)) {
        targetMap.get(typeName).set(broadRegion, new Map());
      }

      // 구역코드를 키로 보관해 '전 지역' 판정에 쓴다. 표시명이 광역명과 같아
      // 생략되는 구역도 발령 여부는 코드로 남겨 둔다.
      const entryKey = record.regId || detailRegion || record.regKo || record.regUpKo;
      const entryDetail = detailRegion && detailRegion !== broadRegion ? detailRegion : '';
      if (entryKey && !targetMap.get(typeName).get(broadRegion).has(entryKey)) {
        targetMap.get(typeName).get(broadRegion).set(entryKey, entryDetail);
      }
    });

    const formatOutput = (map) =>
      [...map.entries()].map(([typeName, broadMap], index) => ({
        id: `${typeName}-${index}-${Date.now()}`,
        type: typeName,
        time: '',
        content: sortWarningBroadRegionEntries([...broadMap.entries()], regionId)
          .map(([broadRegion, detailEntries]) => {
            const { isEntireBroadRegion, details } = collapseWarningRegionDetails(
              broadRegion,
              detailEntries,
              regionIndex,
            );
            // 전 지역 발령이면 권역명만 남긴다. 일부 권역 발령은 괄호로 나열한다.
            if (isEntireBroadRegion) {
              return `• ${broadRegion}`;
            }

            const sortedDetails = sortDetailsForDisplay(broadRegion, details);
            const separator = getRegionParenthesisSeparator(broadRegion);
            return sortedDetails.length > 0
              ? `• ${broadRegion}${separator}(${sortedDetails.join(', ')})`
              : `• ${broadRegion}`;
          })
          .join('\n'),
      }));

    return {
      current: formatOutput(currentMap),
      preliminary: formatOutput(preliminaryMap),
    };
  } catch (error) {
    console.error('[API Fetch Error] 특보 실패', error);
    throw new Error('기상청 특보 데이터를 불러오지 못했습니다.');
  }
};

export const getWarningImageUrl = (warningMode = 'current', trigger = 0) => {
  const now = new Date();
  const isPreliminary = warningMode === 'preliminary';

  return buildKmaUrl('api/typ03/cgi/wrn/nph-wrn7', {
    out: 0,
    tmef: isPreliminary ? 0 : 1,
    city: 1,
    name: 0,
    tm: formatKmaMinuteTime(now),
    lon: 127.7,
    lat: 36.1,
    range: 300,
    size: 685,
    wrn: 'W,R,C,D,O,V,T,S,Y,H,',
    _ts: trigger,
  });
};

export const fetchWarningImageUrls = async (options = {}) => {
  const { refreshToken = '' } = options;
  return withDataCache('warning-image-urls', TTL.warnings, async () => {
    const response = await fetchWithRetry(
      buildAppUrl('/api/weather-warning', withRefreshParam({}, refreshToken)),
      refreshToken ? { cache: 'no-store' } : {},
      1,
      9000,
    );
    const payload = await response.json();

    return {
      current: payload.current || '',
      preliminary: payload.preliminary || '',
    };
  }, { refreshToken });
};

const fetchRankingsJson = async (kind, options = {}) => {
  const { refreshToken = '', observedAt = '', period = '' } = options;
  const params = { kind };
  if (observedAt) {
    params.tm = observedAt;
  }
  if (period) {
    params.period = period;
  }
  const cacheKeyParts = ['server-rankings', kind, observedAt, period].filter(Boolean);
  const cacheKey = cacheKeyParts.join('-');
  const ttlMs = kind === 'temperature-tropical-night' ? 30 * 1000 : TTL.awsMinute;

  return withDataCache(cacheKey, ttlMs, async () => {
    const response = await fetchWithRetry(
      buildAppUrl('/api/rankings', withRefreshParam(params, refreshToken)),
      refreshToken ? { cache: 'no-store' } : {},
      1,
      35000,
    );
    return response.json();
  }, { refreshToken });
};

export const fetchServerTemperatureCurrentRankings = async (options = {}) =>
  fetchRankingsJson('temperature-current', options);

export const fetchServerTemperatureTodayRankings = async (options = {}) =>
  fetchRankingsJson('temperature-today', options);

export const fetchServerTemperatureTropicalNightRankings = async (options = {}) =>
  fetchRankingsJson('temperature-tropical-night', options);

export const fetchServerPrecipitationCurrentRankings = async (options = {}) =>
  fetchRankingsJson('precipitation-current', options);

export const fetchServerPrecipitationMaxOneHourRankings = async (options = {}) =>
  fetchRankingsJson('precipitation-max-one-hour', options);

export const fetchServerPrecipitationSinceYesterdayRankings = async (options = {}) =>
  fetchRankingsJson('precipitation-since-yesterday', options);

export const fetchServerPrecipitationSinceDayBeforeYesterdayRankings = async (options = {}) =>
  fetchRankingsJson('precipitation-since-day-before-yesterday', options);

export const fetchSnowData = async (type = 'tot', customTm = null, options = {}) => {
  const { refreshToken = '' } = options;
  const tm = customTm || formatKmaMinuteTime(new Date());
  const ttlMs = customTm ? TTL.snowHistory : TTL.snow;

  return withDataCache(`${SNOW_DATA_CACHE_VERSION}-snow-${type}-${tm}`, ttlMs, async () => {
    try {
      const loadSnowRows = async (effectiveRefreshToken = refreshToken) => {
        const [dataRaw, stnRaw] = await Promise.all([
          fetchKmaText(
            'api/typ01/url/kma_snow1.php',
            { sd: type, tm, help: 0 },
            { ttlMs, refreshToken: effectiveRefreshToken },
          ),
          fetchKmaText(
            'api/typ01/url/stn_snow.php',
            { stn: '', tm, mode: 0, help: 1 },
            { ttlMs, refreshToken: effectiveRefreshToken },
          ),
        ]);

        return buildSnowRankingRows(dataRaw, parseSnowStationMetadata(stnRaw));
      };

      const rows = await loadSnowRows();
      if (customTm && rows.length === 0 && !refreshToken) {
        return loadSnowRows(`snow-history-${type}-${tm}-${Date.now()}`);
      }

      return rows;
    } catch (error) {
      console.error('[API Fetch Error] 적설 실패', error);
      throw new Error('기상청 적설 데이터를 불러오지 못했습니다.');
    }
  }, { refreshToken });
};
