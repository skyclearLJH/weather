const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const getCacheTtl = (pathname, searchParams) => {
  if (pathname.includes('/nph-aws2_min')) {
    return 60;
  }

  if (pathname.includes('/wrn_now_data.php') || pathname.includes('/kma_snow1.php')) {
    return 60;
  }

  if (pathname.includes('/stn_snow.php') || pathname.includes('/stn_inf.php')) {
    return 86400;
  }

  if (pathname.includes('/sfc_aws_day.php')) {
    return 300;
  }

  if (pathname.includes('/wthr_cmt_rpt.php') || pathname.includes('/fct_afs_ds.php')) {
    return 180;
  }

  if (searchParams.get('help') === '1') {
    return 300;
  }

  return 60;
};

const readAuthKey = (context) =>
  context.env?.KMA_AUTH_KEY ||
  context.env?.VITE_KMA_AUTH_KEY ||
  process.env.KMA_AUTH_KEY ||
  process.env.VITE_KMA_AUTH_KEY ||
  '';

const makeKmaRequest = (context, targetUrl) => {
  const { request } = context;
  const headers = new Headers();
  const accept = request.headers.get('accept');
  const contentType = request.headers.get('content-type');

  if (accept) {
    headers.set('accept', accept);
  }

  if (contentType) {
    headers.set('content-type', contentType);
  }

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    redirect: 'follow',
  });
};

const fetchKma = (context, targetUrl, cacheTtl, forceRefresh = false) => {
  const request = makeKmaRequest(context, targetUrl);
  const method = context.request.method;

  return fetch(request, method === 'GET' || method === 'HEAD'
    ? {
        ...(forceRefresh
          ? { cache: 'no-store' }
          : {
              cf: {
                cacheEverything: true,
                cacheTtl,
              },
            }),
      }
    : undefined);
};

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

export async function onRequest(context) {
  const { request, params } = context;
  const pathSegments = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);

  if (pathSegments.length === 0) {
    return new Response('Missing KMA API path.', {
      status: 400,
      headers: corsHeaders,
    });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`https://apihub.kma.go.kr/${pathSegments.join('/')}`);

  incomingUrl.searchParams.forEach((value, key) => {
    if (key !== 'authKey' && key !== '_refresh') {
      targetUrl.searchParams.set(key, value);
    }
  });

  const authKey = readAuthKey(context);
  if (authKey) {
    targetUrl.searchParams.set('authKey', authKey);
  }

  try {
    const cacheTtl = getCacheTtl(targetUrl.pathname, targetUrl.searchParams);
    const forceRefresh = incomingUrl.searchParams.has('_refresh');
    let response = await fetchKma(context, targetUrl, cacheTtl, forceRefresh);

    if (response.status === 401 && authKey) {
      targetUrl.searchParams.delete('authKey');
      response = await fetchKma(context, targetUrl, cacheTtl, forceRefresh);
    }

    const nextHeaders = new Headers(response.headers);

    Object.entries(corsHeaders).forEach(([key, value]) => {
      nextHeaders.set(key, value);
    });

    if (request.method === 'GET' || request.method === 'HEAD') {
      nextHeaders.set('Cache-Control', forceRefresh ? 'no-store' : `public, max-age=30, s-maxage=${cacheTtl}`);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: nextHeaders,
    });
  } catch (error) {
    return new Response(`Error proxying to KMA API: ${error.message}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
}
