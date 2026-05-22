import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {
  onRequestGet as rankingsGet,
  onRequestOptions as rankingsOptions,
} from './functions/api/rankings.js';
import {
  onRequestGet as warningImagesGet,
  onRequestOptions as warningImagesOptions,
} from './functions/api/weather-warning.js';

const sendFunctionResponse = async (response, res) => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
};

const localFunctionsPlugin = (env) => ({
  name: 'local-pages-functions',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost:5000');
      const context = {
        env,
        request: new Request(requestUrl.toString(), {
          method: req.method,
          headers: req.headers,
        }),
      };

      try {
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
  const authKey = env.KMA_AUTH_KEY || env.VITE_KMA_AUTH_KEY || '';

  return {
    plugins: [localFunctionsPlugin(env), react(), tailwindcss()],
    server: {
      proxy: {
        '/api/kma': {
          target: 'https://apihub.kma.go.kr',
          changeOrigin: true,
          rewrite: (path) => {
            const proxiedUrl = new URL(`https://local-proxy${path.replace(/^\/api\/kma/, '')}`);

            if (authKey && !proxiedUrl.searchParams.has('authKey')) {
              proxiedUrl.searchParams.set('authKey', authKey);
            }

            return `${proxiedUrl.pathname}${proxiedUrl.search}`;
          },
        },
      },
    },
  };
});
