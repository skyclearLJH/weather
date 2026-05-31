const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const FORECAST_CACHE_MAX_STALE_AGE_MS = 36 * 60 * 60 * 1000;
const FORECAST_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
const FORECAST_CACHE_API_MAX_AGE_SECONDS = 60 * 60;
const FORECAST_REFRESH_IN_FLIGHT = new Map();
const KMA_TEXT_CACHE = new Map();
const KMA_TEXT_IN_FLIGHT = new Map();

const padZero = (value) => value.toString().padStart(2, '0');

export const FORECAST_KINDS = ['doc', 'commentary'];

const REGION_META = {
  all: { label: '전국', stn: 108 },
  hq: { label: '본사', stn: 109 },
  daejeon: { label: '대전총국', stn: 133 },
  cheongju: { label: '청주총국', stn: 131 },
  jeonju: { label: '전주총국', stn: 146 },
  gwangju: { label: '광주총국', stn: 156 },
  jeju: { label: '제주총국', stn: 184 },
  chuncheon: { label: '춘천총국', stn: 105 },
  daegu: { label: '대구총국', stn: 143 },
  busan: { label: '부산총국', stn: 159 },
  changwon: { label: '창원총국', stn: 159 },
};

export const FORECAST_REGION_IDS = Object.keys(REGION_META);

