import { REGIONS } from '../data/mockData';
import { KMA_SNOW_LAW_ADDRESS_MAP } from '../data/kmaSnowLawAddressMap';
import { KMA_PROXY_BASE } from '../utils/constants';

const padZero = (value) => value.toString().padStart(2, '0');
const REQUEST_TIMEOUT_MS = 12000;
const REQUEST_RETRY_COUNT = 1;
const AWS_MINUTE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15];
const AWS_TEMPERATURE_LOOKBACK_STEPS = [3, 4, 5, 7, 10, 15, 20, 30];
const COMMENTARY_LOOKBACK_HOURS = [12, 24, 48, 72];
const DOC_ISSUANCE_HOURS = [5, 11, 17];
const DOC_ISSUANCE_GRACE_MINUTES = 5;
const SLOW_DAILY_RAIN_TIMEOUT_MS = 30000;
const SLOW_DAILY_TEMPERATURE_TIMEOUT_MS = 20000;
const TEXT_CACHE = new Map();
const TEXT_IN_FLIGHT = new Map();
const DATA_CACHE = new Map();
const DATA_IN_FLIGHT = new Map();
const LAST_SUCCESS_DATA = new Map();
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

const fetchKmaArrayBuffer = async (path, params = {}, options = {}) => {
  const response = await fetchWithRetry(
    buildKmaUrl(path, params),
    {},
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
  } = options;

  const cachedValue = getCachedValue(TEXT_CACHE, cacheKey);
  if (cachedValue !== null) {
    return cachedValue;
  }

  if (TEXT_IN_FLIGHT.has(cacheKey)) {
    return TEXT_IN_FLIGHT.get(cacheKey);
  }

  const requestPromise = fetchKmaArrayBuffer(path, params, { retryCount, timeoutMs })
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

const withDataCache = async (cacheKey, ttlMs, loader) => {
  const cachedValue = getCachedValue(DATA_CACHE, cacheKey);
  if (cachedValue !== null) {
    return cachedValue;
  }

  if (DATA_IN_FLIGHT.has(cacheKey)) {
    return DATA_IN_FLIGHT.get(cacheKey);
  }

  const requestPromise = loader()
    .then((value) => setCachedValue(DATA_CACHE, cacheKey, value, ttlMs))
    .finally(() => {
      DATA_IN_FLIGHT.delete(cacheKey);
    });

  DATA_IN_FLIGHT.set(cacheKey, requestPromise);
  return requestPromise;
};

const isFiniteObservation = (value) => Number.isFinite(value) && value > -50;

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

const fetchAwsMinuteObservationsByTimes = async (stationMetadata, candidateTimes, validator) => {
  for (const candidateTime of candidateTimes) {
    const observedAt = formatKmaMinuteTime(candidateTime);
    const rawText = await fetchKmaText('api/typ01/cgi-bin/url/nph-aws2_min', {
      tm2: observedAt,
      stn: 0,
      disp: 0,
      help: 1,
    }, {
      ttlMs: TTL.awsMinute,
    });
    const rows = parseAwsMinuteObservations(rawText, stationMetadata);

    if (validator(rows)) {
      return { observedAt, rows };
    }
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
            .filter((item) => isFiniteObservation(item.temperature))
            .map((item) => ({ name: item.name, address: item.address, value: item.temperature })),
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
            .filter((item) => isFiniteObservation(item.value))
            .map((item) => ({ name: item.name, address: item.address, value: item.value })),
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
  if (combined.includes('흑산도') || combined.includes('홍도')) return '전남';
  if (combined.includes('서해5도')) return '인천';

  return upperRegion
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

const buildForecastDocCandidates = (now) =>
  [0, 1, 2]
    .flatMap((dayOffset) => {
      const baseDate = subtractDays(now, dayOffset);

      return DOC_ISSUANCE_HOURS.map((hour) => {
        const issuedAt = new Date(baseDate);
        issuedAt.setHours(hour, 0, 0, 0);

        return {
          issuedAt,
          availableAt: new Date(issuedAt.getTime() + DOC_ISSUANCE_GRACE_MINUTES * 60 * 1000),
          endAt: new Date(issuedAt.getTime() + 60 * 60 * 1000),
        };
      });
    })
    .filter((candidate) => candidate.availableAt <= now)
    .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());

export const fetchWeatherCommentary = async (regionId) => {
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
  });
};

export const fetchWeatherDoc = async (regionId) => {
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
          timeoutMs: 9000,
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

    const cachedFallback = LAST_SUCCESS_DATA.get(fallbackKey);
    if (cachedFallback) {
      return cachedFallback;
    }

    console.error('[API Fetch Error] 통보문 실패', lastError);
    throw new Error('기상청 통보문 데이터를 불러오지 못했습니다.');
  });
};

