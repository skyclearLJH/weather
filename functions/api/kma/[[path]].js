const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RECENT_OBSERVATION_AGE_MS = 15 * 60 * 1000;
const HISTORICAL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PROXY_CACHE_VERSION = '20260716-1';

const parseKstTimestamp = (value) => {
  if (!/^\d{12}$/.test(value ?? '')) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  return Date.UTC(year, month, day, hour, minute) - KST_OFFSET_MS;
};

const isHistoricalTimestamp = (value) => {
  const timestamp = parseKstTimestamp(value);
  return timestamp !== null && Date.now() - timestamp >= RECENT_OBSERVATION_AGE_MS;
};

const getKstDay = () => new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10).replaceAll('-', '');

const getCacheTtl = (pathname, searchParams) => {
  if (pathname.includes('/nph-aws2_min')) {
    if (!searchParams.has('tm1') && isHistoricalTimestamp(searchParams.get('tm2'))) {
      return HISTORICAL_CACHE_TTL_SECONDS;
    }
    return 60;
  }

  if (pathname.includes('/awsh.php')) {
    return isHistoricalTimestamp(searchParams.get('tm')) ? HISTORICAL_CACHE_TTL_SECONDS : 60;
  }

  if (pathname.includes('/wrn_now_data.php') || pathname.includes('/kma_snow1.php')) {
    return 60;
  }

  if (
    pathname.includes('/stn_snow.php') ||
    pathname.includes('/stn_inf.php') ||
    pathname.includes('/wrn_reg.php') ||
    pathname.includes('/fct_shrt_reg.php') ||
    pathname.includes('/sfc_norm1.php')
  ) {
    return 86400;
  }

  if (pathname.includes('/fct_afs_dl.php')) {
    return 180;
  }

  if (pathname.includes('/sfc_aws_day.php')) {
    const requestedDay = searchParams.get('tm2');
    return /^\d{8}$/.test(requestedDay ?? '') && requestedDay < getKstDay()
      ? HISTORICAL_CACHE_TTL_SECONDS
      : 300;
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

const makeKmaCacheKey = (targetUrl) => {
  const cacheKeyUrl = new URL(targetUrl);
  cacheKeyUrl.searchParams.delete('authKey');
  cacheKeyUrl.searchParams.set('_proxy_cache', PROXY_CACHE_VERSION);
  return cacheKeyUrl.toString();
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
              cacheKey: makeKmaCacheKey(targetUrl),
              cacheTtlByStatus: {
                '200-299': cacheTtl,
                '300-599': 0,
              },
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

// 레이더 파일·초단기 예측 분포도는 아직 생성 전인 시각을 요청하면 KMA가
// HTTP 200 + "file not exist" 텍스트를 돌려준다. 이걸 그대로 오래 캐시하면
// 실제 파일이 나온 뒤에도 한동안 '없음'으로 고정되므로(타임라인 멈춤 현상),
// 본문이 진짜 자료(gzip/PNG)일 때만 엣지 캐시에 저장한다.
const VALIDATED_CACHE_PATHS = ['/rdr_cmp_file.php', '/nph-qpf_ana_img', '/awsh.php'];
const RADAR_CACHE_TTL_SECONDS = 3600;

const isValidRadarPayload = (bytes) => {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return true; // gzip 바이너리
  }
  if (
    bytes.length > 4096 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return true; // PNG 분포도 (오류·빈 이미지는 작아서 걸러짐)
  }
  // AWS 시간통계 등 텍스트 자료: 지점 데이터 줄('\n' + 연도 '2')이 충분히
  // 많으면 정상 발표분으로 본다. 미발표·오류 응답은 줄 수가 거의 없다.
  if (bytes.length > 4096 && bytes[0] === 0x23) {
    let dataLines = 0;
    for (let index = 1; index < bytes.length; index++) {
      if (bytes[index - 1] === 0x0a && bytes[index] === 0x32) {
        dataLines++;
        if (dataLines >= 200) {
          return true;
        }
      }
    }
  }
  return false;
};

const handleValidatedRadarRequest = async (context, targetUrl, forceRefresh, cacheTtl) => {
  const cacheKeyUrl = new URL(targetUrl);
  cacheKeyUrl.searchParams.delete('authKey');
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });
  const edgeCache = globalThis.caches?.default;

  if (edgeCache && !forceRefresh) {
    const hit = await edgeCache.match(cacheKey);
    if (hit) {
      return hit;
    }
  }

  const originResponse = await fetch(targetUrl.toString(), { redirect: 'follow' });
  const body = await originResponse.arrayBuffer();
  const valid = originResponse.ok && isValidRadarPayload(new Uint8Array(body));

  const headers = new Headers(corsHeaders);
  headers.set(
    'Content-Type',
    originResponse.headers.get('content-type') ?? 'application/octet-stream',
  );
  headers.set(
    'Cache-Control',
    valid ? `public, max-age=30, s-maxage=${cacheTtl}` : 'no-store',
  );

  if (valid && edgeCache) {
    const stored = new Response(body.slice(0), { status: 200, headers });
    const putPromise = edgeCache.put(cacheKey, stored).catch(() => {});
    if (context.waitUntil) {
      context.waitUntil(putPromise);
    }
  }

  return new Response(body, { status: originResponse.status, headers });
};

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

    if (
      request.method === 'GET' &&
      VALIDATED_CACHE_PATHS.some((path) => targetUrl.pathname.includes(path))
    ) {
      const validatedCacheTtl = targetUrl.pathname.includes('/awsh.php')
        ? cacheTtl
        : RADAR_CACHE_TTL_SECONDS;
      return await handleValidatedRadarRequest(
        context,
        targetUrl,
        forceRefresh,
        validatedCacheTtl,
      );
    }

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
      nextHeaders.set(
        'Cache-Control',
        forceRefresh || !response.ok ? 'no-store' : `public, max-age=30, s-maxage=${cacheTtl}`,
      );
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