const OFFICE_NAMES = {
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

const DOC_RELEASES = [
  { hour: 5, minute: 0, readyHour: 5, readyMinute: 10 },
  { hour: 11, minute: 0, readyHour: 11, readyMinute: 10 },
  { hour: 17, minute: 0, readyHour: 17, readyMinute: 10 },
];

const COMMENTARY_RELEASES = [
  { hour: 4, minute: 20, readyHour: 4, readyMinute: 50 },
  { hour: 16, minute: 20, readyHour: 16, readyMinute: 50 },
];

const COMMENTARY_WINDOWS = [
  { startHour: 4, startMinute: 0, releaseHour: 4, releaseMinute: 20, endHour: 5, endMinute: 10 },
  { startHour: 16, startMinute: 0, releaseHour: 16, releaseMinute: 20, endHour: 17, endMinute: 10 },
];

const getKstNow = () => new Date(Date.now() + KST_OFFSET_MS);

const cloneAtKstTime = (baseDate, hour, minute = 0) => {
  const date = new Date(baseDate);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
};

const subtractHours = (date, hours) => new Date(date.getTime() - hours * 60 * 60 * 1000);
const subtractDays = (date, days) => new Date(date.getTime() - days * 24 * 60 * 60 * 1000);

const formatKmaMinuteTime = (date) => {
  const year = date.getUTCFullYear();
  const month = padZero(date.getUTCMonth() + 1);
  const day = padZero(date.getUTCDate());
  const hour = padZero(date.getUTCHours());
  const minute = padZero(date.getUTCMinutes());
  return `${year}${month}${day}${hour}${minute}`;
};

const formatKmaHourTime = (date) => formatKmaMinuteTime(date).slice(0, 10);

const normalizeTmfcForCompare = (tmfc = '') => {
  if (/^\d{12}$/.test(tmfc)) {
    return tmfc;
  }

  if (/^\d{10}$/.test(tmfc)) {
    return `${tmfc}00`;
  }

  return '';
};

const formatDisplayTime = (tmfc) => {
  const normalized = normalizeTmfcForCompare(tmfc);
  if (!normalized) {
    return '';
  }

  const year = normalized.slice(0, 4);
  const month = normalized.slice(4, 6);
  const day = normalized.slice(6, 8);
  const hour = normalized.slice(8, 10);
  const minute = normalized.slice(10, 12);
  return `${year}.${month}.${day} ${hour}:${minute} 발표`;
};

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
            'Cache-Control': `public, max-age=${FORECAST_CACHE_API_MAX_AGE_SECONDS}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        }),
      );
    },
  };
};

const getWeatherCache = (context) => context.env?.WEATHER_CACHE ?? createCacheApiStore();

export const getForecastCacheKey = (kind, regionId) => `forecast:${kind}:${regionId}`;

const getPayloadTmfc = (payload) => normalizeTmfcForCompare(payload?.[0]?.tmfc ?? '');

const isUsableForecastRecord = (record) => {
  if (!record?.payload || !record.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= FORECAST_CACHE_MAX_STALE_AGE_MS;
};

const wasCheckedRecently = (record) => {
  const generatedAt = Date.parse(record?.generatedAt ?? '');
  return Number.isFinite(generatedAt) && Date.now() - generatedAt < FORECAST_RECHECK_INTERVAL_MS;
};

const getExpectedLatestTmfc = (kind, now = getKstNow()) => {
  const releases = kind === 'doc' ? DOC_RELEASES : COMMENTARY_RELEASES;
  const candidates = [0, 1, 2]
    .flatMap((dayOffset) => {
      const baseDate = subtractDays(now, dayOffset);
      return releases.map((release) => ({
        tmfcAt: cloneAtKstTime(baseDate, release.hour, release.minute),
        readyAt: cloneAtKstTime(
          baseDate,
          release.readyHour ?? release.hour,
          release.readyMinute ?? release.minute,
        ),
      }));
    })
    .filter((candidate) => candidate.readyAt <= now)
    .sort((left, right) => right.tmfcAt.getTime() - left.tmfcAt.getTime());

  return candidates.length > 0 ? formatKmaMinuteTime(candidates[0].tmfcAt) : '';
};

const shouldTryLiveRefresh = (record, kind) => {
  if (!isUsableForecastRecord(record) || wasCheckedRecently(record)) {
    return false;
  }

  const expectedLatestTmfc = getExpectedLatestTmfc(kind);
  const cachedTmfc = getPayloadTmfc(record.payload);
  return Boolean(expectedLatestTmfc && (!cachedTmfc || cachedTmfc < expectedLatestTmfc));
};

export const writePrecomputedForecast = async (context, kind, regionId, payload) => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || !payload) {
    return;
  }

  await weatherCache.put(
    getForecastCacheKey(kind, regionId),
    JSON.stringify({
      kind,
      regionId,
      generatedAt: new Date().toISOString(),
      payload,
    }),
  );
};

const readPrecomputedForecastRecord = async (context, kind, regionId) => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || isPrecomputedCacheDisabled(context)) {
    return null;
  }

  return weatherCache.get(getForecastCacheKey(kind, regionId), 'json');
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

const fetchKmaText = async (context, path, params = {}, timeoutMs = 12000, cacheTtl = 180) => {
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
      const tmfc = normalizeTmfcForCompare(fields[2]);

      if (stn === targetStn) {
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

const getReportMeta = (regionId) => REGION_META[regionId] ?? REGION_META.all;

const buildReportCard = (kind, regionId, content, tmfc) => {
  const meta = getReportMeta(regionId);
  const officeName = OFFICE_NAMES[meta.stn] ?? '기상청';

  return [
    {
      id: `forecast-${kind}-${regionId}-${tmfc || Date.now()}`,
      title: kind === 'doc' ? `통보문 (${officeName})` : `날씨해설 (${officeName})`,
      time: formatDisplayTime(tmfc),
      content: content || (kind === 'doc'
        ? '표출 가능한 통보문이 아직 없습니다.'
        : '표출 가능한 날씨해설이 아직 없습니다.'),
      region: meta.label,
      tmfc,
    },
  ];
};

const buildForecastDocCandidates = (now) =>
  [0, 1, 2]
    .flatMap((dayOffset) => {
      const baseDate = subtractDays(now, dayOffset);
      return DOC_RELEASES.map((release) => {
        const issuedAt = cloneAtKstTime(baseDate, release.hour, release.minute);
        return {
          issuedAt,
          endAt: new Date(issuedAt.getTime() + 70 * 60 * 1000),
        };
      });
    })
    .filter((candidate) => candidate.issuedAt <= now)
    .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());

const buildCommentaryCandidates = (now) =>
  [0, 1, 2]
    .flatMap((dayOffset) => {
      const baseDate = subtractDays(now, dayOffset);
      return COMMENTARY_WINDOWS.map((window) => {
        const releaseAt = cloneAtKstTime(baseDate, window.releaseHour, window.releaseMinute);
        return {
          releaseAt,
          startAt: cloneAtKstTime(baseDate, window.startHour, window.startMinute),
          endAt: cloneAtKstTime(baseDate, window.endHour, window.endMinute),
        };
      });
    })
    .filter((candidate) => candidate.releaseAt <= now)
    .sort((left, right) => right.releaseAt.getTime() - left.releaseAt.getTime());

const fetchWeatherDocLive = async (context, regionId) => {
  const now = getKstNow();
  const { stn } = getReportMeta(regionId);
  let lastError = null;

  for (const candidate of buildForecastDocCandidates(now)) {
    try {
      const rawText = await fetchKmaText(
        context,
        'api/typ01/url/fct_afs_ds.php',
        {
          tmfc1: formatKmaHourTime(candidate.issuedAt),
          tmfc2: formatKmaHourTime(candidate.endAt),
          stn,
          disp: 0,
          help: 0,
        },
        9000,
        180,
      );
      const { content, tmfc } = parseKmaReport(rawText, stn, 7);
      if (tmfc || content) {
        return buildReportCard('doc', regionId, content, tmfc);
      }
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const rawText = await fetchKmaText(
      context,
      'api/typ01/url/fct_afs_ds.php',
      {
        tmfc1: formatKmaHourTime(subtractDays(now, 2)),
        tmfc2: formatKmaHourTime(new Date(now.getTime() + 60 * 60 * 1000)),
        stn,
        disp: 0,
        help: 0,
      },
      12000,
      180,
    );
    const { content, tmfc } = parseKmaReport(rawText, stn, 7);
    if (tmfc || content) {
      return buildReportCard('doc', regionId, content, tmfc);
    }
  } catch (error) {
    lastError = error;
  }

  throw lastError ?? new Error('Forecast bulletin was not found.');
};

const fetchWeatherCommentaryLive = async (context, regionId) => {
  const now = getKstNow();
  const { stn } = getReportMeta(regionId);
  let lastError = null;

  for (const candidate of buildCommentaryCandidates(now)) {
    try {
      const rawText = await fetchKmaText(
        context,
        'api/typ01/url/wthr_cmt_rpt.php',
        {
          tmfc1: formatKmaMinuteTime(candidate.startAt),
          tmfc2: formatKmaMinuteTime(candidate.endAt > now ? now : candidate.endAt),
          stn,
          subcd: 12,
          disp: 0,
          help: 0,
        },
        9000,
        180,
      );
      const { content, tmfc } = parseKmaReport(rawText, stn, 9);
      if (tmfc || content) {
        return buildReportCard('commentary', regionId, content, tmfc);
      }
    } catch (error) {
      lastError = error;
    }
  }

  for (const lookbackHours of [12, 24, 48, 72]) {
    try {
      const rawText = await fetchKmaText(
        context,
        'api/typ01/url/wthr_cmt_rpt.php',
        {
          tmfc1: formatKmaMinuteTime(subtractHours(now, lookbackHours)),
          tmfc2: formatKmaMinuteTime(now),
          stn,
          subcd: 12,
          disp: 0,
          help: 0,
        },
        9000,
        180,
      );
      const { content, tmfc } = parseKmaReport(rawText, stn, 9);
      if (tmfc || content) {
        return buildReportCard('commentary', regionId, content, tmfc);
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Weather commentary was not found.');
};

export const buildForecastPayload = async (context, kind, regionId) => {
  if (!FORECAST_KINDS.includes(kind)) {
    throw new Error('Invalid forecast kind.');
  }

  if (!FORECAST_REGION_IDS.includes(regionId)) {
    throw new Error('Invalid forecast region.');
  }

  return kind === 'doc'
    ? fetchWeatherDocLive(context, regionId)
    : fetchWeatherCommentaryLive(context, regionId);
};

export const refreshPrecomputedForecast = async (context, kind, regionId) => {
  const payload = await buildForecastPayload(context, kind, regionId);
  await writePrecomputedForecast(context, kind, regionId, payload);
  return payload;
};

const schedulePrecomputedForecastRefresh = (context, kind, regionId) => {
  if (isPrecomputedCacheDisabled(context) || !getWeatherCache(context)) {
    return null;
  }

  const cacheKey = getForecastCacheKey(kind, regionId);
  if (FORECAST_REFRESH_IN_FLIGHT.has(cacheKey)) {
    return FORECAST_REFRESH_IN_FLIGHT.get(cacheKey);
  }

  const refreshPromise = refreshPrecomputedForecast(context, kind, regionId)
    .finally(() => {
      FORECAST_REFRESH_IN_FLIGHT.delete(cacheKey);
    });

  FORECAST_REFRESH_IN_FLIGHT.set(cacheKey, refreshPromise);

  if (context.waitUntil) {
    context.waitUntil(refreshPromise);
  } else {
    refreshPromise.catch(() => {});
  }

  return refreshPromise;
};

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const kind = requestUrl.searchParams.get('kind') || 'doc';
  const regionId = requestUrl.searchParams.get('region') || 'all';
  const forceRefresh = requestUrl.searchParams.has('_refresh');
  let cachedRecord = null;

  try {
    if (!FORECAST_KINDS.includes(kind)) {
      return new Response(JSON.stringify({ error: 'Invalid forecast kind.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!FORECAST_REGION_IDS.includes(regionId)) {
      return new Response(JSON.stringify({ error: 'Invalid forecast region.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    try {
      cachedRecord = await readPrecomputedForecastRecord(context, kind, regionId);
    } catch {
      cachedRecord = null;
    }

    if (!forceRefresh && isUsableForecastRecord(cachedRecord) && !shouldTryLiveRefresh(cachedRecord, kind)) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt,
      });
    }

    if (!forceRefresh && isUsableForecastRecord(cachedRecord)) {
      schedulePrecomputedForecastRefresh(context, kind, regionId);
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Refreshing forecast data in the background"',
      });
    }

    const payload = await refreshPrecomputedForecast(context, kind, regionId);

    return makeJsonResponse(payload, {
      'X-Weather-Data-Source': forceRefresh ? 'manual-refresh' : 'live',
    });
  } catch (error) {
    if (isUsableForecastRecord(cachedRecord)) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Serving stale forecast data"',
      });
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
