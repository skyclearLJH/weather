import {
  RANKING_KINDS,
  buildRankingPayload,
  getRankingCacheKey,
  writePrecomputedRanking,
} from '../functions/api/rankings.js';
import {
  buildWarningImagePayload,
  writePrecomputedWarningImages,
} from '../functions/api/weather-warning.js';
import {
  FORECAST_KINDS,
  FORECAST_REGION_IDS,
  buildForecastPayload,
  getForecastCacheKey,
  writePrecomputedForecast,
} from '../functions/api/forecast.js';

const WARNING_IMAGE_CACHE_KEY = 'warning-images';
const FORECAST_REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
const FORECAST_PRECOMPUTE_CONCURRENCY = 3;

const makeContext = (env, request = new Request('https://weathernow.local/cron')) => ({
  env,
  request,
});

const refreshRankings = async (context) => {
  const results = [];

  for (const kind of RANKING_KINDS) {
    try {
      const payload = await buildRankingPayload(context, kind);
      await writePrecomputedRanking(context, kind, payload);
      results.push({ kind, ok: true, observedAt: payload.observedAt ?? '' });
    } catch (error) {
      results.push({ kind, ok: false, error: error.message });
    }
  }

  return results;
};

const refreshWarningImages = async (context) => {
  try {
    const payload = await buildWarningImagePayload();
    await writePrecomputedWarningImages(context, payload);
    return { kind: WARNING_IMAGE_CACHE_KEY, ok: true, fetchedAt: payload.fetchedAt };
  } catch (error) {
    return { kind: WARNING_IMAGE_CACHE_KEY, ok: false, error: error.message };
  }
};

const shouldRefreshForecastRecord = (record) => {
  if (!record?.generatedAt) {
    return true;
  }

  const generatedAt = Date.parse(record.generatedAt);
  return !Number.isFinite(generatedAt) || Date.now() - generatedAt >= FORECAST_REFRESH_MIN_INTERVAL_MS;
};

const runWithConcurrency = async (items, limit, worker) => {
  const results = [];
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });

  await Promise.all(runners);
  return results;
};

const refreshForecasts = async (context) => {
  const items = FORECAST_KINDS.flatMap((kind) =>
    FORECAST_REGION_IDS.map((regionId) => ({ kind, regionId })),
  );

  return runWithConcurrency(
    items,
    FORECAST_PRECOMPUTE_CONCURRENCY,
    async ({ kind, regionId }) => {
      try {
        const cacheKey = getForecastCacheKey(kind, regionId);
        const existingRecord = await context.env.WEATHER_CACHE.get(cacheKey, 'json');
        if (!shouldRefreshForecastRecord(existingRecord)) {
          return { kind: cacheKey, ok: true, skipped: true, generatedAt: existingRecord.generatedAt };
        }

        const payload = await buildForecastPayload(context, kind, regionId);
        await writePrecomputedForecast(context, kind, regionId, payload);
        return { kind: cacheKey, ok: true, tmfc: payload?.[0]?.tmfc ?? '' };
      } catch (error) {
        return { kind: `forecast:${kind}:${regionId}`, ok: false, error: error.message };
      }
    },
  );
};

const refreshWeatherCache = async (env, request) => {
  if (!env.WEATHER_CACHE) {
    throw new Error('WEATHER_CACHE KV binding is required.');
  }

  const context = makeContext(env, request);
  const forecastResults = await refreshForecasts(context);
  const rankingResults = await refreshRankings(context);
  const warningResult = await refreshWarningImages(context);

  return {
    generatedAt: new Date().toISOString(),
    results: [...forecastResults, ...rankingResults, warningResult],
  };
};

const readStatus = async (env) => {
  if (!env.WEATHER_CACHE) {
    throw new Error('WEATHER_CACHE KV binding is required.');
  }

  const keys = [
    ...RANKING_KINDS.map((kind) => getRankingCacheKey(kind)),
    WARNING_IMAGE_CACHE_KEY,
    ...FORECAST_KINDS.flatMap((kind) =>
      FORECAST_REGION_IDS.map((regionId) => getForecastCacheKey(kind, regionId)),
    ),
  ];
  const records = await Promise.all(
    keys.map(async (key) => {
      const record = await env.WEATHER_CACHE.get(key, 'json');
      return {
        key,
        generatedAt: record?.generatedAt ?? '',
        hasPayload: Boolean(record?.payload),
      };
    }),
  );

  return {
    checkedAt: new Date().toISOString(),
    records,
  };
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const isAuthorizedRefresh = (request, env) => {
  if (!env.CACHE_REFRESH_TOKEN) {
    return false;
  }

  const authorization = request.headers.get('Authorization') ?? '';
  return authorization === `Bearer ${env.CACHE_REFRESH_TOKEN}`;
};

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(refreshWeatherCache(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/status') {
        return jsonResponse(await readStatus(env));
      }

      if (url.pathname === '/refresh') {
        if (!isAuthorizedRefresh(request, env)) {
          return jsonResponse({ error: 'Unauthorized refresh request.' }, 401);
        }

        return jsonResponse(await refreshWeatherCache(env, request));
      }

      return jsonResponse({
        name: 'weathernow-precompute',
        endpoints: ['/status', '/refresh'],
      });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};
