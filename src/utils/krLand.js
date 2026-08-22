// 남한 육지 판정과 시도 찾기. 레이더 원고와 영상 자동 설정이 함께 쓴다.
// (해상 에코는 방송 원고에서 빼고, 줌인도 육지를 기준으로 하기 때문이다.)

import provinces from '../data/map/krProvinces.json';

// 시도마다 사각 범위를 미리 재 둔다. 육지 판정을 후보마다 하므로
// 범위 밖이면 곧바로 걸러 내야 빠르다.
export const provinceBoxes = (provinces.features ?? []).map((feature) => {
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  const visit = (polygon) => {
    for (const [x, y] of polygon[0]) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  };
  const geometry = feature.geometry;
  if (geometry?.type === 'Polygon') visit(geometry.coordinates);
  else if (geometry?.type === 'MultiPolygon') geometry.coordinates.forEach(visit);
  return { feature, west, east, south, north };
});

const ringContains = (ring, lon, lat) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = (yi > lat) !== (yj > lat);
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

export const eachPolygon = (geometry, visit) => {
  if (!geometry) return;
  if (geometry.type === 'Polygon') visit(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(visit);
};

// 지점이 육지(어느 시도) 안인지 본다. 바다면 null.
export const provinceContaining = (lon, lat) => {
  for (const box of provinceBoxes) {
    if (lon < box.west || lon > box.east || lat < box.south || lat > box.north) continue;
    let hit = false;
    eachPolygon(box.feature.geometry, (polygon) => {
      if (hit) return;
      if (ringContains(polygon[0], lon, lat)
        && !polygon.slice(1).some((hole) => ringContains(hole, lon, lat))) hit = true;
    });
    if (hit) return box.feature;
  }
  return null;
};

