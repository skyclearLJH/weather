const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const OFFICIAL_WARNING_URL = 'https://www.weather.go.kr/w/wnuri-fct2021/weather/warning.do';
const WARNING_IMAGE_CACHE_KEY = 'warning-images';
const PRECOMPUTED_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

const isPrecomputedCacheDisabled = (context) =>
  ['1', 'true', 'yes', 'live', 'off', 'disabled'].includes(
    String(context.env?.DISABLE_PRECOMPUTED_WEATHER ?? '').toLowerCase(),
  );

const getWeatherCache = (context) => context.env?.WEATHER_CACHE ?? null;

const isFreshCacheRecord = (record) => {
  if (!record?.generatedAt) {
    return false;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return Number.isFinite(generatedAt) && Date.now() - generatedAt <= PRECOMPUTED_CACHE_MAX_AGE_MS;
};

const readPrecomputedWarningImages = async (context) => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || isPrecomputedCacheDisabled(context)) {
    return null;
  }

  return weatherCache.get(WARNING_IMAGE_CACHE_KEY, 'json');
};

export const writePrecomputedWarningImages = async (context, payload) => {
  const weatherCache = getWeatherCache(context);
  if (!weatherCache || !payload) {
    return;
  }

  await weatherCache.put(
    WARNING_IMAGE_CACHE_KEY,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      payload,
    }),
  );
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

const normalizeImageUrl = (value) => {
  if (!value) {
    return '';
  }

  const [cleanPath] = value.split(';');
  if (!cleanPath) {
    return '';
  }

  return cleanPath.startsWith('http') ? cleanPath : `https://www.weather.go.kr${cleanPath}`;
};

const extractWarningMapUrls = (html) => {
  const imageMatches = [...html.matchAll(/<img[^>]*data-map-mode="img"[^>]*src="([^"]+)"/gi)]
    .map((match) => normalizeImageUrl(match[1]))
    .filter(Boolean);

  return {
    current: imageMatches[0] ?? '',
    preliminary: imageMatches[1] ?? '',
  };
};

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function buildWarningImagePayload() {
  const response = await fetch(OFFICIAL_WARNING_URL, {
    cf: {
      cacheEverything: true,
      cacheTtl: 60,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP Error Status: ${response.status}`);
  }

  const html = await response.text();
  const mapUrls = extractWarningMapUrls(html);
  return {
    current: mapUrls.current,
    preliminary: mapUrls.preliminary,
    fetchedAt: new Date().toISOString(),
  };
}

export async function onRequestGet(context) {
  let cachedRecord = null;

  try {
    try {
      cachedRecord = await readPrecomputedWarningImages(context);
    } catch {
      cachedRecord = null;
    }

    if (isFreshCacheRecord(cachedRecord)) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt,
      });
    }

    const payload = await buildWarningImagePayload();
    const writePromise = writePrecomputedWarningImages(context, payload);
    if (context.waitUntil) {
      context.waitUntil(writePromise);
    } else {
      writePromise.catch(() => {});
    }

    return makeJsonResponse(payload, {
      'X-Weather-Data-Source': 'live',
    });
  } catch (error) {
    if (cachedRecord?.payload) {
      return makeJsonResponse(cachedRecord.payload, {
        'X-Weather-Data-Source': 'stale-kv',
        'X-Weather-Cache-Generated-At': cachedRecord.generatedAt ?? '',
        Warning: '110 - "Serving stale warning image data"',
      });
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
