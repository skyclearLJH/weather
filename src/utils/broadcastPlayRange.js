// 방송 재생 구간(시작/끝 프레임) 저장소.
//
// 편집모드에서 지정한 "시작화면/끝화면"을 방송모드로 넘기기 위한 공용 유틸.
// 편집↔방송은 별도 페이지 로드(window.location 변경)라 상태가 메모리로는
// 안 넘어가므로 localStorage에 보관한다. 뷰마다 프레임 모델이 달라서
// 프레임을 "키"(예: 관측시각 문자열)로 저장하고, 방송모드에서 현재 프레임
// 배열에 대해 가장 가까운 키로 인덱스를 되찾는다(자료가 조금 갱신돼도 견고).
//
// viewId 예: 'heatwave:change', 'radar:radar', 'radar:accum', 'radar:kim',
// 'satellite'. 각 뷰가 자신의 id와 keyOf(프레임→문자열)만 정하면 된다.

const STORAGE_KEY = 'weathernow.broadcastPlayRange.v1';

// 저장은 sessionStorage에 한다. localStorage에 두면 어제 지정한 구간이 다음 날
// 들어와도 남아, 아무것도 안 했는데 구간이 잡혀 있는 상태로 시작됐다.
// sessionStorage는 같은 탭 안에서는 페이지를 새로 열어도 유지되므로
// 편집→방송 전달(window.location 변경)은 그대로 되고, 탭을 닫으면 사라진다.
const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

// 예전에 localStorage로 저장하던 값이 남아 있으면 지운다(한 번만).
try {
  window.localStorage?.removeItem(STORAGE_KEY);
} catch {
  // 저장소를 못 쓰는 환경(프라이빗 모드 등)은 그냥 넘어간다.
}

const readAll = () => {
  try {
    return JSON.parse(storage()?.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

export const readPlayRange = (viewId) => {
  const range = readAll()[viewId];
  return range && range.start != null && range.end != null ? range : null;
};

export const writePlayRange = (viewId, range) => {
  const all = readAll();
  if (range && range.start != null && range.end != null) {
    // 프레임 키 + 시작/끝 지도 카메라(위치·확대·기울기·방위)를 함께 보관.
    // 카메라는 지정 시점에 캡처하며, 없으면 null(카메라 이동 없음).
    all[viewId] = {
      start: String(range.start),
      end: String(range.end),
      startCamera: range.startCamera ?? null,
      endCamera: range.endCamera ?? null,
    };
  } else {
    delete all[viewId];
  }
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 저장 실패(프라이빗 모드 등)는 조용히 무시 — 기능만 비활성화된다.
  }
};

export const clearPlayRange = (viewId) => writePlayRange(viewId, null);

// 저장된 시작/끝 키를 현재 프레임 배열의 인덱스로 되돌린다.
// keyOf(frame, index) → 문자열. 레이더/KIM/위성처럼 타임라인이 "현재" 기준으로
// 계속 갱신되는 뷰는 편집↔방송 사이에 프레임 시각이 미세하게 밀려 정확한 키가
// 안 맞으므로, 키를 숫자(관측시각 코드·타임스탬프)로 보고 "가장 가까운 프레임"을
// 찾는다. 숫자로 못 읽는 키는 정확 일치만 시도한다. 해당 끝을 못 찾으면
// 타임라인 경계(0 또는 마지막)로 보정. 둘 다 없으면 null.
// 반환: { startIndex, endIndex } (start ≤ end 보장) 또는 null.
export const resolvePlayRange = (viewId, frames, keyOf) => {
  const range = readPlayRange(viewId);
  if (!range || !frames || frames.length === 0) return null;
  const keys = frames.map((frame, index) => String(keyOf(frame, index)));
  const findNearest = (target) => {
    if (target == null) return -1;
    const exact = keys.indexOf(String(target));
    if (exact >= 0) return exact;
    const numericTarget = Number(target);
    if (!Number.isFinite(numericTarget)) return -1;
    let bestIndex = -1;
    let bestDiff = Infinity;
    for (let index = 0; index < keys.length; index += 1) {
      const value = Number(keys[index]);
      if (!Number.isFinite(value)) continue;
      const diff = Math.abs(value - numericTarget);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = index;
      }
    }
    return bestIndex;
  };
  let startIndex = findNearest(range.start);
  let endIndex = findNearest(range.end);
  if (startIndex < 0 && endIndex < 0) return null;
  if (startIndex < 0) startIndex = 0;
  if (endIndex < 0) endIndex = frames.length - 1;
  let startCamera = range.startCamera ?? null;
  let endCamera = range.endCamera ?? null;
  if (startIndex > endIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
    [startCamera, endCamera] = [endCamera, startCamera];
  }
  return { startIndex, endIndex, startCamera, endCamera };
};

// 현재 지도 카메라(위치·확대·기울기·방위)를 캡처한다.
export const captureCamera = (map) => {
  if (!map) return null;
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
};

// 재생 시작 시 시작 카메라로 즉시 이동하고, 끝 카메라로 durationMs 동안 부드럽게
// 이동한다. 카메라가 지정되지 않은 쪽은 건드리지 않는다.
export const applyPlayCamera = (map, range, durationMs) => {
  if (!map || !range) return;
  if (range.startCamera) {
    map.jumpTo({
      center: range.startCamera.center,
      zoom: range.startCamera.zoom,
      pitch: range.startCamera.pitch,
      bearing: range.startCamera.bearing,
    });
  }
  if (range.endCamera) {
    map.easeTo({
      center: range.endCamera.center,
      zoom: range.endCamera.zoom,
      pitch: range.endCamera.pitch,
      bearing: range.endCamera.bearing,
      duration: Math.max(0, durationMs),
    });
  }
};
