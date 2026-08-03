// 태풍 진로 반경(확률·강풍·폭풍)을 "예측 지점마다 분리된 원"이 아니라, 진로선을
// 따라 원이 연속됐을 때의 가장자리를 쭉 이어 하나의 띠(엔벨로프)로 그리기 위한
// 지오메트리 유틸. 진로선의 좌/우로 각 지점 반경만큼 오프셋한 두 경계선과, 양 끝의
// 반원 캡을 이어 닫힌 폴리곤(GeoJSON)을 만든다. 지구본 투영은 MapLibre가 처리한다.

const R_EARTH_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// 대권(great-circle) 기준 목적지 좌표 — [lon, lat]
export const destPoint = (lat, lon, bearingDeg, distKm) => {
  const delta = distKm / R_EARTH_KM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.min(1, Math.max(-1, sinPhi2)));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);
  return [toDeg(lambda2), toDeg(phi2)];
};

// 두 지점 사이 초기 방위각(deg, 0~360)
const bearing = (lat1, lon1, lat2, lon2) => {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

// 각 지점의 진행 접선 방위(양 옆 세그먼트 평균). 끝점은 인접 세그먼트 방위를 쓴다.
const tangentBearings = (points) => {
  const n = points.length;
  const seg = [];
  for (let i = 0; i < n - 1; i += 1) {
    seg.push(bearing(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon));
  }
  const avgAngle = (a, b) => {
    // 방위각 평균(원형) — 벡터 합
    const x = Math.cos(toRad(a)) + Math.cos(toRad(b));
    const y = Math.sin(toRad(a)) + Math.sin(toRad(b));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  };
  const tangents = [];
  for (let i = 0; i < n; i += 1) {
    if (n === 1) tangents.push(0);
    else if (i === 0) tangents.push(seg[0]);
    else if (i === n - 1) tangents.push(seg[n - 2]);
    else tangents.push(avgAngle(seg[i - 1], seg[i]));
  }
  return tangents;
};

// 중심점 기준 fromBearing→toBearing 호를 반경 r로 샘플 ([lon,lat] 배열)
const arc = (lat, lon, fromBearing, toBearing, r, steps = 12) => {
  const out = [];
  for (let s = 0; s <= steps; s += 1) {
    const b = fromBearing + ((toBearing - fromBearing) * s) / steps;
    out.push(destPoint(lat, lon, b, r));
  }
  return out;
};

// 커스텀 WebGL 레이어용 삼각형 메쉬. 폴리곤 삼각분할(earcut) 없이, 진로 좌/우
// 오프셋 점을 번갈아 잇는 TRIANGLE_STRIP + 양 끝 반원 팬으로 채운다. 삼각형이
// 서로 겹치지 않아 반투명으로 그려도 겹침 부위가 진해지지 않는다.
//  반환: { strip: [[lon,lat],...](스트립 순서), fans: [[[lon,lat],...], ...] }
export const sweptEnvelopeMesh = (points, radiiKm) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const radii = radiiKm.map((r) => (Number.isFinite(r) && r > 0 ? r : 0));
  if (radii.every((r) => r === 0)) return null;

  const fans = [];
  if (points.length === 1) {
    const r = radii[0];
    if (r === 0) return null;
    const center = [points[0].lon, points[0].lat];
    const ring = arc(points[0].lat, points[0].lon, 0, 360, r, 48);
    fans.push([center, ...ring]);
    return { strip: [], fans };
  }

  const tangents = tangentBearings(points);
  const strip = [];
  for (let i = 0; i < points.length; i += 1) {
    strip.push(destPoint(points[i].lat, points[i].lon, tangents[i] - 90, radii[i]));
    strip.push(destPoint(points[i].lat, points[i].lon, tangents[i] + 90, radii[i]));
  }

  const last = points.length - 1;
  // 끝 캡(전방 반원) / 시작 캡(후방 반원) — 중심을 첫 정점으로 하는 팬
  if (radii[last] > 0) {
    fans.push([
      [points[last].lon, points[last].lat],
      ...arc(points[last].lat, points[last].lon, tangents[last] - 90, tangents[last] + 90, radii[last], 16),
    ]);
  }
  if (radii[0] > 0) {
    fans.push([
      [points[0].lon, points[0].lat],
      ...arc(points[0].lat, points[0].lon, tangents[0] + 90, tangents[0] + 270, radii[0], 16),
    ]);
  }
  return { strip, fans };
};

// points: [{lat, lon}], radiiKm: number[] (지점별 반경, km). 진로를 따라 반경이
// 연속으로 이어진 하나의 띠 폴리곤(GeoJSON Polygon)을 반환. 유효 반경이 없으면 null.
export const sweptEnvelopePolygon = (points, radiiKm) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const radii = radiiKm.map((r) => (Number.isFinite(r) && r > 0 ? r : 0));
  if (radii.every((r) => r === 0)) return null;

  // 단일 지점이면 원 하나
  if (points.length === 1) {
    const r = radii[0];
    if (r === 0) return null;
    const ring = arc(points[0].lat, points[0].lon, 0, 360, r, 48);
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
  }

  const tangents = tangentBearings(points);
  const leftPts = points.map((p, i) => destPoint(p.lat, p.lon, tangents[i] - 90, radii[i]));
  const rightPts = points.map((p, i) => destPoint(p.lat, p.lon, tangents[i] + 90, radii[i]));

  const ring = [];
  // 왼쪽 경계 (시작 → 끝)
  for (let i = 0; i < points.length; i += 1) ring.push(leftPts[i]);
  // 끝점 캡: 왼쪽(접선-90) → 오른쪽(접선+90), 전방으로 반원
  const last = points.length - 1;
  ring.push(...arc(points[last].lat, points[last].lon, tangents[last] - 90, tangents[last] + 90, radii[last], 14));
  // 오른쪽 경계 (끝 → 시작)
  for (let i = last; i >= 0; i -= 1) ring.push(rightPts[i]);
  // 시작점 캡: 오른쪽(접선+90) → 왼쪽(접선+270), 후방으로 반원 (반경 0이면 점으로 수렴)
  ring.push(...arc(points[0].lat, points[0].lon, tangents[0] + 90, tangents[0] + 270, radii[0], 14));
  ring.push(ring[0]);

  return { type: 'Polygon', coordinates: [ring] };
};
