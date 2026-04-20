import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const authKey = env.KMA_AUTH_KEY || env.VITE_KMA_AUTH_KEY || '';

  return {
    plugins: [react(), tailwindcss()],
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
