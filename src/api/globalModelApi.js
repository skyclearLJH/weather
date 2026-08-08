const PAGE_ENDPOINT = '/api/global-model-tile';
const REQUEST_TIMEOUT_MS = 90000;

const configuredEndpoint = String(import.meta.env.VITE_MODEL_WORKER_URL || '').replace(/\/$/, '');

const decodeUint16 = (base64) => {
  if (!base64) return null;
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Uint16Array(bytes.buffer);
};

const actionUrl = (base, action, params = {}) => {
  const query = new URLSearchParams(params);
  if (base.startsWith('/')) {
    query.set('action', action);
    return `${base}?${query}`;
  }
  return `${base}/${action}${query.size ? `?${query}` : ''}`;
};

const requestJson = async (action, params = {}, signal) => {
  const bases = configuredEndpoint ? [configuredEndpoint, PAGE_ENDPOINT] : [PAGE_ENDPOINT];
  let lastError = null;
  for (const base of bases) {
    try {
      const response = await fetch(actionUrl(base, action, params), { signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `전구모델 요청 실패 (${response.status})`);
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('전구모델 자료를 불러오지 못했습니다.');
};

const withTimeout = async (request, externalSignal) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (error.name === 'AbortError' && !externalSignal?.aborted) {
      throw new Error('전구모델 자료 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
};

const decodeField = (field, expectedLength, label) => {
  if (!field) return null;
  const values = decodeUint16(field.values);
  if (!values || values.length !== expectedLength) {
    throw new Error(`${label} 격자 크기가 올바르지 않습니다.`);
  }
  return { ...field, values };
};

export const fetchGlobalModelMetadata = ({ signal } = {}) =>
  withTimeout(async (timeoutSignal) => {
    const payload = await requestJson('metadata', {}, timeoutSignal);
    return { ...payload, times: payload.times.map((time) => new Date(time)) };
  }, signal);

export const fetchGlobalModelTile = ({ model, bbox, step, cycle, signal }) =>
  withTimeout(async (timeoutSignal) => {
    const payload = await requestJson('tile', {
      model,
      bbox: bbox.join(','),
      step: String(step),
      cycle,
    }, timeoutSignal);
    const pointCount = payload.grid.width * payload.grid.height;
    const frameCount = payload.times.length;
    return {
      ...payload,
      times: payload.times.map((time) => new Date(time)),
      rain: decodeField(payload.rain, pointCount * frameCount, `${model} 강수`),
      pressure: decodeField(payload.pressure, pointCount * frameCount, `${model} 해면기압`),
    };
  }, signal);

export const fetchGlobalModelBundle = ({ bbox, step, cycle, signal }) =>
  withTimeout(async (timeoutSignal) => {
    const payload = await requestJson('tile', {
      model: 'compare',
      bbox: bbox.join(','),
      step: String(step),
      cycle,
    }, timeoutSignal);
    const pointCount = payload.grid.width * payload.grid.height;
    const frameCount = payload.times.length;
    const times = payload.times.map((time) => new Date(time));
    const models = Object.fromEntries(Object.entries(payload.models).map(([model, fields]) => [model, {
      ...fields,
      model,
      cycle: payload.cycle,
      grid: payload.grid,
      leadHours: payload.leadHours,
      times,
      rain: decodeField(fields.rain, pointCount * frameCount, `${model} 강수`),
      pressure: decodeField(fields.pressure, pointCount * frameCount, `${model} 해면기압`),
    }]));
    return {
      ...payload,
      times,
      models,
    };
  }, signal);

export const fetchKimPressure = ({ bbox, step, cycle, frameIndex, signal }) =>
  withTimeout(async (timeoutSignal) => {
    const payload = await requestJson('pressure', {
      model: 'kim-global',
      bbox: bbox.join(','),
      step: String(step),
      cycle,
      frame: String(frameIndex),
    }, timeoutSignal);
    const pointCount = payload.grid.width * payload.grid.height;
    return {
      ...payload,
      time: new Date(payload.time),
      pressure: decodeField(payload.pressure, pointCount, 'KIM 해면기압'),
    };
  }, signal);

export const warmGlobalModelCache = ({ signal } = {}) =>
  withTimeout((timeoutSignal) => requestJson('warm', {}, timeoutSignal), signal);
