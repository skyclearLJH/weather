const PAGE_ENDPOINT = '/api/global-model-tile';
const REQUEST_TIMEOUT_MS = 180000;

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

export const fetchGlobalModelFrame = ({ bbox, cycle, frameIndex, signal }) =>
  withTimeout(async (timeoutSignal) => {
    const payload = await requestJson('frame', {
      model: 'kim-global',
      bbox: bbox.join(','),
      cycle,
      frame: String(frameIndex),
    }, timeoutSignal);
    const rainPointCount = payload.grid.width * payload.grid.height;
    const pressureGrid = payload.pressure?.grid ?? payload.grid;
    const pressurePointCount = pressureGrid.width * pressureGrid.height;
    return {
      ...payload,
      times: payload.times.map((time) => new Date(time)),
      rain: decodeField(payload.rain, rainPointCount, 'KIM 강수'),
      pressure: decodeField(payload.pressure, pressurePointCount, 'KIM 해면기압'),
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

// --- 네이티브 0.25° 격자 (ECMWF·GFS) ---
//
// 기존 경로는 Open-Meteo 지점 API라 호출 제한 때문에 2.5°까지만 가능했다.
// 이쪽은 GitHub Actions가 원본 GRIB2를 디코드해 R2에 넣어둔 0.25° 격자를 읽는다
// (약 100배 조밀). 응답이 base64 JSON이 아니라 원시 바이너리라 별도 디코더를 쓴다.
const NATIVE_ENDPOINT = '/api/native-model';
const NATIVE_MODEL_IDS = { ifs: 'ecmwf', gfs: 'gfs' };

export const isNativeModel = (model) => Boolean(NATIVE_MODEL_IDS[model]);

export const fetchNativeModelMeta = ({ model, signal }) =>
  withTimeout(async (timeoutSignal) => {
    const nativeId = NATIVE_MODEL_IDS[model];
    if (!nativeId) throw new Error(`${model}은 네이티브 격자를 제공하지 않습니다.`);
    const response = await fetch(`${NATIVE_ENDPOINT}?model=${nativeId}&meta=1`, {
      signal: timeoutSignal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `네이티브 격자 정보 요청 실패 (${response.status})`);
    }
    return payload;
  }, signal);

// 프레임 하나를 기존 타일과 같은 모양({grid, times, rain:{values}})으로 만들어
// 렌더러가 분기 없이 그대로 그릴 수 있게 한다.
export const fetchNativeModelFrame = ({ model, cycle, frameIndex, signal }) =>
  withTimeout(async (timeoutSignal) => {
    const nativeId = NATIVE_MODEL_IDS[model];
    if (!nativeId) throw new Error(`${model}은 네이티브 격자를 제공하지 않습니다.`);
    const meta = await fetchNativeModelMeta({ model, signal: timeoutSignal });
    const targetCycle = cycle || meta.cycle;
    const query = new URLSearchParams({
      model: nativeId,
      frame: String(frameIndex),
      cycle: targetCycle,
    });
    const pointCount = meta.grid.width * meta.grid.height;
    const loadField = async (field) => {
      const fieldQuery = new URLSearchParams(query);
      if (field) fieldQuery.set('field', field);
      const response = await fetch(`${NATIVE_ENDPOINT}?${fieldQuery}`, { signal: timeoutSignal });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `네이티브 프레임 요청 실패 (${response.status})`);
      }
      const decoded = new Uint16Array(await response.arrayBuffer());
      if (decoded.length !== pointCount) {
        throw new Error('네이티브 격자 크기가 올바르지 않습니다.');
      }
      return decoded;
    };

    // 등압선용 해면기압은 없을 수도 있으므로(적재 중) 실패해도 강수는 그린다.
    const [values, pressureValues] = await Promise.all([
      loadField(null),
      loadField('pressure').catch(() => null),
    ]);
    // 프레임 N의 예보시각 = cycle + (N+1) × stepHours
    const cycleMs = Date.UTC(
      Number(targetCycle.slice(0, 4)),
      Number(targetCycle.slice(4, 6)) - 1,
      Number(targetCycle.slice(6, 8)),
      Number(targetCycle.slice(8, 10)),
    );
    const validTime = new Date(cycleMs + (frameIndex + 1) * meta.stepHours * 3600 * 1000);
    return {
      model,
      cycle: targetCycle,
      grid: meta.grid,
      frameIndex,
      leadHours: [(frameIndex + 1) * meta.stepHours],
      times: [validTime],
      sourceMode: 'native-0p25',
      rain: {
        available: true,
        encoding: meta.encoding,
        unit: meta.unit,
        missingValue: meta.missingValue,
        values,
      },
      pressure: pressureValues
        ? {
            available: true,
            encoding: meta.pressureEncoding ?? 'uint16-decihpa-le',
            unit: meta.pressureUnit ?? 'hPa',
            missingValue: meta.missingValue,
            grid: meta.grid,
            values: pressureValues,
          }
        : null,
    };
  }, signal);