export const fetchWeatherWarnings = async (regionId) => {
  try {
    const rawText = await fetchKmaText('api/typ01/url/wrn_now_data.php', {
      fe: 'f',
      tm: '',
      disp: 0,
      help: 1,
    }, {
      ttlMs: TTL.warnings,
      cacheKey: 'weather-warnings-raw',
    });

    const records = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const fields = line.split(',').map((item) => item.trim());
        return {
          regUpKo: fields[1],
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
      const regionMatches =
        regionId === 'all' ||
        isMarine ||
        targetRegion?.keywords?.some(
          (keyword) => record.regUpKo.includes(keyword) || record.regKo.includes(keyword),
        );

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
      const broadRegion = getBroadRegion(record.regUpKo, record.regKo || record.regUpKo);
      const detailRegion = isMarine
        ? formatDetailOcean(record.regKo || record.regUpKo)
        : formatDetailLand(record.regKo || record.regUpKo);

      if (!targetMap.has(typeName)) {
        targetMap.set(typeName, new Map());
      }

      if (!targetMap.get(typeName).has(broadRegion)) {
        targetMap.get(typeName).set(broadRegion, new Set());
      }

      if (detailRegion && detailRegion !== broadRegion) {
        targetMap.get(typeName).get(broadRegion).add(detailRegion);
      }
    });

    const formatOutput = (map) =>
      [...map.entries()].map(([typeName, broadMap], index) => ({
        id: `${typeName}-${index}-${Date.now()}`,
        type: typeName,
        time: '',
        content: [...broadMap.entries()]
          .map(([broadRegion, detailRegions]) => {
            const details = [...detailRegions];
            return details.length > 0
              ? `• ${broadRegion} (${details.join(', ')})`
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

export const fetchWarningImageUrls = async () =>
  withDataCache('warning-image-urls', TTL.warnings, async () => {
    const response = await fetchWithRetry(buildAppUrl('/api/weather-warning'), {}, 1, 9000);
    const payload = await response.json();

    return {
      current: payload.current || '',
      preliminary: payload.preliminary || '',
    };
  });

const fetchRankingsJson = async (kind) =>
  withDataCache(`server-rankings-${kind}`, TTL.awsMinute, async () => {
    const response = await fetchWithRetry(buildAppUrl('/api/rankings', { kind }), {}, 1, 35000);
    return response.json();
  });

export const fetchServerTemperatureCurrentRankings = async () =>
  fetchRankingsJson('temperature-current');

export const fetchServerTemperatureTodayRankings = async () =>
  fetchRankingsJson('temperature-today');

export const fetchServerPrecipitationCurrentRankings = async () =>
  fetchRankingsJson('precipitation-current');

export const fetchServerPrecipitationSinceYesterdayRankings = async () =>
  fetchRankingsJson('precipitation-since-yesterday');

export const fetchSnowData = async (type = 'tot', customTm = null) => {
  const tm = customTm || formatKmaMinuteTime(new Date());
  const ttlMs = customTm ? TTL.snowHistory : TTL.snow;

  return withDataCache(`snow-${type}-${tm}`, ttlMs, async () => {
    try {
      const [dataRaw, stnRaw] = await Promise.all([
        fetchKmaText('api/typ01/url/kma_snow1.php', { sd: type, tm, help: 0 }, { ttlMs }),
        fetchKmaText('api/typ01/url/stn_snow.php', { stn: '', tm, mode: 0, help: 1 }, { ttlMs }),
      ]);

      const stationMetadata = new Map();

      stnRaw.split('\n').forEach((line) => {
        if (!line || line.trim().startsWith('#')) {
          return;
        }

        const fields = line.trim().split(/\s+/);
        if (fields.length < 9) {
          return;
        }

        const stationId = fields[0];
        const stationName = fields[6];
        const legalCode = fields[8];
        const address = KMA_SNOW_LAW_ADDRESS_MAP[legalCode] ?? stationName;

        stationMetadata.set(stationId, { name: stationName, address });
      });

      return dataRaw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => line.split(',').map((field) => field.trim()))
        .filter((fields) => fields.length >= 7)
        .map((fields) => {
          const stationId = fields[1];
          const snowValue = Number.parseFloat(fields[6].replace(/[^0-9.-]/g, ''));
          const metadata = stationMetadata.get(stationId) ?? { name: fields[2], address: fields[2] };

          return {
            name: metadata.name,
            address: metadata.address,
            value: snowValue,
          };
        })
        .filter((item) => Number.isFinite(item.value) && item.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((item, index) => ({
          rank: index + 1,
          name: item.name,
          record: `${item.value.toFixed(1)}cm`,
          address: item.address,
        }));
    } catch (error) {
      console.error('[API Fetch Error] 적설 실패', error);
      throw new Error('기상청 적설 데이터를 불러오지 못했습니다.');
    }
  });
};
