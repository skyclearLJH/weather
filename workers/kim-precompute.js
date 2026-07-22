import {
  precomputeLatestKimRain,
  readKimPrecomputeStatus,
} from '../functions/api/kim-rain.js';

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const isAuthorizedRefresh = (request, env) => {
  if (!env.CACHE_REFRESH_TOKEN) return false;
  const authorization = request.headers.get('Authorization') ?? '';
  return authorization === `Bearer ${env.CACHE_REFRESH_TOKEN}`;
};

const refreshKimCache = (env, request, context, force = false) =>
  precomputeLatestKimRain(env, {
    request,
    force,
    waitUntil: (task) => context.waitUntil(task),
  });

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(
      refreshKimCache(
        env,
        new Request('https://weathernow.local/kim-precompute/cron'),
        context,
      ),
    );
  },

  async fetch(request, env, context) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/status') {
        return jsonResponse(await readKimPrecomputeStatus(env));
      }

      if (url.pathname === '/refresh') {
        if (!isAuthorizedRefresh(request, env)) {
          return jsonResponse({ error: 'Unauthorized refresh request.' }, 401);
        }
        return jsonResponse(
          await refreshKimCache(env, request, context, url.searchParams.get('force') === '1'),
        );
      }

      return jsonResponse({
        name: 'weathernow-kim-precompute',
        endpoints: ['/status', '/refresh'],
      });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};
