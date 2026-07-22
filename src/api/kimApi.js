const KIM_RAIN_ENDPOINT = '/api/kim-rain';
const KIM_GRID_VERSION = 'l010-v2';
const REQUEST_TIMEOUT_MS = 50000;

const parseErrorResponse = async (response, fallback) => {
  try {
    const payload = await response.json();
    return payload.error || fallback;
  } catch {
    return fallback;
  }
};

const fetchWithTimeout = async (url) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('KIM 강수 예상도 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

export const parseKimTime = (value) => {
  if (!/^\d{12}$/.test(value ?? '')) return null;
  return new Date(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12)),
  );
};

export const fetchLatestKimRainMeta = async ({ refresh = false } = {}) => {
  const query = new URLSearchParams({ meta: 'latest', v: KIM_GRID_VERSION });
  if (refresh) query.set('_refresh', '1');
  const response = await fetchWithTimeout(`${KIM_RAIN_ENDPOINT}?${query}`);
  if (!response.ok) {
    throw new Error(
      await parseErrorResponse(response, `KIM 예측 주기 요청 실패 (${response.status})`),
    );
  }
  const meta = await response.json();
  if (!meta.baseTime || !Array.isArray(meta.frames) || meta.frames.length === 0) {
    throw new Error('KIM 국지모델 예측 주기 정보가 올바르지 않습니다.');
  }
  return meta;
};

export const buildKimRainFrames = (meta, fromTime = new Date()) => {
  const precomputedLeadHours = Array.isArray(meta.precomputedLeadHours)
    ? new Set(meta.precomputedLeadHours.map(Number))
    : null;
  return meta.frames
    .map(({ leadHour, validTime }) => ({
      key: `kim-${KIM_GRID_VERSION}-${meta.baseTime}-${leadHour}`,
      kind: 'kim',
      baseTime: meta.baseTime,
      leadHour,
      validTime: parseKimTime(validTime),
      isPrecomputed: precomputedLeadHours?.has(Number(leadHour)) ?? null,
    }))
    .filter((frame) => frame.validTime && frame.validTime.getTime() >= fromTime.getTime());
};

export const fetchKimRainFrame = async (baseTime, leadHour, { refresh = false } = {}) => {
  const query = new URLSearchParams({
    baseTime,
    leadHour: String(leadHour),
    v: KIM_GRID_VERSION,
  });
  if (refresh) query.set('_refresh', '1');
  const response = await fetchWithTimeout(`${KIM_RAIN_ENDPOINT}?${query}`);
  if (!response.ok) {
    throw new Error(
      await parseErrorResponse(response, `KIM +${leadHour}시간 자료 요청 실패 (${response.status})`),
    );
  }
  const buffer = await response.arrayBuffer();
  const width = Number(response.headers.get('X-Kim-Width'));
  const height = Number(response.headers.get('X-Kim-Height'));
  const encoding = response.headers.get('X-Kim-Encoding') || '';
  const values =
    encoding === 'uint16-centimm-le' ? new Uint16Array(buffer) : new Uint8Array(buffer);
  if (!width || !height || values.length !== width * height) {
    throw new Error('KIM 시간당 강수 격자 크기가 올바르지 않습니다.');
  }
  return {
    values,
    width,
    height,
    baseTime: response.headers.get('X-Kim-Base-Time') || baseTime,
    validTime: parseKimTime(response.headers.get('X-Kim-Valid-Time')),
    leadHour: Number(response.headers.get('X-Kim-Lead-Hour')),
    originX: Number(response.headers.get('X-Kim-Origin-X')),
    originY: Number(response.headers.get('X-Kim-Origin-Y')),
    gridKm: Number(response.headers.get('X-Kim-Grid-Km')),
    unit: response.headers.get('X-Kim-Unit') || 'mm/h',
    conversion: response.headers.get('X-Kim-Conversion') || '',
    encoding,
    domain: response.headers.get('X-Kim-Domain') || '',
  };
};
