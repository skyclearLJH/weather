const KMA_BROADCAST_PROXY_BASE = '/api/kma-broadcast/';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TROPICAL_NIGHT_THRESHOLD_C = 25;
const TROPICAL_NIGHT_END_HOUR = 9;

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

const stationCache = new Map();
const dailyCache = new Map();

const pad2 = (value) => String(value).padStart(2, '0');
const formatKmaMinuteTime = (date) =>
  `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
  `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}`;
const formatKmaDay = (date) => formatKmaMinuteTime(date).slice(0, 8);
const formatStationInfoTime = (date) => `${formatKmaMinuteTime(date).slice(0, 10)}00`;

const getKstWallClock = (nowMs = Date.now()) => new Date(nowMs + KST_OFFSET_MS);

const setKstWallTime = (date, hour, minute = 0) => {
  const result = new Date(date);
  result.setUTCHours(hour, minute, 0, 0);
  return result;
};

const subtractKstDays = (date, days) => new Date(date.getTime() - days * 86400000);

const parseKstDateInput = (value = '') => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

const formatKoreanDateTime = (date) =>
  `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 ` +
  `${pad2(date.getUTCHours())}시 ${pad2(date.getUTCMinutes())}분`;

const formatKoreanWindowTime = (date) =>
  `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 ` +
  `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;

const normalizeStationAddress = (value = '') =>
  value
    .replace(/^(?:(?:\d+|-{2,}|_+|\*+|[xX]+)\s*)+/, '')
    .trim();

