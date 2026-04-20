const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const readAuthKey = (context) =>
  context.env?.KMA_AUTH_KEY ||
  context.env?.VITE_KMA_AUTH_KEY ||
  process.env.KMA_AUTH_KEY ||
  process.env.VITE_KMA_AUTH_KEY ||
  '';

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
    if (key !== 'authKey') {
      targetUrl.searchParams.set(key, value);
    }
  });

  const authKey = readAuthKey(context);
  if (authKey) {
    targetUrl.searchParams.set('authKey', authKey);
  }

  try {
    const proxiedRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
      redirect: 'follow',
    });

    const response = await fetch(proxiedRequest);
    const nextHeaders = new Headers(response.headers);

    Object.entries(corsHeaders).forEach(([key, value]) => {
      nextHeaders.set(key, value);
    });

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
