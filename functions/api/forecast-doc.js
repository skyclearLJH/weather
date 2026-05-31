const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const OFFICIAL_FORECAST_NOTICE_URL = 'https://www.weather.go.kr/w/forecast/notice.do';
const REQUEST_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 3 * 60 * 1000;
const PAGE_CACHE = new Map();
const PAGE_IN_FLIGHT = new Map();

const REGION_META = {
  all: { label: '\uC804\uAD6D', stn: 108, officeName: '\uAE30\uC0C1\uCCAD' },
  hq: { label: '\uBCF8\uC0AC', stn: 109, officeName: '\uC218\uB3C4\uAD8C\uAE30\uC0C1\uCCAD' },
  daejeon: { label: '\uB300\uC804\uCD1D\uAD6D', stn: 133, officeName: '\uB300\uC804\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
  cheongju: { label: '\uCCAD\uC8FC\uCD1D\uAD6D', stn: 131, officeName: '\uCCAD\uC8FC\uAE30\uC0C1\uC9C0\uCCAD' },
  jeonju: { label: '\uC804\uC8FC\uCD1D\uAD6D', stn: 146, officeName: '\uC804\uC8FC\uAE30\uC0C1\uC9C0\uCCAD' },
  gwangju: { label: '\uAD11\uC8FC\uCD1D\uAD6D', stn: 156, officeName: '\uAD11\uC8FC\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
  jeju: { label: '\uC81C\uC8FC\uCD1D\uAD6D', stn: 184, officeName: '\uC81C\uC8FC\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
  chuncheon: { label: '\uCD98\uCC9C\uCD1D\uAD6D', stn: 105, officeName: '\uAC15\uC6D0\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
  daegu: { label: '\uB300\uAD6C\uCD1D\uAD6D', stn: 143, officeName: '\uB300\uAD6C\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
  busan: { label: '\uBD80\uC0B0\uCD1D\uAD6D', stn: 159, officeName: '\uBD80\uC0B0\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
  changwon: { label: '\uCC3D\uC6D0\uCD1D\uAD6D', stn: 159, officeName: '\uBD80\uC0B0\uC9C0\uBC29\uAE30\uC0C1\uCCAD' },
};

const getRegionMeta = (regionId) => REGION_META[regionId] ?? REGION_META.all;

const isManualRefreshRequest = (request) => new URL(request.url).searchParams.has('_refresh');

const getCachedPage = (key) => {
  const cached = PAGE_CACHE.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    PAGE_CACHE.delete(key);
    return null;
  }

  return cached.value;
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
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

const fetchOfficialPage = async (request, params = {}) => {
  const url = new URL(OFFICIAL_FORECAST_NOTICE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  const cacheKey = url.toString();
  const forceRefresh = isManualRefreshRequest(request);

  if (!forceRefresh) {
    const cachedPage = getCachedPage(cacheKey);
    if (cachedPage !== null) {
      return cachedPage;
    }

    if (PAGE_IN_FLIGHT.has(cacheKey)) {
      return PAGE_IN_FLIGHT.get(cacheKey);
    }
  }

  const requestPromise = fetchWithTimeout(url.toString(), forceRefresh ? { cache: 'no-store' } : {})
    .then((response) => response.text())
    .then((html) => {
      PAGE_CACHE.set(cacheKey, {
        value: html,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return html;
    })
    .finally(() => {
      PAGE_IN_FLIGHT.delete(cacheKey);
    });

  if (!forceRefresh) {
    PAGE_IN_FLIGHT.set(cacheKey, requestPromise);
  }

  return requestPromise;
};

const decodeHtmlEntities = (value = '') =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#40;/g, '(')
    .replace(/&#41;/g, ')')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));

const stripHtml = (value = '') =>
  decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/span>\s*<span/gi, '\n<span')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r/g, '')
    .replace(/\t+/g, ' ')
    .replace(/[ \u00a0]+\n/g, '\n')
    .replace(/\n[ \u00a0]+/g, '\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const normalizeReportText = (content = '') =>
  content
    .replace(/7777END/g, '')
    .replace(/[=\s]+$/g, '')
    .trim();

const extractViewSectionHtml = (html) =>
  html.match(/<section class=["'][^"']*cmp-view[^"']*["'][^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? '';

const extractContentHtml = (sectionHtml) =>
  sectionHtml.match(/<div class=["']cmp-view-content["']>([\s\S]*?)<\/div>\s*<div class=["']cmp-stack/i)?.[1] ??
  sectionHtml.match(/<div class=["']cmp-view-content["']>([\s\S]*?)<\/div>/i)?.[1] ??
  '';

const extractTitle = (sectionHtml) =>
  stripHtml(
    sectionHtml.match(/<div class=["'][^"']*cmp-view-header[^"']*["'][^>]*>\s*<h4>([\s\S]*?)<\/h4>/i)?.[1] ?? '',
  );

const extractAnnounce = (sectionHtml) =>
  stripHtml(sectionHtml.match(/<div class=["']cmp-view-announce["']>([\s\S]*?)<\/div>/i)?.[1] ?? '');

const extractPdfUrl = (html) => {
  const pdfPath = html.match(/href=["']([^"']*rpt_wid_day_[^"']*\.pdf)["']/i)?.[1] ?? '';
  if (!pdfPath) {
    return '';
  }

  return pdfPath.startsWith('http') ? pdfPath : `https://www.weather.go.kr${pdfPath}`;
};

const normalizeTmfc = (tmfc = '') => {
  if (/^\d{12}$/.test(tmfc)) {
    return tmfc;
  }

  if (/^\d{10}$/.test(tmfc)) {
    return `${tmfc}00`;
  }

  return '';
};

const parseTmfcFromAnnounce = (announceText = '') => {
  const match = announceText.match(
    /(\d{4})\uB144\s*(\d{1,2})\uC6D4\s*(\d{1,2})\uC77C[\s\S]*?(\d{1,2}):(\d{2})\s*\uBC1C\uD45C/,
  );
  if (!match) {
    return '';
  }

  const [, year, month, day, hour, minute] = match;
  return `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}${hour.padStart(2, '0')}${minute}`;
};

const formatDisplayTime = (tmfc) => {
  const normalized = normalizeTmfc(tmfc);
  if (!normalized) {
    return '';
  }

  return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}.${normalized.slice(6, 8)} ${normalized.slice(8, 10)}:${normalized.slice(10, 12)} \uBC1C\uD45C`;
};

const buildForecastDocPayload = async (request, regionId) => {
  const regionMeta = getRegionMeta(regionId);
  const html = await fetchOfficialPage(request, { stnId: regionMeta.stn });
  const sectionHtml = extractViewSectionHtml(html);
  const content = normalizeReportText(stripHtml(extractContentHtml(sectionHtml)));
  if (!content || content.includes('\uBC1C\uD45C\uB41C \uC790\uB8CC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4')) {
    throw new Error('Official forecast notice content was not found.');
  }

  const title = extractTitle(sectionHtml);
  const tmfc = parseTmfcFromAnnounce(extractAnnounce(sectionHtml));
  const normalizedTmfc = normalizeTmfc(tmfc);

  return [
    {
      id: `official-forecast-doc-${regionId}-${normalizedTmfc || Date.now()}`,
      title: `\uD1B5\uBCF4\uBB38 (${regionMeta.officeName})`,
      time: formatDisplayTime(normalizedTmfc),
      content: title ? `${title}\n${content}` : content,
      region: regionMeta.label,
      tmfc: normalizedTmfc,
      source: 'weather.go.kr',
      pdfUrl: extractPdfUrl(html),
    },
  ];
};

const makeJsonResponse = (payload, headers = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Cache-Control': 'public, max-age=30, s-maxage=180',
      ...headers,
    },
  });

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const regionId = requestUrl.searchParams.get('region') || 'all';

  try {
    if (!REGION_META[regionId]) {
      return new Response(JSON.stringify({ error: 'Invalid region.' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const payload = await buildForecastDocPayload(context.request, regionId);
    return makeJsonResponse(payload, {
      'X-Weather-Data-Source': 'weather.go.kr',
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
