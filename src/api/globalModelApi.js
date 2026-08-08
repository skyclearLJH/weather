const ENDPOINT = '/api/global-model-rain';
const REQUEST_TIMEOUT_MS = 90000;

const decodeUint16 = (base64) => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Uint16Array(bytes.buffer);
};

export const fetchGlobalModelRain = async ({ refresh = false } = {}) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const query = refresh ? '?_refresh=1' : '';
    const response = await fetch(`${ENDPOINT}${query}`, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `전구모델 요청 실패 (${response.status})`);
    }
    const pointCount = payload.grid.width * payload.grid.height;
    const frameCount = payload.times.length;
    const models = Object.fromEntries(
      Object.entries(payload.models).map(([modelId, model]) => {
        const values = decodeUint16(model.values);
        if (values.length !== pointCount * frameCount) {
          throw new Error(`${modelId} 전구모델 격자 크기가 올바르지 않습니다.`);
        }
        return [modelId, { ...model, values }];
      }),
    );
    return {
      ...payload,
      times: payload.times.map((time) => new Date(time)),
      models,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('전구모델 자료 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};
