const CACHE_PREFIX = 'satellite/gk2a-ir/v1/pairs/';
const TEN_MINUTES_MS = 10 * 60 * 1000;
const TIMELINE_HOURS = 12;

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const pad = (value) => String(value).padStart(2, '0');

const formatUtc = (date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
  `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;

const parseUtc = (value) =>
  new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
      Number(value.slice(8, 10)),
      Number(value.slice(10, 12)),
    ),
  );

const isDailyGap = (date) => date.getUTCHours() === 15 && date.getUTCMinutes() === 20;

const buildTimeline = (latest) => {
  const latestDate = parseUtc(latest);
  const count = Math.floor((TIMELINE_HOURS * 60) / 10);
  const dates = [];
  for (let index = 0; index <= count; index++) {
    const date = new Date(latestDate.getTime() - index * TEN_MINUTES_MS);
    if (!isDailyGap(date)) dates.push(formatUtc(date));
  }
  return dates;
};

const listStoredDates = async (store) => {
  const dates = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: CACHE_PREFIX, cursor });
    for (const key of page.keys ?? []) {
      const match = key.name.match(/(\d{12})\.bin\.gz$/);
      if (match) dates.add(match[1]);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return dates;
};

const getLatest = async (origin) => {
  const response = await fetch(`${origin}/api/gk2a-ir?latest=1`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`latest satellite request failed (${response.status})`);
  const data = await response.json();
  if (!/^\d{12}$/.test(data.latest ?? '')) {
    throw new Error('latest satellite timestamp is invalid');
  }
  return data.latest;
};

const precompute = async (env) => {
  const store = env.SATELLITE_CACHE || env.KIM_RAIN_CACHE;
  if (!store) throw new Error('SATELLITE_CACHE binding is missing');
  const origin = String(env.SATELLITE_ORIGIN || 'https://weather-ljh.pages.dev').replace(/\/$/, '');
  const batchSize = Math.max(1, Math.min(3, Number(env.SATELLITE_BATCH_SIZE) || 2));
  const latest = await getLatest(origin);
  const timeline = buildTimeline(latest);
  const stored = await listStoredDates(store);
  const missing = timeline.filter((date) => !stored.has(date));
  const targets = [];
  if (missing.length > 0) {
    targets.push(missing[0]);
    for (let index = missing.length - 1; index > 0 && targets.length < batchSize; index--) {
      targets.push(missing[index]);
    }
  }

  const results = await Promise.all(targets.map(async (date) => {
    try {
      const response = await fetch(
        `${origin}/api/gk2a-ir?date=${date}&area=pair&precompute=1`,
        {
        signal: AbortSignal.timeout(120000),
        },
      );
      await response.arrayBuffer();
      return {
        date,
        ok: response.ok,
        status: response.status,
        source: response.headers.get('X-Satellite-Data-Source'),
      };
    } catch (error) {
      return { date, ok: false, error: error.message };
    }
  }));

  return {
    checkedAt: new Date().toISOString(),
    latest,
    storedFrameCount: stored.size,
    requestedFrameCount: targets.length,
    results,
  };
};

const status = async (env) => {
  const store = env.SATELLITE_CACHE || env.KIM_RAIN_CACHE;
  if (!store) throw new Error('SATELLITE_CACHE binding is missing');
  const origin = String(env.SATELLITE_ORIGIN || 'https://weather-ljh.pages.dev').replace(/\/$/, '');
  const latest = await getLatest(origin);
  const timeline = buildTimeline(latest);
  const stored = await listStoredDates(store);
  const available = timeline.filter((date) => stored.has(date));
  return {
    checkedAt: new Date().toISOString(),
    ready: available.length > 0,
    latest,
    timelineFrameCount: timeline.length,
    precomputedFrameCount: available.length,
    newestPrecomputed: available[0] ?? null,
    oldestPrecomputed: available.at(-1) ?? null,
  };
};

const isAuthorizedRefresh = (request, env) => {
  if (!env.CACHE_REFRESH_TOKEN) return false;
  return request.headers.get('Authorization') === `Bearer ${env.CACHE_REFRESH_TOKEN}`;
};

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(precompute(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/status') return jsonResponse(await status(env));
      if (url.pathname === '/refresh') {
        if (!isAuthorizedRefresh(request, env)) {
          return jsonResponse({ error: 'Unauthorized refresh request.' }, 401);
        }
        return jsonResponse(await precompute(env));
      }
      return jsonResponse({
        name: 'weathernow-satellite-precompute',
        endpoints: ['/status', '/refresh'],
      });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};
