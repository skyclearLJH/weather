const MISSING_VALUE = 65535;

const pointKey = ([lon, lat]) => `${lon.toFixed(4)},${lat.toFixed(4)}`;

const connectSegments = (segments) => {
  const adjacency = new Map();
  segments.forEach((segment, index) => {
    segment.forEach((point) => {
      const key = pointKey(point);
      if (!adjacency.has(key)) adjacency.set(key, []);
      adjacency.get(key).push(index);
    });
  });
  const used = new Uint8Array(segments.length);
  const lines = [];
  const extend = (line, atStart) => {
    while (true) {
      const point = atStart ? line[0] : line[line.length - 1];
      const nextIndex = (adjacency.get(pointKey(point)) ?? []).find((index) => !used[index]);
      if (nextIndex === undefined) break;
      used[nextIndex] = 1;
      const [a, b] = segments[nextIndex];
      const nextPoint = pointKey(a) === pointKey(point) ? b : a;
      if (atStart) line.unshift(nextPoint);
      else line.push(nextPoint);
    }
  };
  segments.forEach((segment, index) => {
    if (used[index]) return;
    used[index] = 1;
    const line = [...segment];
    extend(line, false);
    extend(line, true);
    if (line.length >= 3) lines.push(line);
  });
  return lines;
};

// 3x3 상자평활을 여러 번 겹치면 가우시안에 가까워진다. 0.25° 격자는 예전
// 2.5° 격자보다 100배 조밀해 한 번만 돌리면 등압선이 잘게 꺾이고 작은 동심원이
// 잔뜩 생긴다. 격자가 촘촘할수록 횟수를 늘려 실제 일기도처럼 완만하게 만든다.
const boxBlurOnce = (source, width, height) => {
  const output = new Float32Array(width * height);
  output.fill(Number.NaN);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let total = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const sourceRow = row + dy;
        if (sourceRow < 0 || sourceRow >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const sourceColumn = column + dx;
          if (sourceColumn < 0 || sourceColumn >= width) continue;
          const value = source[sourceRow * width + sourceColumn];
          if (!Number.isFinite(value)) continue;
          total += value;
          count += 1;
        }
      }
      if (count >= 4) output[row * width + column] = total / count;
    }
  }
  return output;
};

const smoothPressure = (values, width, height, offset, passes = 1) => {
  let current = new Float32Array(width * height);
  current.fill(Number.NaN);
  for (let index = 0; index < width * height; index += 1) {
    const encoded = values[offset + index];
    if (encoded !== MISSING_VALUE && Number.isFinite(encoded)) {
      current[index] = encoded / 10;
    }
  }
  for (let pass = 0; pass < Math.max(1, passes); pass += 1) {
    current = boxBlurOnce(current, width, height);
  }
  return current;
};

const interpolate = (a, b, level) => {
  const denominator = b - a;
  return Math.abs(denominator) < 0.0001 ? 0.5 : (level - a) / denominator;
};

const contourSegmentsForLevel = (values, grid, level) => {
  const segments = [];
  const coordinate = (x, y) => [grid.lonMin + x * grid.step, grid.latMax - y * grid.step];
  for (let row = 0; row < grid.height - 1; row += 1) {
    for (let column = 0; column < grid.width - 1; column += 1) {
      const topLeft = values[row * grid.width + column];
      const topRight = values[row * grid.width + column + 1];
      const bottomLeft = values[(row + 1) * grid.width + column];
      const bottomRight = values[(row + 1) * grid.width + column + 1];
      if (![topLeft, topRight, bottomLeft, bottomRight].every(Number.isFinite)) continue;
      const crossings = [];
      if ((topLeft < level) !== (topRight < level)) {
        crossings.push(coordinate(column + interpolate(topLeft, topRight, level), row));
      }
      if ((topRight < level) !== (bottomRight < level)) {
        crossings.push(coordinate(column + 1, row + interpolate(topRight, bottomRight, level)));
      }
      if ((bottomLeft < level) !== (bottomRight < level)) {
        crossings.push(coordinate(column + interpolate(bottomLeft, bottomRight, level), row + 1));
      }
      if ((topLeft < level) !== (bottomLeft < level)) {
        crossings.push(coordinate(column, row + interpolate(topLeft, bottomLeft, level)));
      }
      if (crossings.length === 2) segments.push(crossings);
      if (crossings.length === 4) {
        const center = (topLeft + topRight + bottomLeft + bottomRight) / 4;
        if (center >= level) {
          segments.push([crossings[0], crossings[3]], [crossings[1], crossings[2]]);
        } else {
          segments.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
        }
      }
    }
  }
  return segments;
};

