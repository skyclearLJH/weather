const TERRAIN_RAIN_API = '/api/terrain-rain';

export const fetchTerrainWindForecast = async (targetTime) => {
  const url = new URL(TERRAIN_RAIN_API, window.location.origin);
  if (targetTime instanceof Date && Number.isFinite(targetTime.getTime())) {
    url.searchParams.set('tm', targetTime.toISOString());
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `지상풍 예보 요청 실패 (${response.status})`);
  }
  return {
    ...payload,
    validTime: payload.validTime ? new Date(payload.validTime) : null,
    baseTime: payload.baseTime ? new Date(payload.baseTime) : null,
  };
};
