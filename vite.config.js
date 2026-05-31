import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  RANKING_KINDS,
  buildRankingPayload,
  onRequestGet as rankingsGet,
  onRequestOptions as rankingsOptions,
  writePrecomputedRanking,
} from './functions/api/rankings.js';
import {
  onRequestGet as warningImagesGet,
  onRequestOptions as warningImagesOptions,
} from './functions/api/weather-warning.js';
import {
  onRequestGet as forecastGet,
  onRequestOptions as forecastOptions,
} from './functions/api/forecast.js';
import {
  onRequest as kmaProxyRequest,
  onRequestOptions as kmaProxyOptions,
} from './functions/api/kma/[[path]].js';

const sendFunctionResponse = async (response, res) => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
};

const createLocalWeatherCache = () => {
  const store = new Map();

  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) {
        return null;
      }

      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
};

const localFunctionsPlugin = (env) => ({
  name: 'local-pages-functions',
  configureServer(server) {
    const localEnv = {
      ...env,
      WEATHER_CACHE: typeof env.WEATHER_CACHE === 'object'
        ? env.WEATHER_CACHE
        : createLocalWeatherCache(),
    };
    const prewarmContext = {
      env: localEnv,
      request: new Request('http://localhost:5173/api/rankings'),
    };

    Promise.allSettled(
      RANKING_KINDS.map(async (kind) => {
        const payload = await buildRankingPayload(prewarmContext, kind);
        await writePrecomputedRanking(prewarmContext, kind, payload);
      }),
    ).catch(() => {});

    server.middlewares.use(async (req, res, next) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost:5000');
      const context = {
        env: localEnv,
        request: new Request(requestUrl.toString(), {
          method: req.method,
          headers: req.headers,
        }),
      };

      try {
        if (requestUrl.pathname.startsWith('/api/kma/')) {
          const kmaPath = requestUrl.pathname.replace(/^\/api\/kma\/?/, '');
          const response = req.method === 'OPTIONS'
            ? await kmaProxyOptions(context)
            : await kmaProxyRequest({
                ...context,
                params: {
                  path: kmaPath.split('/').filter(Boolean),
                },
              });
          await sendFunctionResponse(response, res);
          return;
        }

        if (requestUrl.pathname === '/api/rankings') {
          const response = req.method === 'OPTIONS'
            ? await rankingsOptions(context)
            : await rankingsGet(context);
          await sendFunctionResponse(response, res);
          return;
        }

        if (requestUrl.pathname === '/api/weather-warning') {
          const response = req.method === 'OPTIONS'
            ? await warningImagesOptions(context)
            : await warningImagesGet(context);
          await sendFunctionResponse(response, res);
          return;
        }

        if (requestUrl.pathname === '/api/forecast') {
          const response = req.method === 'OPTIONS'
            ? await forecastOptions(context)
            : await forecastGet(context);
          await sendFunctionResponse(response, res);
          return;
        }
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: error.message }));
        return;
      }

      next();
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [localFunctionsPlugin(env), react(), tailwindcss()],
  };
});