const distanceSquared = (left, right) => {
  const meanLat = ((left.lat + right.lat) * Math.PI) / 360;
  const dx = (left.lon - right.lon) * Math.cos(meanLat);
  const dy = left.lat - right.lat;
  return dx * dx + dy * dy;
};

const findPressureCenters = (values, grid) => {
  const highs = [];
  const lows = [];
  const radius = Math.max(2, Math.round(Math.min(grid.width, grid.height) / 18));
  for (let row = radius; row < grid.height - radius; row += 1) {
    for (let column = radius; column < grid.width - radius; column += 1) {
      const value = values[row * grid.width + column];
      if (!Number.isFinite(value)) continue;
      let isHigh = true;
      let isLow = true;
      for (let dy = -radius; dy <= radius && (isHigh || isLow); dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (!dx && !dy) continue;
          const neighbor = values[(row + dy) * grid.width + column + dx];
          if (!Number.isFinite(neighbor)) continue;
          if (neighbor >= value) isHigh = false;
          if (neighbor <= value) isLow = false;
        }
      }
      const candidate = {
        lon: grid.lonMin + column * grid.step,
        lat: grid.latMax - row * grid.step,
        value,
      };
      if (isHigh) highs.push(candidate);
      if (isLow) lows.push(candidate);
    }
  }
  const separation = Math.max(4, Math.min(16, (grid.lonMax - grid.lonMin) / 7));
  const select = (candidates, descending) => {
    candidates.sort((a, b) => descending ? b.value - a.value : a.value - b.value);
    const selected = [];
    for (const candidate of candidates) {
      if (selected.every((entry) => distanceSquared(entry, candidate) >= separation * separation)) {
        selected.push(candidate);
      }
      if (selected.length >= 5) break;
    }
    return selected;
  };
  return { highs: select(highs, true), lows: select(lows, false) };
};

export const buildPressureFeatures = (tile, frameIndex, overridePressure = null) => {
  const pressure = overridePressure ?? tile?.pressure;
  const grid = pressure?.grid ?? tile?.grid;
  if (!grid || !pressure?.available || !pressure.values) {
    return {
      contours: { type: 'FeatureCollection', features: [] },
      centers: { type: 'FeatureCollection', features: [] },
    };
  }
  const pointCount = grid.width * grid.height;
  const offset = pressure.values.length === pointCount ? 0 : frameIndex * pointCount;
  // 평활 반경을 약 1도로 맞춘다: 0.25° 격자면 4회, 0.5°면 2회, 성긴 격자면 1회.
  const passes = Math.round(Math.min(6, Math.max(1, 1 / (grid.step || 1))));
  const smoothed = smoothPressure(pressure.values, grid.width, grid.height, offset, passes);
  const finite = Array.from(smoothed).filter(Number.isFinite);
  if (!finite.length) {
    return {
      contours: { type: 'FeatureCollection', features: [] },
      centers: { type: 'FeatureCollection', features: [] },
    };
  }
  const minimum = Math.max(880, Math.ceil(Math.min(...finite) / 4) * 4);
  const maximum = Math.min(1080, Math.floor(Math.max(...finite) / 4) * 4);
  const contourFeatures = [];
  // 평활 후에도 남는 아주 작은 고리는 실제 기압계가 아니라 격자 잡음이다.
  // 태풍처럼 작지만 실재하는 저기압을 지우지 않도록 임계를 낮게 잡는다.
  const isMeaningful = (coordinates) => {
    let minLon = Infinity; let maxLon = -Infinity;
    let minLat = Infinity; let maxLat = -Infinity;
    coordinates.forEach(([lon, lat]) => {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });
    return Math.max(maxLon - minLon, maxLat - minLat) >= 0.8;
  };
  for (let level = minimum; level <= maximum; level += 4) {
    const lines = connectSegments(contourSegmentsForLevel(smoothed, grid, level))
      .filter(isMeaningful);
    lines.forEach((coordinates, index) => {
      contourFeatures.push({
        type: 'Feature',
        properties: { level, major: level % 8 === 0 ? 1 : 0, id: `${level}-${index}` },
        geometry: { type: 'LineString', coordinates },
      });
    });
  }
  const { highs, lows } = findPressureCenters(smoothed, grid);
  const centerFeatures = [
    ...highs.map((entry) => ({ ...entry, kind: 'H' })),
    ...lows.map((entry) => ({ ...entry, kind: 'L' })),
  ].map((entry) => ({
    type: 'Feature',
    properties: { kind: entry.kind, value: Math.round(entry.value) },
    geometry: { type: 'Point', coordinates: [entry.lon, entry.lat] },
  }));
  return {
    contours: { type: 'FeatureCollection', features: contourFeatures },
    centers: { type: 'FeatureCollection', features: centerFeatures },
  };
};
