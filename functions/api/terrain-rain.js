const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const WIND_LAYER_URL =
  'https://portal.esrikr.com/arcgis/rest/services/Hosted/WindSpeedDirection_2dayFC/FeatureServer/0/query';
const HOUR_MS = 60 * 60 * 1000;
const QUERY_WINDOW_HOURS = 3;

const jsonResponse = (payload, status = 200, cacheControl = 'public, max-age=900') =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });

const formatArcGisTimestamp = (timestamp) => {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:00:00`;
};

const normalizeTargetTime = (value) => {
  const parsed = Date.parse(value ?? '');
  const timestamp = Number.isFinite(parsed) ? parsed : Date.now();
  return Math.round(timestamp / HOUR_MS) * HOUR_MS;
};

const normalizePoint = (attributes) => {
  const lon = Number(attributes.lon);
  const lat = Number(attributes.lat);
  const speed = Number(attributes.wsd);
  const direction = Number(attributes.vec);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(speed) ||
    !Number.isFinite(direction) ||
    lon < 123 ||
    lon > 132 ||
    lat < 32 ||
    lat > 40 ||
    speed < 0 ||
    speed > 100
  ) {
    return null;
  }
  return {
    id: String(attributes.stn ?? ''),
    name: String(attributes.stationname ?? attributes.stn ?? ''),
    lon,
    lat,
    speed,
    direction: ((direction % 360) + 360) % 360,
  };
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const targetTime = normalizeTargetTime(requestUrl.searchParams.get('tm'));
  const windowMs = QUERY_WINDOW_HOURS * HOUR_MS;
  const where =
    `fcstdatetime_dt BETWEEN TIMESTAMP '${formatArcGisTimestamp(targetTime - windowMs)}' ` +
    `AND TIMESTAMP '${formatArcGisTimestamp(targetTime + windowMs)}'`;
  const sourceUrl = new URL(WIND_LAYER_URL);
  sourceUrl.searchParams.set('where', where);
  sourceUrl.searchParams.set(
    'outFields',
    'stn,stationname,wsd,vec,fcstdatetime_dt,basedatetime_dt,lat,lon',
  );
  sourceUrl.searchParams.set('returnGeometry', 'false');
  sourceUrl.searchParams.set('resultRecordCount', '2000');
  sourceUrl.searchParams.set('f', 'json');

  try {
    const response = await fetch(sourceUrl, {
      headers: { Accept: 'application/json' },
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { '200-299': 900, '300-599': 0 },
      },
    });
    if (!response.ok) {
      throw new Error(`풍향·풍속 원본 응답 오류 (${response.status})`);
    }
    const payload = await response.json();
    const features = Array.isArray(payload?.features) ? payload.features : [];
    if (features.length === 0) {
      return jsonResponse({ error: '해당 시각의 지상풍 예보가 없습니다.' }, 404, 'no-store');
    }

    const availableTimes = [...new Set(
      features
        .map((feature) => Number(feature?.attributes?.fcstdatetime_dt))
        .filter(Number.isFinite),
    )];
    const validTime = availableTimes.reduce(
      (closest, candidate) =>
        Math.abs(candidate - targetTime) < Math.abs(closest - targetTime) ? candidate : closest,
      availableTimes[0],
    );
    const selected = features.filter(
      (feature) => Number(feature?.attributes?.fcstdatetime_dt) === validTime,
    );
    const points = selected
      .map((feature) => normalizePoint(feature.attributes ?? {}))
      .filter(Boolean);
    if (points.length < 20) {
      return jsonResponse({ error: '지상풍 예보 지점이 충분하지 않습니다.' }, 502, 'no-store');
    }
    const baseTime = selected
      .map((feature) => Number(feature?.attributes?.basedatetime_dt))
      .find(Number.isFinite);

    return jsonResponse({
      requestedTime: new Date(targetTime).toISOString(),
      validTime: new Date(validTime).toISOString(),
      baseTime: Number.isFinite(baseTime) ? new Date(baseTime).toISOString() : null,
      level: 'surface',
      source: '기상청 API허브 단기예보',
      points,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : '지상풍 예보를 불러오지 못했습니다.' },
      502,
      'no-store',
    );
  }
}
