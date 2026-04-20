export const KMA_PROXY_BASE = '/api/kma';

export const CLIENT_KMA_AUTH_KEY =
  import.meta.env.VITE_KMA_AUTH_KEY ??
  import.meta.env.REACT_APP_KMA_AUTH_KEY ??
  '';