const parseNumericValue = (value) => {
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const buildProxyUrl = (path, params, refreshToken = '') => {
  const url = new URL(`${KMA_BROADCAST_PROXY_BASE}${path}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  if (refreshToken) {
    url.searchParams.set('_refresh', refreshToken);
  }
  return url;
};

const fetchKmaText = async (path, params, refreshToken = '') => {
  const response = await fetch(buildProxyUrl(path, params, refreshToken), {
    cache: refreshToken ? 'no-store' : 'default',
    signal: AbortSignal.timeout(25000),
  });
  const buffer = await response.arrayBuffer();
  if (!response.ok) {
    const detail = new TextDecoder().decode(buffer).trim();
    if (detail.includes('Error proxying to KMA API')) {
      throw new Error('기상청 API 연결이 지연되고 있습니다. 잠시 후 새로고침해 주세요.');
    }
    throw new Error(detail || `기상 관측 자료 요청 실패 (${response.status})`);
  }
  return new TextDecoder('euc-kr').decode(buffer);
};

const findStationCoordinates = (fields) => {
  for (let index = 1; index < Math.min(fields.length - 1, 12); index += 1) {
    const lon = Number.parseFloat(fields[index]);
    const lat = Number.parseFloat(fields[index + 1]);
    if (
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lon >= 120 &&
      lon <= 140 &&
      lat >= 30 &&
      lat <= 45
    ) {
      return { lon, lat };
    }
  }
  return null;
};

const parseStationMetadata = (rawText, stationType) => {
  const stations = new Map();
  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const fields = trimmed.split(/\s+/);
    const coordinates = findStationCoordinates(fields);
    if (!coordinates) return;

    const isAsos = stationType === 'ASOS';
    const id = fields[0];
    const name = isAsos ? fields[10] || fields[9] || id : fields[8] || id;
    const addressStart = isAsos ? 15 : 13;
    const address = normalizeStationAddress(fields.slice(addressStart).join(' '));
    stations.set(id, {
      id,
      name,
      address: address || name,
      lon: coordinates.lon,
      lat: coordinates.lat,
      stationType,
    });
  });
  return stations;
};

const fetchStationMetadata = async (stationType) => {
  if (stationCache.has(stationType)) {
    return stationCache.get(stationType);
  }
  const promise = fetchKmaText('api/typ01/url/stn_inf.php', {
    inf: stationType === 'ASOS' ? 'SFC' : 'AWS',
    stn: '',
    tm: formatStationInfoTime(getKstWallClock()),
    help: 1,
  })
    .then((rawText) => {
      const stations = parseStationMetadata(rawText, stationType);
      if (stations.size < (stationType === 'ASOS' ? 50 : 100)) {
        throw new Error(`${stationType} 지점 정보를 충분히 불러오지 못했습니다.`);
      }
      return stations;
    })
    .catch((error) => {
      stationCache.delete(stationType);
      throw error;
    });
  stationCache.set(stationType, promise);
  return promise;
};

const parseDailyTemperature = (rawText, stationMetadata) => {
  const rows = [];
  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 7) return;
    const station = stationMetadata.get(fields[1]);
    const value = parseNumericValue(fields[5]);
    if (!station || !Number.isFinite(value) || value <= -50 || value >= 60) return;
    rows.push({ ...station, value });
  });
  return rows;
};

const fetchDailyTemperature = async (day, observation, stationMetadata, refreshToken) => {
  const cacheKey = `${day}:${observation}:${stationMetadata.size}`;
  if (!refreshToken && dailyCache.has(cacheKey)) {
    return dailyCache.get(cacheKey);
  }
  const promise = fetchKmaText(
    'api/typ01/url/sfc_aws_day.php',
    {
      tm2: day,
      obs: observation,
      stn: 0,
      disp: 0,
      help: 1,
    },
    refreshToken,
  )
    .then((rawText) => parseDailyTemperature(rawText, stationMetadata))
    .catch((error) => {
      dailyCache.delete(cacheKey);
      throw error;
    });
  dailyCache.set(cacheKey, promise);
  return promise;
};

export const buildTropicalNightWindow = (nowMs = Date.now(), targetDate = '') => {
  const now = getKstWallClock(nowMs);
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const selectedDay = parseKstDateInput(targetDate) ?? todayStart;
  const isToday = formatKmaDay(selectedDay) === formatKmaDay(todayStart);
  const endOfWindow = setKstWallTime(selectedDay, TROPICAL_NIGHT_END_HOUR, 0);
  const isProvisional = isToday && now.getUTCHours() < TROPICAL_NIGHT_END_HOUR;
  const start = setKstWallTime(subtractKstDays(selectedDay, 1), 18, 1);
  const end = isProvisional ? now : endOfWindow;
  return {
    start,
    end,
    status: isProvisional ? 'provisional' : 'confirmed',
  };
};

const buildTropicalNightData = async (refreshToken = '', targetDate = '') => {
  const window = buildTropicalNightWindow(Date.now(), targetDate);
  const [awsStations, asosStations] = await Promise.all([
    fetchStationMetadata('AWS'),
    fetchStationMetadata('ASOS'),
  ]);
  const stationMetadata = new Map([...awsStations, ...asosStations]);
  const observations = await fetchDailyTemperature(
    formatKmaDay(window.end),
    'ta_min',
    stationMetadata,
    refreshToken,
  );
  if (observations.length < 20) {
    throw new Error('열대야 관측 자료를 충분히 불러오지 못했습니다.');
  }
  return {
    mode: 'tropical',
    observations,
    observedAt: formatKoreanDateTime(window.end),
    observedAtCode: formatKmaMinuteTime(window.end),
    status: window.status,
    note:
      window.status === 'provisional'
        ? '진행 중인 열대야 상황입니다. 최종 기록은 오전 09시 이후 확인하세요.'
        : '오전 09시 기준으로 확정된 열대야 기록입니다.',
    windowLabel: `${formatKoreanWindowTime(window.start)} ~ ${formatKoreanWindowTime(window.end)}`,
    threshold: TROPICAL_NIGHT_THRESHOLD_C,
  };
};

const buildHeatwaveData = async (refreshToken = '', targetDate = '') => {
  const now = getKstWallClock();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const selectedDay = parseKstDateInput(targetDate) ?? todayStart;
  const isToday = formatKmaDay(selectedDay) === formatKmaDay(todayStart);
  const observedAt = isToday ? now : setKstWallTime(selectedDay, 23, 59);
  const [awsStations, asosStations] = await Promise.all([
    fetchStationMetadata('AWS'),
    fetchStationMetadata('ASOS'),
  ]);
  const stationMetadata = new Map([...awsStations, ...asosStations]);
  const observations = (
    await fetchDailyTemperature(
      formatKmaDay(selectedDay),
      'ta_max',
      stationMetadata,
      refreshToken,
    )
  ).filter(
    (row) =>
      row.stationType === 'ASOS' ||
      !HEAT_WARNING_UNSUPPORTED_AWS_STATION_IDS.has(String(row.id)),
  );
  if (observations.length < 20) {
    throw new Error('최고기온 관측 자료를 충분히 불러오지 못했습니다.');
  }
  return {
    mode: 'heat',
    observations,
    observedAt: formatKoreanDateTime(observedAt),
    observedAtCode: formatKmaMinuteTime(observedAt),
    status: isToday ? 'current' : 'historical',
    note: isToday
      ? 'ASOS와 폭염특보 운영 AWS 지점의 오늘 최고기온입니다.'
      : '선택한 날짜의 일 최고기온 확정 자료입니다.',
    windowLabel: `${selectedDay.getUTCMonth() + 1}월 ${selectedDay.getUTCDate()}일 00:00 ~ ${isToday ? '현재' : '24:00'}`,
  };
};

export const fetchHeatwaveBroadcastData = (mode, options = {}) =>
  mode === 'heat'
    ? buildHeatwaveData(options.refreshToken, options.targetDate)
    : buildTropicalNightData(options.refreshToken, options.targetDate);
