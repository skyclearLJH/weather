const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

const OFFICIAL_WARNING_URL = 'https://www.weather.go.kr/w/wnuri-fct2021/weather/warning.do';

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

export async function onRequestGet() {
  try {
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
    const payload = {
      current: mapUrls.current,
      preliminary: mapUrls.preliminary,
      fetchedAt: new Date().toISOString(),
    };

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
