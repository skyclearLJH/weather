const KMA_BROADCAST_PROXY_BASE = '/api/kma-broadcast/';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TROPICAL_NIGHT_THRESHOLD_C = 25;
const TROPICAL_NIGHT_END_HOUR = 9;
const TEMPERATURE_TIMELINE_STEP_MINUTES = 30;
const TEMPERATURE_TIMELINE_MAX_FRAMES = 49;
const TEMPERATURE_FRAME_FALLBACK_MINUTES = [0, 3, 5, 10];
const TEMPERATURE_FRAME_FETCH_CONCURRENCY = 4;

export const HEAT_WARNING_UNSUPPORTED_AWS_STATION_IDS = new Set([
  // 폭염특보 미운영(별표) 지점 — 방재기상플랫폼 AWS 일자료 export(2026-08-04) C열 별표 기준.
  '116', '229', '334', '335', '336', '337', '351', '352',
  '355', '356', '358', '359', '360', '361', '364', '365',
  '367', '368', '369', '372', '373', '374', '375', '418',
  '419', '430', '432', '434', '435', '436', '437', '439',
  '440', '451', '452', '454', '456', '457', '458', '459',
  '460', '461', '462', '471', '472', '473', '474', '475',
  '478', '479', '480', '481', '482', '483', '484', '485',
  '486', '489', '491', '492', '510',
]);

const stationCache = new Map();
const dailyCache = new Map();
const temperatureFrameCache = new Map();

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

const parseKstDateTimeInput = (value = '') => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5])
  ) {
    return null;
  }
  return date;
};

const subtractMinutes = (date, minutes) =>
  new Date(date.getTime() - minutes * 60 * 1000);

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

const parseMinuteTemperature = (rawText, stationMetadata) => {
  const rows = [];
  rawText.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 18) return;
    const station = stationMetadata.get(fields[1]);
    const value = parseNumericValue(fields[8]);
    if (!station || !Number.isFinite(value) || value <= -50 || value >= 60) return;
    rows.push({ ...station, value });
  });
  return rows;
};

const fetchTemperatureFrameCandidate = async (
  requestedDate,
  candidateDate,
  stationMetadata,
  refreshToken,
) => {
  const observedAtCode = formatKmaMinuteTime(candidateDate);
  if (!refreshToken && temperatureFrameCache.has(observedAtCode)) {
    return temperatureFrameCache.get(observedAtCode);
  }

  const promise = fetchKmaText(
    'api/typ01/cgi-bin/url/nph-aws2_min',
    { tm2: observedAtCode, stn: 0, disp: 0, help: 0 },
    refreshToken,
  )
    .then((rawText) => {
      const observations = parseMinuteTemperature(rawText, stationMetadata);
      if (observations.length < 100) return null;
      return {
        requestedAtCode: formatKmaMinuteTime(requestedDate),
        observedAtCode,
        observations,
      };
    })
    .catch((error) => {
      temperatureFrameCache.delete(observedAtCode);
      throw error;
    });

  if (!refreshToken) temperatureFrameCache.set(observedAtCode, promise);
  return promise;
};

const fetchTemperatureFrame = async (date, stationMetadata, refreshToken) => {
  let lastError = null;
  for (const offsetMinutes of TEMPERATURE_FRAME_FALLBACK_MINUTES) {
    try {
      const frame = await fetchTemperatureFrameCandidate(
        date,
        subtractMinutes(date, offsetMinutes),
        stationMetadata,
        refreshToken,
      );
      if (frame) return frame;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`${formatKoreanWindowTime(date)} 기온 분자료를 찾지 못했습니다.`);
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const buildTemperatureTimelineDates = (startInput, endInput) => {
  const start = parseKstDateTimeInput(startInput);
  const end = parseKstDateTimeInput(endInput);
  if (!start || !end || start > end) {
    throw new Error('기온 변화 시작·종료 시각을 다시 확인해 주세요.');
  }
  const dates = [];
  for (
    let time = start.getTime();
    time <= end.getTime();
    time += TEMPERATURE_TIMELINE_STEP_MINUTES * 60 * 1000
  ) {
    dates.push(new Date(time));
  }
  if (dates.length < 2) {
    throw new Error('기온 변화 기간은 최소 30분 이상이어야 합니다.');
  }
  if (dates.length > TEMPERATURE_TIMELINE_MAX_FRAMES) {
    throw new Error('기온 변화 기간은 최대 24시간까지 선택할 수 있습니다.');
  }
  return dates;
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

export const fetchTemperatureChangeData = async (options = {}) => {
  const { start, end, refreshToken = '' } = options;
  const dates = buildTemperatureTimelineDates(start, end);
  const [awsStations, dailyRanking] = await Promise.all([
    fetchStationMetadata('AWS'),
    buildHeatwaveData(refreshToken, end.slice(0, 10)),
  ]);
  const frames = await mapWithConcurrency(
    dates,
    TEMPERATURE_FRAME_FETCH_CONCURRENCY,
    (date) => fetchTemperatureFrame(date, awsStations, refreshToken),
  );
  const uniqueFrames = frames.filter(
    (frame, index) => index === 0 || frame.observedAtCode !== frames[index - 1].observedAtCode,
  );
  if (uniqueFrames.length < 2) {
    throw new Error('재생할 기온 변화 자료가 충분하지 않습니다.');
  }
  return {
    mode: 'change',
    frames: uniqueFrames,
    ranking: dailyRanking.observations,
    startAtCode: uniqueFrames[0].observedAtCode,
    endAtCode: uniqueFrames.at(-1).observedAtCode,
  };
};

export const fetchHeatwaveBroadcastData = (mode, options = {}) =>
  mode === 'heat'
    ? buildHeatwaveData(options.refreshToken, options.targetDate)
    : buildTropicalNightData(options.refreshToken, options.targetDate);
