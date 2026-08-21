// 음성을 넣은 영상은 '지금 비가 가장 센 곳'으로 밀고 들어가며 끝난다.
// 그 종료 화면을 자동으로 잡아 주기 위한 계산들.

import provinces from '../data/map/krProvinces.json';
import sggLabels from '../data/map/kr-sgg-labels-20260701.json';

// 시도마다 사각 범위를 미리 재 둔다. 육지 판정을 후보마다 하므로
// 범위 밖이면 곧바로 걸러 내야 빠르다.
const provinceBoxes = (provinces.features ?? []).map((feature) => {
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

const eachPolygon = (geometry, visit) => {
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

/**
 * 레이더 격자에서 '육지 위' 가장 센 지점을 찾는다.
 *
 * 바다의 발달한 에코가 가장 셀 때가 많은데, 그쪽으로 줌인하면 아무도 살지 않는
 * 바다를 비추게 된다. 그래서 센 곳을 여러 곳 추려 둔 뒤 육지인 것 중에서 고른다.
 * 한 칸만 튄 값은 이상 에코일 수 있어 주변까지 함께 센 점수로 순위를 매긴다.
 */
export const findPeakPoint = ({
  buckets, mappings, canvasWidth, canvasHeight, toLonLat, candidateCount = 240,
}) => {
  if (!buckets || !mappings) return null;
  const step = 4;
  // 점수 높은 순으로 후보를 조금만 들고 있는다(전부 모으면 무겁다).
  const candidates = [];
  let cutoff = 0;

  for (let y = step; y < canvasHeight - step; y += step) {
    for (let x = step; x < canvasWidth - step; x += step) {
      const index = mappings[y * canvasWidth + x];
      if (index < 0) continue;
      const center = buckets[index] ?? 0;
      if (center <= 0) continue;

      let score = center * 2;
      for (let dy = -step; dy <= step; dy += step) {
        for (let dx = -step; dx <= step; dx += step) {
          if (dx === 0 && dy === 0) continue;
          const near = mappings[(y + dy) * canvasWidth + (x + dx)];
          if (near >= 0) score += buckets[near] ?? 0;
        }
      }
      if (candidates.length >= candidateCount && score <= cutoff) continue;

      candidates.push({ x, y, score, bucket: center });
      if (candidates.length > candidateCount * 2) {
        candidates.sort((a, b) => b.score - a.score);
        candidates.length = candidateCount;
        cutoff = candidates[candidates.length - 1].score;
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  // 센 순서대로 보면서 육지에 처음 닿는 지점을 고른다.
  for (const candidate of candidates) {
    const [lon, lat] = toLonLat(candidate.x, candidate.y);
    const province = provinceContaining(lon, lat);
    if (province) return { lon, lat, bucket: candidate.bucket, province };
  }
  // 육지에 비가 없으면 줌인할 곳이 없다고 본다.
  return null;
};

// 지점이 속한 시도를 찾는다. 바다 위라면 가장 가까운 시도로 대신한다.
export const findProvinceAt = (lon, lat) => {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const feature of provinces.features ?? []) {
    let hit = false;
    eachPolygon(feature.geometry, (polygon) => {
      if (hit) return;
      // 첫 고리는 바깥 경계, 나머지는 구멍이다.
      if (ringContains(polygon[0], lon, lat)
        && !polygon.slice(1).some((hole) => ringContains(hole, lon, lat))) hit = true;
    });
    if (hit) return feature;

    // 바다에 찍힌 경우를 대비해 경계까지의 거리도 재 둔다.
    eachPolygon(feature.geometry, (polygon) => {
      for (const [px, py] of polygon[0]) {
        const dx = (px - lon) * Math.cos((lat * Math.PI) / 180);
        const dy = py - lat;
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = feature;
        }
      }
    });
  }
  return nearest;
};

// 시도의 사각 범위와, 그 안에서 실제 땅이 차지하는 비율.
// 사각 범위만으로 줌을 잡으면 도 모양이 목표보다 작게 나와서 함께 계산한다.
export const provinceExtent = (feature) => {
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  let shapeArea = 0;

  eachPolygon(feature.geometry, (polygon) => {
    const ring = polygon[0];
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (xi < west) west = xi;
      if (xi > east) east = xi;
      if (yi < south) south = yi;
      if (yi > north) north = yi;
      // 경도는 위도에 따라 좁아지므로 보정해 면적을 잰다.
      sum += (xj * Math.cos((yj * Math.PI) / 180)) * yi - (xi * Math.cos((yi * Math.PI) / 180)) * yj;
    }
    shapeArea += Math.abs(sum / 2);
  });

  const boxArea = (east - west) * Math.cos(((north + south) / 2 * Math.PI) / 180) * (north - south);
  return {
    bounds: [[west, south], [east, north]],
    // 사각 범위 대비 실제 땅의 비율(보통 0.5~0.8)
    fillRatio: boxArea > 0 ? Math.min(1, shapeArea / boxArea) : 0.65,
  };
};

/**
 * 시도가 화면 면적의 targetAreaRatio만큼 차지하도록 줌을 낮춘다.
 * cameraForBounds는 사각 범위가 화면을 꽉 채우는 줌을 주므로,
 * 목표 비율의 제곱근(길이 비율)만큼 물러난다.
 */
export const zoomForAreaRatio = (fitZoom, fillRatio, targetAreaRatio = 0.1) => {
  const boxRatio = Math.min(1, targetAreaRatio / Math.max(0.2, fillRatio));
  return fitZoom + Math.log2(Math.sqrt(boxRatio));
};

// 화면에 '어디로 밀고 들어가는지' 알려 주려고 가장 가까운 시군구 이름을 붙인다.
export const nearestPlaceName = (lon, lat) => {
  let best = null;
  let bestDistance = Infinity;
  for (const feature of sggLabels.features ?? []) {
    const [px, py] = feature.geometry?.coordinates ?? [];
    if (px === undefined) continue;
    const dx = (px - lon) * Math.cos((lat * Math.PI) / 180);
    const dy = py - lat;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = feature.properties?.sggnm ?? null;
    }
  }
  if (!best) return null;
  const short = best.replace(/(특별자치시|광역시|특별시|시|군|구)$/, '');
  return short.length >= 2 ? short : best;
};
