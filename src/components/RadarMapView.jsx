import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, MonitorPlay, RefreshCw } from 'lucide-react';
import SatelliteView from './SatelliteView.jsx';
import { createAccumSurfaceLayer } from './AccumSurfaceLayer.js';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import krProvinces from '../data/map/krProvinces.json';
import interKoreanSeam from '../data/map/interKoreanSeam.json';
import neighborCoasts from '../data/map/neighborCoasts.json';
import {
  RADAR_GRID,
  RADAR_DOWNSAMPLE,
  RAIN_PALETTE,
  QPF_IMAGE,
  LCC_RHO0_KM,
  lccRhoKm,
  lccTheta,
  fetchRadarFrame,
  fetchQpfFrame,
  probeLatestRadarTm,
  probeLatestQpfTm,
  parseRadarTm,
} from '../api/radarApi';
import {
  ACCUM_PALETTE,
  ACCUM_MAJOR_BREAKS,
  ACCUM_SCALE_TOP,
  accumBucket,
  fetchAwsStationCoords,
  fetchHourlyRnDay,
  fetchDailyRnTotal,
  formatAccumHourTm,
  formatStationLabel,
  selectAccumTopStations,
} from '../api/accumApi';
import {
  buildKimRainFrames,
  fetchKimRainFrame,
  fetchLatestKimRainMeta,
} from '../api/kimApi';

// 표출 캔버스가 덮는 위경도 범위(레이더 격자 전체 영역)
const VIEW_BOUNDS = { lonMin: 120.18, lonMax: 133.56, latMin: 30.1, latMax: 43.34 };
const KIM_VIEW_BOUNDS = { lonMin: 118.2, lonMax: 133.8, latMin: 30.7, latMax: 45.2 };
const CANVAS_WIDTH = 1152;
const OVERLAY_ALPHA = 208;
const ACCUM_EXTRUSION_SOURCE_ID = 'accum-extrusion';
const ACCUM_EXTRUSION_LAYER_ID = 'accum-extrusion-bars';
const ACCUM_EXTRUSION_STRIDE = 2;
const ACCUM_3D_SPATIAL_SMOOTHING =
  import.meta.env.VITE_ACCUM_3D_SPATIAL_SMOOTHING !== 'off';
const ACCUM_3D_SMOOTHING_PASSES = 2;
const ACCUM_3D_SMOOTHING_BLEND = 0.82;
const ACCUM_3D_DEFAULT_PITCH = 55;
const ISLAND_PILLAR_HEIGHT_SCALE = 0.55;
const ISLAND_PILLAR_WIDTH_SCALE = 0.7;
const MAX_ACCUM_API_FRAMES = 31;
const SINGLE_PILLAR_ISLAND_STATION_IDS = new Set([
  '229', // 북격렬비도
  '269', // 안마도
  '300', // 말도
  '301', // 임자도
  '302', // 장산도
  '304', // 신지도
  '305', // 여서도
  '306', // 소리도
  '308', // 옥도
  '502', // 교동
  '578', // 호도
  '609', // 삽시도
  '610', // 홍성죽도
  '656', // 볼음도
  '665', // 무의도
  '666', // 안도
  '667', // 옹도
  '707', // 지도
  '714', // 자은도
  '716', // 하의도
  '719', // 선유도
  '720', // 보길도
  '743', // 비금
  '747', // 청산도
  '756', // 위도
  '771', // 안좌
  '789', // 압해도
  '790', // 나로도
  '956', // 가대암
  '957', // 십이동파
  '958', // 갈매여
  '959', // 해수서
  '960', // 지귀도
  '961', // 간여암
  '963', // 이덕서
  '966', // 풍도
  '967', // 도리도
  '984', // 오륙도
]);
const SINGLE_PILLAR_ISLAND_NAMES = new Set([
  '백령',
  '백령도',
  '대청',
  '대청도',
  '소청',
  '소청도',
  '연평',
  '연평도',
  '대연평',
  '덕적',
  '덕적도',
  '덕적북리',
  '덕적지도',
  '자월',
  '자월도',
  '승봉도',
  '목덕도',
  '서수도',
  '어청도',
  '외연도',
  '북격렬비도',
  '안마도',
  '말도',
  '임자도',
  '장산도',
  '신지도',
  '여서도',
  '소리도',
  '옥도',
  '교동',
  '장봉도',
  '호도',
  '삽시도',
  '홍성죽도',
  '볼음도',
  '무의도',
  '안도',
  '옹도',
  '흑산',
  '흑산도',
  '홍도',
  '가거도',
  '하태도',
  '상태도',
  '서거차도',
  '상조도',
  '하조도',
  '선유도',
  '보길도',
  '청산도',
  '위도',
  '자은도',
  '하의도',
  '비금',
  '안좌',
  '압해도',
  '나로도',
  '낙월도',
  '거문도',
  '초도',
  '욕지도',
  '매물도',
  '추자도',
  '마라도',
  '가파도',
  '우도',
  '가대암',
  '십이동파',
  '갈매여',
  '해수서',
  '지귀도',
  '간여암',
  '이덕서',
  '풍도',
  '도리도',
  '오륙도',
  '울릉',
  '울릉도',
  '독도',
]);
const SINGLE_PILLAR_ISLAND_ADDRESS_RULES = [
  ['옹진군'],
  ['울릉군'],
  ['신안군'],
  ['영광군', '낙월면'],
  ['강화군', '서도면'],
  ['군산시', '옥도면'],
  ['보령시', '오천면'],
  ['진도군', '조도면'],
  ['여수시', '남면'],
  ['여수시', '삼산면'],
  ['완도군', '청산면'],
  ['완도군', '보길면'],
  ['부안군', '위도면'],
  ['통영시', '한산면'],
  ['통영시', '사량면'],
  ['통영시', '욕지면'],
  ['제주시', '추자면'],
  ['제주시', '우도면'],
];
const ACCUM_EXTRUSION_COLOR_EXPRESSION = [
  'interpolate',
  ['linear'],
  ['get', 'value'],
  ...ACCUM_PALETTE.flatMap(({ min, color }) => [min, `rgb(${color.join(', ')})`]),
];

const isSinglePillarIslandStation = (station) => {
  const normalizedName = String(station.name ?? '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, '');
  const address = String(station.address ?? '');
  return (
    String(station.stationType ?? '').startsWith('7') ||
    SINGLE_PILLAR_ISLAND_STATION_IDS.has(String(station.id ?? '')) ||
    SINGLE_PILLAR_ISLAND_NAMES.has(normalizedName) ||
    SINGLE_PILLAR_ISLAND_ADDRESS_RULES.some((tokens) =>
      tokens.every((token) => address.includes(token)),
    )
  );
};

// 유효 셀 밖으로 강수값이 번지지 않도록 마스크를 유지한 채 5-tap 가우시안 필터를 적용한다.
const smoothMaskedAccumGrid = (source, width, height, passes) => {
  const kernel = [1, 4, 6, 4, 1];
  let current = source;

  for (let pass = 0; pass < passes; pass++) {
    const horizontal = new Float32Array(source.length).fill(-1);
    const output = new Float32Array(source.length).fill(-1);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (current[index] < 0) continue;
        let weightedValue = 0;
        let weightSum = 0;
        for (let offset = -2; offset <= 2; offset++) {
          const sampleX = x + offset;
          if (sampleX < 0 || sampleX >= width) continue;
          const value = current[y * width + sampleX];
          if (value < 0) continue;
          const weight = kernel[offset + 2];
          weightedValue += value * weight;
          weightSum += weight;
        }
        horizontal[index] = weightSum > 0 ? weightedValue / weightSum : current[index];
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (current[index] < 0) continue;
        let weightedValue = 0;
        let weightSum = 0;
        for (let offset = -2; offset <= 2; offset++) {
          const sampleY = y + offset;
          if (sampleY < 0 || sampleY >= height) continue;
          const value = horizontal[sampleY * width + x];
          if (value < 0) continue;
          const weight = kernel[offset + 2];
          weightedValue += value * weight;
          weightSum += weight;
        }
        output[index] = weightSum > 0 ? weightedValue / weightSum : horizontal[index];
      }
    }

    current = output;
  }

  return current;
};

const OBS_HISTORY_HOURS = 6;
const OBS_FRAME_INTERVAL_MINUTES = 5;
const OBS_FRAME_COUNT = (OBS_HISTORY_HOURS * 60) / OBS_FRAME_INTERVAL_MINUTES + 1; // 최신 포함 과거 6시간
const FRAME_CACHE_LIMIT = 48;
const INITIAL_OBS_PREFETCH_COUNT = 18;
const INITIAL_QPF_PREFETCH_COUNT = 18;
const NEARBY_PREFETCH_RADIUS = 3;
const PLAY_INTERVAL_MS = 450;

const BROADCAST_ADMIN_SOURCES = {
  'broadcast-sido': '/data/map/kr-sido-20260701.geojson',
  'broadcast-sgg': '/data/map/kr-sgg-20260701.geojson',
  'broadcast-sido-labels': '/data/map/kr-sido-labels-20260701.geojson',
  'broadcast-sgg-labels': '/data/map/kr-sgg-labels-20260701.geojson',
};
const BROADCAST_EMD_SOURCES = {
  'broadcast-emd': '/data/map/kr-emd-20260701.geojson',
  'broadcast-emd-labels': '/data/map/kr-emd-labels-20260701.geojson',
};
const BROADCAST_ADMIN_LAYER_IDS = [
  'broadcast-sido-border',
  'broadcast-sgg-border',
  'broadcast-emd-border',
  'broadcast-sido-label',
  'broadcast-sgg-label',
  'broadcast-emd-label',
  'broadcast-dokdo-dot',
];

const SIDO_SHORT_NAME = [
  'match',
  ['get', 'sidonm'],
  '서울특별시',
  '서울',
  '부산광역시',
  '부산',
  '대구광역시',
  '대구',
  '인천광역시',
  '인천',
  '대전광역시',
  '대전',
  '울산광역시',
  '울산',
  '세종특별자치시',
  '세종',
  '경기도',
  '경기',
  '강원특별자치도',
  '강원',
  '충청북도',
  '충북',
  '충청남도',
  '충남',
  '전북특별자치도',
  '전북',
  '전남광주통합특별시',
  '전남광주',
  '경상북도',
  '경북',
  '경상남도',
  '경남',
  '제주특별자치도',
  '제주',
  ['get', 'sidonm'],
];

const DOKDO_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: '독도' },
      geometry: { type: 'Point', coordinates: [131.86956, 37.24078] },
    },
  ],
};

const ensureBroadcastAdminLayers = (map) => {
  Object.entries(BROADCAST_ADMIN_SOURCES).forEach(([id, data]) => {
    if (!map.getSource(id)) {
      map.addSource(id, { type: 'geojson', data });
    }
  });
  if (!map.getSource('broadcast-dokdo')) {
    map.addSource('broadcast-dokdo', { type: 'geojson', data: DOKDO_GEOJSON });
  }

  const layers = [
    {
      id: 'broadcast-sido-border',
      type: 'line',
      source: 'broadcast-sido',
      paint: { 'line-color': '#364152', 'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 1.2, 8, 2] },
    },
    {
      id: 'broadcast-sgg-border',
      type: 'line',
      source: 'broadcast-sgg',
      minzoom: 6.8,
      paint: { 'line-color': '#6b7280', 'line-width': ['interpolate', ['linear'], ['zoom'], 6.8, 0.45, 10, 1] },
    },
    {
      id: 'broadcast-sido-label',
      type: 'symbol',
      source: 'broadcast-sido-labels',
      maxzoom: 7,
      layout: {
        'text-field': SIDO_SHORT_NAME,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4.5, 12, 7, 17],
        'text-font': ['Open Sans Bold'],
        'text-allow-overlap': false,
        'text-padding': 4,
      },
      paint: { 'text-color': '#263244', 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.5 },
    },
    {
      id: 'broadcast-sgg-label',
      type: 'symbol',
      source: 'broadcast-sgg-labels',
      minzoom: 6.9,
      maxzoom: 10,
      layout: {
        'text-field': ['get', 'sggnm'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6.9, 9, 9.5, 14],
        'text-font': ['Open Sans Semibold'],
        'text-allow-overlap': false,
        'text-padding': 2,
      },
      paint: { 'text-color': '#2f3b4d', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.25 },
    },
    {
      id: 'broadcast-dokdo-dot',
      type: 'circle',
      source: 'broadcast-dokdo',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 1.1, 8, 1.5, 12, 2],
        'circle-color': '#f8fafc',
        'circle-stroke-color': '#263244',
        'circle-stroke-width': 0.6,
      },
    },
  ];

  layers.forEach((layer) => {
    if (!map.getLayer(layer.id)) {
      map.addLayer({ ...layer, layout: { visibility: 'visible', ...layer.layout } });
    }
  });
};

const ensureBroadcastEmdLayers = (map) => {
  Object.entries(BROADCAST_EMD_SOURCES).forEach(([id, data]) => {
    if (!map.getSource(id)) {
      map.addSource(id, { type: 'geojson', data });
    }
  });

  const layers = [
    {
      id: 'broadcast-emd-border',
      type: 'line',
      source: 'broadcast-emd',
      minzoom: 9.55,
      paint: { 'line-color': '#9ca3af', 'line-width': 0.55, 'line-opacity': 0.9 },
    },
    {
      id: 'broadcast-emd-label',
      type: 'symbol',
      source: 'broadcast-emd-labels',
      minzoom: 9.8,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9.8, 9, 12, 13],
        'text-font': ['Open Sans Regular'],
        'text-allow-overlap': false,
        'text-padding': 1,
      },
      paint: { 'text-color': '#3b4657', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.1 },
    },
  ];

  layers.forEach((layer) => {
    if (!map.getLayer(layer.id)) {
      map.addLayer({ ...layer, layout: { visibility: 'visible', ...layer.layout } });
    }
  });
};

const setBroadcastAdminVisibility = (map, visible) => {
  if (visible) {
    ensureBroadcastAdminLayers(map);
  }
  BROADCAST_ADMIN_LAYER_IDS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  });
};

const MAP_STYLE = {
  version: 8,
  sources: {
    provinces: { type: 'geojson', data: krProvinces },
    neighbors: { type: 'geojson', data: neighborCoasts },
    interKoreanSeam: { type: 'geojson', data: interKoreanSeam },
  },
  layers: [
    { id: 'sea', type: 'background', paint: { 'background-color': '#dbe6ef' } },
    {
      id: 'neighbor-land',
      type: 'fill',
      source: 'neighbors',
      paint: { 'fill-color': '#eceae6' },
    },
    {
      id: 'inter-korean-seam',
      type: 'fill',
      source: 'interKoreanSeam',
      paint: { 'fill-color': '#eceae6', 'fill-opacity': 0 },
    },
    {
      id: 'neighbor-coast',
      type: 'line',
      source: 'neighbors',
      paint: { 'line-color': '#c3c8ce', 'line-width': 0.8 },
    },
    {
      id: 'land',
      type: 'fill',
      source: 'provinces',
      paint: { 'fill-color': '#ffffff' },
    },
    {
      id: 'province-border',
      type: 'line',
      source: 'provinces',
      paint: { 'line-color': '#a5aeb9', 'line-width': 1 },
    },
  ],
};

const mercatorY = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const inverseMercatorY = (value) =>
  ((2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180) / Math.PI;
const mercatorYToLat = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

// 캔버스 픽셀(웹 머카토르 균등 격자) → 레이더/QPF 데이터 인덱스 매핑을
// 한 번만 계산해 두고, 프레임 렌더링은 배열 조회만으로 처리한다.
const buildPixelMappings = (width, height) => {
  const { lonMin, lonMax, latMin, latMax } = VIEW_BOUNDS;
  const yTop = mercatorY(latMax);
  const yBottom = mercatorY(latMin);

  const radarWidth = Math.floor(RADAR_GRID.nx / RADAR_DOWNSAMPLE);
  const radarHeight = Math.floor(RADAR_GRID.ny / RADAR_DOWNSAMPLE);
  const radarCellKm = RADAR_GRID.cellKm * RADAR_DOWNSAMPLE;
  const radarMap = new Int32Array(width * height).fill(-1);
  const qpfMap = new Int32Array(width * height).fill(-1);
  const { cropSize, lccXMin, lccXMax, lccYMax } = QPF_IMAGE;
  const qpfKmPerPx = (lccXMax - lccXMin) / cropSize;

  // theta는 경도(열)에만, rho는 위도(행)에만 의존하므로 미리 계산해 둔다.
  const sinTheta = new Float64Array(width);
  const cosTheta = new Float64Array(width);
  for (let px = 0; px < width; px++) {
    const lon = lonMin + ((px + 0.5) / width) * (lonMax - lonMin);
    const theta = lccTheta(lon);
    sinTheta[px] = Math.sin(theta);
    cosTheta[px] = Math.cos(theta);
  }

  for (let py = 0; py < height; py++) {
    const lat = mercatorYToLat(yTop - ((py + 0.5) / height) * (yTop - yBottom));
    const rho = lccRhoKm(lat);
    for (let px = 0; px < width; px++) {
      const xKm = rho * sinTheta[px];
      const yKm = LCC_RHO0_KM - rho * cosTheta[px];
      const pixelIndex = py * width + px;

      const gi = Math.round(xKm / radarCellKm + RADAR_GRID.originI / RADAR_DOWNSAMPLE);
      const gj = Math.round(yKm / radarCellKm + RADAR_GRID.originJ / RADAR_DOWNSAMPLE);
      if (gi >= 0 && gi < radarWidth && gj >= 0 && gj < radarHeight) {
        radarMap[pixelIndex] = gj * radarWidth + gi;
      }

      const qx = Math.round((xKm - lccXMin) / qpfKmPerPx);
      const qy = Math.round((lccYMax - yKm) / qpfKmPerPx);
      if (qx >= 0 && qx < cropSize && qy >= 0 && qy < cropSize) {
        qpfMap[pixelIndex] = qy * cropSize + qx;
      }
    }
  }

  return { radarMap, qpfMap };
};

// KIM 국지 격자는 (126E, 38N) 원점 좌표가 x0/y0로 주어지며 y축은 북쪽으로 증가한다.
const buildKimPixelMapping = (width, height, meta) => {
  const { lonMin, lonMax, latMin, latMax } = KIM_VIEW_BOUNDS;
  const yTop = mercatorY(latMax);
  const yBottom = mercatorY(latMin);
  const baseIndex = new Int32Array(width * height).fill(-1);
  const fractionX = new Uint8Array(width * height);
  const fractionY = new Uint8Array(width * height);
  const sinTheta = new Float64Array(width);
  const cosTheta = new Float64Array(width);

  for (let px = 0; px < width; px += 1) {
    const lon = lonMin + ((px + 0.5) / width) * (lonMax - lonMin);
    const theta = lccTheta(lon);
    sinTheta[px] = Math.sin(theta);
    cosTheta[px] = Math.cos(theta);
  }

  for (let py = 0; py < height; py += 1) {
    const lat = mercatorYToLat(yTop - ((py + 0.5) / height) * (yTop - yBottom));
    const rho = lccRhoKm(lat);
    for (let px = 0; px < width; px += 1) {
      const xKm = rho * sinTheta[px];
      const yKm = LCC_RHO0_KM - rho * cosTheta[px];
      const gridX = xKm / meta.gridKm + meta.originX;
      const gridY = yKm / meta.gridKm + meta.originY;
      const left = Math.floor(gridX);
      const bottom = Math.floor(gridY);
      if (left >= 0 && left + 1 < meta.width && bottom >= 0 && bottom + 1 < meta.height) {
        const pixelIndex = py * width + px;
        baseIndex[pixelIndex] = bottom * meta.width + left;
        fractionX[pixelIndex] = Math.round((gridX - left) * 255);
        fractionY[pixelIndex] = Math.round((gridY - bottom) * 255);
      }
    }
  }
  return { baseIndex, fractionX, fractionY, gridWidth: meta.width };
};

const KIM_CUBIC_WEIGHTS = Array.from({ length: 256 }, (_, index) => {
  const t = index / 255;
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    -0.5 * t + t2 - 0.5 * t3,
    1 - 2.5 * t2 + 1.5 * t3,
    0.5 * t + 2 * t2 - 1.5 * t3,
    -0.5 * t2 + 0.5 * t3,
  ];
});

const sampleKimCubicRow = (values, offset, weights) =>
  values[offset] * weights[0] +
  values[offset + 1] * weights[1] +
  values[offset + 2] * weights[2] +
  values[offset + 3] * weights[3];

const sampleKimRainBicubic = (values, sourceIndex, fxByte, fyByte, gridWidth) => {
  const x = sourceIndex % gridWidth;
  const y = Math.floor(sourceIndex / gridWidth);
  const gridHeight = Math.floor(values.length / gridWidth);
  const fx = fxByte / 255;
  const fy = fyByte / 255;

  if (x < 1 || x + 2 >= gridWidth || y < 1 || y + 2 >= gridHeight) {
    const topIndex = sourceIndex + gridWidth;
    const lower = values[sourceIndex] * (1 - fx) + values[sourceIndex + 1] * fx;
    const upper = values[topIndex] * (1 - fx) + values[topIndex + 1] * fx;
    return lower * (1 - fy) + upper * fy;
  }

  const wx = KIM_CUBIC_WEIGHTS[fxByte];
  const wy = KIM_CUBIC_WEIGHTS[fyByte];
  const rowStart = sourceIndex - gridWidth - 1;
  const row0 = sampleKimCubicRow(values, rowStart, wx);
  const row1 = sampleKimCubicRow(values, rowStart + gridWidth, wx);
  const row2 = sampleKimCubicRow(values, rowStart + gridWidth * 2, wx);
  const row3 = sampleKimCubicRow(values, rowStart + gridWidth * 3, wx);
  const interpolated =
    row0 * wy[0] + row1 * wy[1] + row2 * wy[2] + row3 * wy[3];

  // Clamp cubic ringing so smoothed contours do not invent stronger rainfall peaks.
  const topIndex = sourceIndex + gridWidth;
  const localMin = Math.min(
    values[sourceIndex],
    values[sourceIndex + 1],
    values[topIndex],
    values[topIndex + 1],
  );
  const localMax = Math.max(
    values[sourceIndex],
    values[sourceIndex + 1],
    values[topIndex],
    values[topIndex + 1],
  );
  return Math.min(localMax, Math.max(localMin, interpolated));
};

const OBS_TIMELINE_RANGE_MINUTES = 360;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 레이더 발표 주기에 맞춘 자동 갱신

// --- 방송모드 ---
const BROADCAST_PLAY_DURATIONS = Array.from({ length: 11 }, (_, index) => index + 5); // 5~15초
const BROADCAST_CACHE_LIMIT = 130; // 전 구간 재생을 위해 모든 프레임을 캐시
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

// 기본(포털) 초기 화면: 남한 전체. 방송모드: 서해 상 접근 강수까지 보이는 광역 구도.
const KOREA_MAP_BOUNDS = [
  [125.0, 32.9],
  [129.8, 38.7],
];
// 16:9 화면에서 위도 범위가 기준: 남한(제주 포함)이 화면 세로의 약 70%를 차지한다.
const BROADCAST_MAP_BOUNDS = [
  [121.5, 32.1],
  [133.5, 39.5],
];

const formatBroadcastDate = (time) =>
  `${time.getMonth() + 1}/${time.getDate()} (${WEEKDAY_LABELS[time.getDay()]})`;

// 지도 배색: 기본(포털)과 방송(어두운 바다·회색 주변국) 두 벌
const MAP_COLOR_THEMES = {
  default: {
    sea: '#dbe6ef',
    neighborLand: '#eceae6',
    neighborCoast: '#c3c8ce',
    land: '#ffffff',
    provinceBorder: '#a5aeb9',
    interKoreanSeamOpacity: 0,
  },
  broadcast: {
    sea: '#46536a',
    neighborLand: '#828c9c',
    neighborCoast: '#5d6879',
    land: '#eef0f2',
    provinceBorder: '#4a5568',
    interKoreanSeamOpacity: 1,
  },
};

const fitBroadcastFlatView = (map, duration = 0) => {
  map.setBearing(0);
  map.setPitch(0);
  map.fitBounds(BROADCAST_MAP_BOUNDS, { padding: 0, duration });
};

const fitKimLocalView = (map, duration = 0) => {
  map.setBearing(0);
  map.setPitch(0);
  map.fitBounds(
    [
      [KIM_VIEW_BOUNDS.lonMin, KIM_VIEW_BOUNDS.latMin],
      [KIM_VIEW_BOUNDS.lonMax, KIM_VIEW_BOUNDS.latMax],
    ],
    { padding: 0, duration },
  );
};

const applyMapColorTheme = (map, theme) => {
  const properties = [
    ['sea', 'background-color', theme.sea],
    ['neighbor-land', 'fill-color', theme.neighborLand],
    ['inter-korean-seam', 'fill-color', theme.neighborLand],
    ['inter-korean-seam', 'fill-opacity', theme.interKoreanSeamOpacity],
    ['neighbor-coast', 'line-color', theme.neighborCoast],
    ['land', 'fill-color', theme.land],
    ['province-border', 'line-color', theme.provinceBorder],
    ['province-border', 'line-opacity', 0],
  ];
  let applied = 0;

  properties.forEach(([layerId, property, value]) => {
    if (!map.getLayer(layerId)) return;
    try {
      map.setPaintProperty(layerId, property, value);
      applied += 1;
    } catch {
      // Style layers can briefly be unavailable while fullscreen layout settles.
    }
  });
  if (applied > 0) map.triggerRepaint();
  return applied === properties.length;
};

const formatHourMinute = (validTime) =>
  `${String(validTime.getHours()).padStart(2, '0')}:${String(validTime.getMinutes()).padStart(2, '0')}`;

const LEGEND_SEGMENTS = [
  { key: 'blue', values: [0.1, 0.5, 1] },
  { key: 'green', values: [2, 3, 4, 5] },
  { key: 'yellow', values: [6, 7, 8, 9, 10] },
  { key: 'red', values: [15, 20, 25, 30] },
  { key: 'purple', values: [40, 50, 60, 70] },
  { key: 'navy', values: [90, 110, 150] },
];

const LEGEND_SCALE_STOPS = [
  { value: 0, position: 0 },
  { value: 1, position: 100 / 6 },
  { value: 5, position: (100 / 6) * 2 },
  { value: 10, position: (100 / 6) * 3 },
  { value: 30, position: (100 / 6) * 4 },
  { value: 70, position: (100 / 6) * 5 },
  { value: 150, position: 100 },
];
const LEGEND_LABELS = [0, 1, 5, 10, 30, 50, 100, 150];

const getPaletteColorByValue = (value) =>
  RAIN_PALETTE.find((item) => item.min === value)?.color ?? [0, 0, 0];

const getContinuousRainColor = (value) => {
  if (value < 0.05) return null;
  if (value <= RAIN_PALETTE[0].min) return RAIN_PALETTE[0].color;
  for (let index = 1; index < RAIN_PALETTE.length; index += 1) {
    const lower = RAIN_PALETTE[index - 1];
    const upper = RAIN_PALETTE[index];
    if (value <= upper.min) {
      const ratio = (value - lower.min) / (upper.min - lower.min);
      return lower.color.map((channel, channelIndex) =>
        Math.round(channel + (upper.color[channelIndex] - channel) * ratio),
      );
    }
  }
  return RAIN_PALETTE.at(-1).color;
};

const KIM_RAIN_COLOR_LUT = (() => {
  const lookup = new Uint8Array(65536 * 3);
  for (let encoded = 5; encoded < 65536; encoded += 1) {
    const color = getContinuousRainColor(encoded / 100);
    if (!color) continue;
    const offset = encoded * 3;
    lookup[offset] = color[0];
    lookup[offset + 1] = color[1];
    lookup[offset + 2] = color[2];
  }
  return lookup;
})();

const getLegendLabelPosition = (value) => {
  const exactStop = LEGEND_SCALE_STOPS.find((item) => item.value === value);
  if (exactStop) {
    return exactStop.position;
  }

  const upperIndex = LEGEND_SCALE_STOPS.findIndex((item) => item.value > value);
  if (upperIndex <= 0) return 0;
  if (upperIndex === -1) return 100;

  const lowerStop = LEGEND_SCALE_STOPS[upperIndex - 1];
  const upperStop = LEGEND_SCALE_STOPS[upperIndex];
  const valueRatio = (value - lowerStop.value) / (upperStop.value - lowerStop.value);
  return lowerStop.position + (upperStop.position - lowerStop.position) * valueRatio;
};

const getLegendLabelClassName = (position) => {
  if (position >= 96) {
    return 'absolute top-0 -translate-x-full text-right text-[10px] font-medium text-slate-500';
  }
  if (position <= 4) {
    return 'absolute top-0 text-[10px] font-medium text-slate-500';
  }
  return 'absolute top-0 -translate-x-1/2 text-[10px] font-medium text-slate-500';
};

const RadarLegend = () => (
  <div className="flex items-start gap-2 text-[11px] text-slate-500">
    <span className="mt-0.5 shrink-0 font-semibold">mm/h</span>
    <div className="relative flex-1 pb-5">
      <div className="flex h-3 overflow-hidden rounded-sm">
        {LEGEND_SEGMENTS.map((segment) => (
          <div
            key={segment.key}
            className="flex flex-1"
          >
            {segment.values.map((value) => {
              const color = getPaletteColorByValue(value);
              return (
                <div
                  key={value}
                  className="flex-1"
                  style={{ backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="absolute left-0 right-0 top-4 h-4">
        {LEGEND_LABELS.map((value) => {
          const position = getLegendLabelPosition(value);
          return (
            <span
              key={value}
              className={getLegendLabelClassName(position)}
              style={{ left: `${position}%` }}
            >
              {value}
            </span>
          );
        })}
      </div>
    </div>
  </div>
);

const RadarMapView = ({ refreshToken = 0, initialBroadcast = false }) => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const transitionFromCanvasRef = useRef(null);
  const transitionToCanvasRef = useRef(null);
  const transitionAnimationRef = useRef(null);
  const accumSurfaceLayerRef = useRef(null);
  const mappingsRef = useRef(null);
  const kimMappingRef = useRef(null);
  const imageDataRef = useRef(null);
  const frameCacheRef = useRef(new Map());
  const pendingRef = useRef(new Map());
  const kimCacheRef = useRef(new Map());
  const kimPendingRef = useRef(new Map());
  const renderTokenRef = useRef(0);
  const [frames, setFrames] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [statusMessage, setStatusMessage] = useState('');
  // 전체화면: 지원 브라우저는 네이티브 API, 미지원(iOS 사파리 등)은 CSS 오버레이로 대체
  const sectionRef = useRef(null);
  const [fullscreenMode, setFullscreenMode] = useState(initialBroadcast ? 'css' : null); // null | 'native' | 'css'
  const isFullscreen = fullscreenMode !== null;
  // 방송모드: 전체화면 + 방송 그래픽 레이아웃 (PC 전용)
  const [isBroadcast, setIsBroadcast] = useState(initialBroadcast);
  const [isBroadcastMapReady, setIsBroadcastMapReady] = useState(initialBroadcast);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [playTarget, setPlayTarget] = useState(null);
  const [playIntervalMs, setPlayIntervalMs] = useState(PLAY_INTERVAL_MS);
  const [broadcastView, setBroadcastView] = useState('radar'); // 'radar' | 'kim' | 'accum' | 'satellite'
  const [kimMeta, setKimMeta] = useState(null);
  const [kimFrames, setKimFrames] = useState([]);
  const [kimIndex, setKimIndex] = useState(0);
  const [kimStatus, setKimStatus] = useState('idle'); // idle | loading | ready | error
  const [kimError, setKimError] = useState('');
  const [kimRefreshTick, setKimRefreshTick] = useState(0);
  const [kimPlayIntervalMs, setKimPlayIntervalMs] = useState(PLAY_INTERVAL_MS);
  const [accumDays, setAccumDays] = useState(1);
  const [accumHours, setAccumHours] = useState([]);
  const [accumIndex, setAccumIndex] = useState(0);
  const [accumStatus, setAccumStatus] = useState('idle'); // idle | loading | ready | error
  const [accumError, setAccumError] = useState('');
  const [accumTop5, setAccumTop5] = useState([]);
  const [accumDisplayMode, setAccumDisplayMode] = useState('flat'); // 'flat' | '3d'
  const [accum3dStyle, setAccum3dStyle] = useState('columns'); // 'columns' | 'surface'
  const accumHourlyCacheRef = useRef(new Map()); // 정시 tm → Map<지점, RN_DAY>
  const accumHourlyPendingRef = useRef(new Map());
  const accumAnchorHoursRef = useRef([]); // API-backed frames; displayed hours are interpolated.
  const accumBasesRef = useRef([]); // 기간 내 일 인덱스별 지점 누적 베이스 Map
  const accumStationsRef = useRef(null);
  const accumIdwRef = useRef(null);
  const accumCanvasRef = useRef(null);
  const accumRenderTokenRef = useRef(0);
  const accumWas3dRef = useRef(false);
  const accumPreviousPitchRef = useRef(0);
  const isAccumView = isBroadcast && broadcastView === 'accum';
  const isKimView = isBroadcast && broadcastView === 'kim';
  const isSatelliteView = isBroadcast && broadcastView === 'satellite';
  const cacheLimitRef = useRef(FRAME_CACHE_LIMIT);

  const loadAccumAnchor = useCallback((hour) => {
    if (hour.getHours() === 0) {
      return Promise.resolve(null);
    }
    const tm = formatAccumHourTm(hour);
    if (accumHourlyCacheRef.current.has(tm)) {
      return Promise.resolve(accumHourlyCacheRef.current.get(tm));
    }
    const pending = accumHourlyPendingRef.current.get(tm);
    if (pending) {
      return pending;
    }
    const request = fetchHourlyRnDay(hour)
      .then((data) => {
        accumHourlyCacheRef.current.set(tm, data);
        return data;
      })
      .finally(() => {
        accumHourlyPendingRef.current.delete(tm);
      });
    accumHourlyPendingRef.current.set(tm, request);
    return request;
  }, []);
  const navControlRef = useRef(null);
  const navControlAddedRef = useRef(false);
  // 주기적 자동 갱신(눈금·'현재'가 실제 시간을 따라가도록)
  const [autoRefreshTick, setAutoRefreshTick] = useState(0);
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const lastRefreshTokenRef = useRef(refreshToken);
  const lastManualRefreshTickRef = useRef(0);
  const lastKimRefreshTickRef = useRef(0);
  const lastBuildSignatureRef = useRef('');
  const framesRef = useRef([]);
  const frameIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playIntervalRef = useRef(PLAY_INTERVAL_MS);
  const hasRenderedFrameRef = useRef(false);

  const canvasHeight = useMemo(() => {
    const xSpan = VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin;
    const ySpan = ((mercatorY(VIEW_BOUNDS.latMax) - mercatorY(VIEW_BOUNDS.latMin)) * 180) / Math.PI;
    return Math.round((CANVAS_WIDTH * ySpan) / xSpan);
  }, []);

  // 지도 초기화
  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      // 화면 비율과 무관하게 남한 전체(제주 포함)가 들어오도록 영역 기준으로 맞춘다.
      bounds: KOREA_MAP_BOUNDS,
      fitBoundsOptions: { padding: 12 },
      minZoom: 4.5,
      maxZoom: 10,
      maxPitch: 60,
      attributionControl: false,
      localIdeographFontFamily: '"Noto Sans KR", "Malgun Gothic", sans-serif',
      dragRotate: false,
      pitchWithRotate: true,
      touchPitch: true,
    });
    // MapLibre는 마우스 피치와 회전을 함께 노출하므로 피치 핸들러만 선택적으로 켠다.
    map.dragRotate._mousePitch?.enable();
    // 터치에서도 북쪽 방향을 유지하면서 두 손가락 위아래 드래그로 기울기만 조절한다.
    map.touchZoomRotate.disableRotation();
    const navControl = new maplibregl.NavigationControl({ showCompass: false });
    map.addControl(navControl, 'top-right');
    navControlRef.current = navControl;
    navControlAddedRef.current = true;
    mapRef.current = map;
    if (import.meta.env.DEV) {
      window.__radarMap = map;
    }

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = canvasHeight;
    overlayCanvasRef.current = canvas;
    [transitionFromCanvasRef, transitionToCanvasRef].forEach((canvasRef) => {
      const transitionCanvas = document.createElement('canvas');
      transitionCanvas.width = CANVAS_WIDTH;
      transitionCanvas.height = canvasHeight;
      canvasRef.current = transitionCanvas;
    });

    // 백그라운드 탭에서는 rAF가 멈춰 'load'가 늦게(또는 보일 때) 발화하므로,
    // 스타일 로딩 완료를 폴링으로도 감지해 소스·라벨을 붙인다.
    let isSetupDone = false;
    const setupOverlay = () => {
      if (isSetupDone || !mapRef.current || map.getSource('radar-overlay')) {
        return;
      }
      isSetupDone = true;
      map.addSource('radar-overlay', {
        type: 'canvas',
        canvas,
        animate: false,
        coordinates: [
          [VIEW_BOUNDS.lonMin, VIEW_BOUNDS.latMax],
          [VIEW_BOUNDS.lonMax, VIEW_BOUNDS.latMax],
          [VIEW_BOUNDS.lonMax, VIEW_BOUNDS.latMin],
          [VIEW_BOUNDS.lonMin, VIEW_BOUNDS.latMin],
        ],
      });
      map.addLayer(
        {
          id: 'radar-overlay',
          type: 'raster',
          source: 'radar-overlay',
          // linear 리샘플링: 확대 시 에코 경계가 계단식이 아니라 부드럽게 보간된다.
          paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' },
        },
        'province-border',
      );

      const accumSurfaceLayer = createAccumSurfaceLayer(ACCUM_PALETTE);
      accumSurfaceLayerRef.current = accumSurfaceLayer;
      map.addLayer(accumSurfaceLayer, 'province-border');

      map.addSource(ACCUM_EXTRUSION_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer(
        {
          id: ACCUM_EXTRUSION_LAYER_ID,
          type: 'fill-extrusion',
          source: ACCUM_EXTRUSION_SOURCE_ID,
          layout: { visibility: 'none' },
          paint: {
            'fill-extrusion-base': 0,
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-color': ACCUM_EXTRUSION_COLOR_EXPRESSION,
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        'province-border',
      );

      ensureBroadcastAdminLayers(map);
    };

    map.on('load', setupOverlay);
    const setupTimer = window.setInterval(() => {
      if (isSetupDone) {
        window.clearInterval(setupTimer);
      } else if (map.isStyleLoaded()) {
        setupOverlay();
        window.clearInterval(setupTimer);
      }
    }, 300);

    return () => {
      window.clearInterval(setupTimer);
      if (transitionAnimationRef.current !== null) {
        cancelAnimationFrame(transitionAnimationRef.current);
      }
      map.remove();
      mapRef.current = null;
      accumSurfaceLayerRef.current = null;
      overlayCanvasRef.current = null;
      transitionFromCanvasRef.current = null;
      transitionToCanvasRef.current = null;
      transitionAnimationRef.current = null;
      navControlRef.current = null;
      navControlAddedRef.current = false;
    };
  }, [canvasHeight]);

  // KIM 캔버스는 국지모델이 제공하는 한반도 전체 영역에 맞춘다.
  useEffect(() => {
    const applyDomain = () => {
      const map = mapRef.current;
      const source = map?.getSource('radar-overlay');
      if (!map || !source?.setCoordinates) return false;
      const bounds = isKimView ? KIM_VIEW_BOUNDS : VIEW_BOUNDS;
      source.setCoordinates([
        [bounds.lonMin, bounds.latMax],
        [bounds.lonMax, bounds.latMax],
        [bounds.lonMax, bounds.latMin],
        [bounds.lonMin, bounds.latMin],
      ]);
      if (isBroadcast) {
        if (isKimView) {
          fitKimLocalView(map, 650);
        } else {
          fitBroadcastFlatView(map, 650);
        }
      } else {
        map.setBearing(0);
        map.setPitch(0);
        map.fitBounds(KOREA_MAP_BOUNDS, { padding: 12, duration: 650 });
      }
      return true;
    };

    if (applyDomain()) return undefined;
    const timer = window.setInterval(() => {
      if (applyDomain()) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [broadcastView, isBroadcast, isKimView]);

  // 픽셀 매핑 준비 (무거운 계산이라 렌더 이후 한 번만)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      mappingsRef.current = buildPixelMappings(CANVAS_WIDTH, canvasHeight);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canvasHeight]);

  const refreshOverlaySource = useCallback(() => {
    const map = mapRef.current;
    const source = map?.getSource('radar-overlay');
    if (!source) {
      return;
    }
    // animate=false 캔버스 소스는 play→pause로 한 번만 다시 업로드한다.
    source.play();
    requestAnimationFrame(() => {
      source.pause();
      map.triggerRepaint();
    });
  }, []);

  const renderFrame = useCallback(
    (frame) => {
      const canvas = overlayCanvasRef.current;
      const fromCanvas = transitionFromCanvasRef.current;
      const toCanvas = transitionToCanvasRef.current;
      const mappings = mappingsRef.current;
      if (!canvas || !fromCanvas || !toCanvas || !mappings || !frame) {
        return;
      }

      const context = canvas.getContext('2d');
      const toContext = toCanvas.getContext('2d');
      if (!imageDataRef.current) {
        imageDataRef.current = context.createImageData(canvas.width, canvas.height);
      }
      const imageData = imageDataRef.current;
      const pixels = imageData.data;
      if (frame.kind === 'kim') {
        const mapping = kimMappingRef.current;
        if (!mapping || !frame.values) return;
        const { baseIndex, fractionX, fractionY, gridWidth } = mapping;
        for (let index = 0; index < baseIndex.length; index += 1) {
          const pixelOffset = index * 4;
          const sourceIndex = baseIndex[index];
          if (sourceIndex < 0) {
            pixels[pixelOffset + 3] = 0;
            continue;
          }
          const encoded = Math.min(
            65535,
            Math.round(
              sampleKimRainBicubic(
                frame.values,
                sourceIndex,
                fractionX[index],
                fractionY[index],
                gridWidth,
              ),
            ),
          );
          if (encoded < 5) {
            pixels[pixelOffset + 3] = 0;
            continue;
          }
          const colorOffset = encoded * 3;
          pixels[pixelOffset] = KIM_RAIN_COLOR_LUT[colorOffset];
          pixels[pixelOffset + 1] = KIM_RAIN_COLOR_LUT[colorOffset + 1];
          pixels[pixelOffset + 2] = KIM_RAIN_COLOR_LUT[colorOffset + 2];
          pixels[pixelOffset + 3] = Math.round(OVERLAY_ALPHA * Math.min(1, encoded / 10));
        }
      } else {
        const dataMap = frame.kind === 'obs' ? mappings.radarMap : mappings.qpfMap;
        const { buckets } = frame;
        for (let index = 0; index < dataMap.length; index += 1) {
          const offset = index * 4;
          const sourceIndex = dataMap[index];
          const bucket = sourceIndex >= 0 ? buckets[sourceIndex] : 0;
          if (bucket > 0) {
            const [r, g, b] = RAIN_PALETTE[bucket - 1].color;
            pixels[offset] = r;
            pixels[offset + 1] = g;
            pixels[offset + 2] = b;
            pixels[offset + 3] = OVERLAY_ALPHA;
          } else {
            pixels[offset + 3] = 0;
          }
        }
      }

      toContext.putImageData(imageData, 0, 0);

      if (transitionAnimationRef.current !== null) {
        cancelAnimationFrame(transitionAnimationRef.current);
        transitionAnimationRef.current = null;
      }

      if (!isPlayingRef.current || !hasRenderedFrameRef.current) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(toCanvas, 0, 0);
        hasRenderedFrameRef.current = true;
        refreshOverlaySource();
        return;
      }

      const fromContext = fromCanvas.getContext('2d');
      fromContext.clearRect(0, 0, fromCanvas.width, fromCanvas.height);
      fromContext.drawImage(canvas, 0, 0);

      const durationMs = Math.min(220, Math.max(55, playIntervalRef.current * 0.72));
      const source = mapRef.current?.getSource('radar-overlay');
      source?.play();
      const startedAt = performance.now();

      const dissolve = (timestamp) => {
        const progress = Math.min(1, (timestamp - startedAt) / durationMs);
        const easedProgress = progress * progress * (3 - 2 * progress);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 1 - easedProgress;
        context.drawImage(fromCanvas, 0, 0);
        // 가중 합성으로 반투명 에코의 중간 밝기가 꺼지는 플래시를 방지한다.
        context.globalCompositeOperation = 'lighter';
        context.globalAlpha = easedProgress;
        context.drawImage(toCanvas, 0, 0);
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'source-over';
        mapRef.current?.triggerRepaint();

        if (progress < 1) {
          transitionAnimationRef.current = requestAnimationFrame(dissolve);
          return;
        }
        transitionAnimationRef.current = null;
        source?.pause();
        mapRef.current?.triggerRepaint();
      };

      transitionAnimationRef.current = requestAnimationFrame(dissolve);
    },
    [refreshOverlaySource],
  );

  const rememberFrameBuckets = useCallback((key, buckets) => {
    const cache = frameCacheRef.current;
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, buckets);

    while (cache.size > cacheLimitRef.current) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  }, []);

  const loadFrameData = useCallback((frameDef) => {
    const cache = frameCacheRef.current;
    if (cache.has(frameDef.key)) {
      const cachedBuckets = cache.get(frameDef.key);
      cache.delete(frameDef.key);
      cache.set(frameDef.key, cachedBuckets);
      return Promise.resolve(cachedBuckets);
    }

    const pending = pendingRef.current;
    if (pending.has(frameDef.key)) {
      return pending.get(frameDef.key);
    }

    const promise = (frameDef.kind === 'obs'
      ? fetchRadarFrame(frameDef.tm, { broadcast: isBroadcast })
      : fetchQpfFrame(frameDef.tm, frameDef.ef)
    )
      .then((data) => {
        rememberFrameBuckets(frameDef.key, data.buckets);
        return data.buckets;
      })
      .finally(() => {
        pending.delete(frameDef.key);
      });
    pending.set(frameDef.key, promise);
    return promise;
  }, [isBroadcast, rememberFrameBuckets]);

  const rememberKimValues = useCallback((key, values) => {
    const cache = kimCacheRef.current;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, values);
    while (cache.size > 72) {
      cache.delete(cache.keys().next().value);
    }
  }, []);

  const loadKimFrameData = useCallback(
    (frameDef) => {
      const cache = kimCacheRef.current;
      if (cache.has(frameDef.key)) {
        const values = cache.get(frameDef.key);
        cache.delete(frameDef.key);
        cache.set(frameDef.key, values);
        return Promise.resolve(values);
      }
      if (kimPendingRef.current.has(frameDef.key)) {
        return kimPendingRef.current.get(frameDef.key);
      }
      const request = fetchKimRainFrame(frameDef.baseTime, frameDef.leadHour)
        .then((data) => {
          rememberKimValues(frameDef.key, data.values);
          return data.values;
        })
        .finally(() => kimPendingRef.current.delete(frameDef.key));
      kimPendingRef.current.set(frameDef.key, request);
      return request;
    },
    [rememberKimValues],
  );

  // 완성된 최신 KIM 국지모델 주기를 선택하고 현재 이후 첫 프레임을 준비한다.
  useEffect(() => {
    if (!isKimView) return undefined;
    let isActive = true;
    const isManualRefresh = kimRefreshTick !== lastKimRefreshTickRef.current;
    lastKimRefreshTickRef.current = kimRefreshTick;

    const initializeKim = async () => {
      setIsPlaying(false);
      setKimStatus('loading');
      setKimError('');
      if (isManualRefresh) {
        kimCacheRef.current.clear();
        kimPendingRef.current.clear();
      }
      try {
        const meta = await fetchLatestKimRainMeta({ refresh: isManualRefresh });
        const nextFrames = buildKimRainFrames(meta, new Date());
        if (nextFrames.length === 0) {
          throw new Error('현재 이후의 KIM 강수 예상 프레임이 없습니다.');
        }
        kimMappingRef.current = buildKimPixelMapping(CANVAS_WIDTH, canvasHeight, meta);
        await loadKimFrameData(nextFrames[0]);
        if (!isActive) return;
        setKimMeta(meta);
        setKimFrames(nextFrames);
        setKimIndex(0);
        setKimStatus('ready');
      } catch (error) {
        if (isActive) {
          setKimStatus('error');
          setKimError(error.message);
        }
      }
    };

    initializeKim();
    return () => {
      isActive = false;
    };
  }, [canvasHeight, isKimView, kimRefreshTick, loadKimFrameData]);

  // 초기 로딩 및 상단 새로고침(refreshToken 변경) 시 타임라인 재구성
  useEffect(() => {
    let isActive = true;

    const initialize = async () => {
      const isExternalRefresh = refreshToken !== lastRefreshTokenRef.current;
      const isLocalRefresh = manualRefreshTick !== lastManualRefreshTickRef.current;
      const isManualRefresh = isExternalRefresh || isLocalRefresh;
      lastRefreshTokenRef.current = refreshToken;
      lastManualRefreshTickRef.current = manualRefreshTick;

      if (isManualRefresh) {
        frameCacheRef.current.clear();
        pendingRef.current.clear();
        setIsPlaying(false);
        setStatus('loading');
      } else if (autoRefreshTick > 0 && isPlayingRef.current) {
        // 재생 중에는 자동 갱신으로 타임라인을 흔들지 않는다. 다음 주기에 반영.
        return;
      }

      try {
        const [radarLatest, qpfLatest] = await Promise.all([
          probeLatestRadarTm(
            new Date(),
            OBS_HISTORY_HOURS * 60,
            ({ tm, frame }) => rememberFrameBuckets(`obs-${tm}`, frame.buckets),
            { broadcast: isBroadcast },
          ),
          probeLatestQpfTm().catch(() => null),
        ]);
        if (!isActive) {
          return;
        }

        // 자동 갱신인데 최신 발표가 그대로면 타임라인을 건드리지 않는다.
        const buildSignature = `${radarLatest.tm}|${qpfLatest?.tm ?? ''}`;
        if (!isManualRefresh && buildSignature === lastBuildSignatureRef.current) {
          return;
        }
        lastBuildSignatureRef.current = buildSignature;

        const latestObsTime = parseRadarTm(radarLatest.tm);
        const observationFrames = [];
        for (let step = OBS_FRAME_COUNT - 1; step >= 0; step--) {
          const time = new Date(latestObsTime.getTime() - step * OBS_FRAME_INTERVAL_MINUTES * 60 * 1000);
          const tm = `${time.getFullYear()}${String(time.getMonth() + 1).padStart(2, '0')}${String(time.getDate()).padStart(2, '0')}${String(time.getHours()).padStart(2, '0')}${String(time.getMinutes()).padStart(2, '0')}`;
          observationFrames.push({
            key: `obs-${tm}`,
            kind: 'obs',
            tm,
            validTime: time,
          });
        }

        const forecastFrames = (qpfLatest?.frames ?? [])
          .filter(({ validTime }) => validTime > latestObsTime)
          .map(({ tm, ef, validTime }) => ({
            key: `fct-${tm}-${ef}`,
            kind: 'fct',
            tm,
            ef,
            validTime,
          }));

        rememberFrameBuckets(`obs-${radarLatest.tm}`, radarLatest.frame.buckets);
        if (qpfLatest) {
          rememberFrameBuckets(`fct-${qpfLatest.tm}-${qpfLatest.ef}`, qpfLatest.frame.buckets);
        }

        const timeline = [...observationFrames, ...forecastFrames];

        // 자동 갱신 시, 사용자가 최신 프레임이 아닌 곳을 보고 있었다면
        // 보고 있던 시각과 가장 가까운 프레임을 유지한다.
        let nextFrameIndex = observationFrames.length - 1;
        const previousFrames = framesRef.current;
        const previousFrame = previousFrames[frameIndexRef.current];
        const previousLatestObs = previousFrames.filter((frame) => frame.kind === 'obs').at(-1);
        if (
          !isManualRefresh &&
          previousFrame &&
          previousLatestObs &&
          previousFrame.key !== previousLatestObs.key
        ) {
          let nearestDistance = Number.POSITIVE_INFINITY;
          timeline.forEach((frame, index) => {
            const distance = Math.abs(frame.validTime.getTime() - previousFrame.validTime.getTime());
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nextFrameIndex = index;
            }
          });
        }

        setFrames(timeline);
        setFrameIndex(nextFrameIndex);
        setStatus('ready');

        // 6시간 전체를 한 번에 받으면 API와 브라우저 메모리에 부담이 커서 최신 주변부터 천천히 받는다.
        const prefetchQueue = [
          ...[...observationFrames].reverse().slice(0, INITIAL_OBS_PREFETCH_COUNT),
          ...forecastFrames.slice(0, INITIAL_QPF_PREFETCH_COUNT),
        ];
        let cursor = 0;
        const pump = () => {
          if (!isActive || cursor >= prefetchQueue.length) {
            return;
          }
          const frameDef = prefetchQueue[cursor];
          cursor += 1;
          loadFrameData(frameDef)
            .catch(() => {})
            .finally(() => {
              window.setTimeout(pump, 300);
            });
        };
        pump();
      } catch (error) {
        if (isActive) {
          setStatus('error');
          setStatusMessage(error.message);
        }
      }
    };

    initialize();
    return () => {
      isActive = false;
    };
  }, [
    loadFrameData,
    rememberFrameBuckets,
    refreshToken,
    autoRefreshTick,
    manualRefreshTick,
    isBroadcast,
  ]);

  // 시간이 흐르면 '현재'와 눈금도 따라가야 하므로 주기적으로 최신 발표를 확인한다.
  // 모바일은 화면이 꺼지면 타이머가 멈추므로, 탭 복귀 시에도 즉시 확인한다.
  useEffect(() => {
    const timer = window.setInterval(
      () => setAutoRefreshTick((tick) => tick + 1),
      AUTO_REFRESH_INTERVAL_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setAutoRefreshTick((tick) => tick + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 현재 프레임 렌더링 (누적/KIM 뷰에서는 레이더 렌더를 중단)
  useEffect(() => {
    if (isAccumView || isKimView) {
      return;
    }
    const frameDef = frames[frameIndex];
    if (!frameDef || status !== 'ready') {
      return;
    }

    const token = ++renderTokenRef.current;
    loadFrameData(frameDef)
      .then((buckets) => {
        if (renderTokenRef.current === token) {
          renderFrame({ ...frameDef, buckets });
        }
      })
      .catch(() => {});
  }, [frames, frameIndex, status, renderFrame, loadFrameData, isAccumView, isKimView]);

  useEffect(() => {
    if (!isKimView || kimStatus !== 'ready') return;
    const frameDef = kimFrames[kimIndex];
    if (!frameDef) return;
    const token = ++renderTokenRef.current;
    loadKimFrameData(frameDef)
      .then((values) => {
        if (renderTokenRef.current === token) {
          renderFrame({ ...frameDef, values });
        }
      })
      .catch((error) => {
        setKimStatus('error');
        setKimError(error.message);
      });
  }, [isKimView, kimFrames, kimIndex, kimStatus, loadKimFrameData, renderFrame]);

  // 현재 이후 예측을 먼저 받고, 과거가 된 모델 초반 프레임은 마지막에 채운다.
  useEffect(() => {
    if (!isKimView || kimStatus !== 'ready' || kimFrames.length === 0) return undefined;
    let isCancelled = false;
    const firstFutureIndex = Math.max(
      0,
      kimFrames.findIndex((frame) => frame.validTime?.getTime() >= Date.now()),
    );
    const queue = [
      ...kimFrames.slice(firstFutureIndex),
      ...kimFrames.slice(0, firstFutureIndex),
    ].filter((frame) => !kimCacheRef.current.has(frame.key));
    let cursor = 0;
    const pump = () => {
      if (isCancelled || cursor >= queue.length) return;
      const frame = queue[cursor];
      cursor += 1;
      loadKimFrameData(frame)
        .catch(() => {})
        .finally(() => window.setTimeout(pump, 120));
    };
    pump();
    pump();
    return () => {
      isCancelled = true;
    };
  }, [isKimView, kimFrames, kimStatus, loadKimFrameData]);

  // 슬라이더 이동 시 바로 앞뒤 프레임만 가볍게 미리 받아 과거 6시간 탐색을 부드럽게 한다.
  useEffect(() => {
    if (status !== 'ready' || frames.length === 0) {
      return undefined;
    }

    const nearbyFrames = [];
    for (let offset = 1; offset <= NEARBY_PREFETCH_RADIUS; offset++) {
      [frameIndex - offset, frameIndex + offset].forEach((index) => {
        if (index >= 0 && index < frames.length) {
          nearbyFrames.push(frames[index]);
        }
      });
    }

    const timers = nearbyFrames.map((frameDef, index) =>
      window.setTimeout(() => {
        loadFrameData(frameDef).catch(() => {});
      }, index * 180),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [frames, frameIndex, loadFrameData, status]);

  // 자동 갱신 로직이 최신 상태를 참조할 수 있도록 ref를 동기화한다.
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);
  useEffect(() => {
    frameIndexRef.current = frameIndex;
  }, [frameIndex]);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);
  useEffect(() => {
    playIntervalRef.current = isAccumView
      ? Math.max(60, Math.round((playDurationSec * 1000) / Math.max(1, accumHours.length)))
      : isKimView
        ? kimPlayIntervalMs
      : isBroadcast
        ? playIntervalMs
        : PLAY_INTERVAL_MS;
  }, [accumHours.length, isAccumView, isBroadcast, isKimView, kimPlayIntervalMs, playDurationSec, playIntervalMs]);

  // 방송모드는 선택 지점부터 목표 지점까지를 설정한 재생 길이에 맞춰 진행한다.
  useEffect(() => {
    if (isAccumView || isKimView) {
      return undefined; // 누적/KIM 뷰 재생은 별도 효과에서
    }
    if (!isPlaying || frames.length === 0) {
      return undefined;
    }
    const intervalMs = isBroadcast ? playIntervalMs : PLAY_INTERVAL_MS;
    const timer = window.setInterval(() => {
      setFrameIndex((previous) =>
        isBroadcast ? Math.min(previous + 1, frames.length - 1) : (previous + 1) % frames.length,
      );
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, frames.length, isBroadcast, playIntervalMs, isAccumView, isKimView]);

  // 누적 강수량 뷰: 기간 처음→끝을 재생 길이에 맞춰 진행하고 끝에서 멈춘다.
  useEffect(() => {
    if (!isAccumView || !isPlaying || accumHours.length < 2) {
      return undefined;
    }
    const intervalMs = Math.max(60, Math.round((playDurationSec * 1000) / accumHours.length));
    const timer = window.setInterval(() => {
      setAccumIndex((previous) => Math.min(previous + 1, accumHours.length - 1));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isAccumView, isPlaying, accumHours.length, playDurationSec]);

  useEffect(() => {
    if (isAccumView && isPlaying && accumIndex >= accumHours.length - 1) {
      setIsPlaying(false);
    }
  }, [isAccumView, isPlaying, accumIndex, accumHours.length]);

  useEffect(() => {
    if (!isKimView || !isPlaying || kimFrames.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setKimIndex((previous) => Math.min(previous + 1, kimFrames.length - 1));
    }, kimPlayIntervalMs);
    return () => window.clearInterval(timer);
  }, [isKimView, isPlaying, kimFrames.length, kimPlayIntervalMs]);

  useEffect(() => {
    if (isKimView && isPlaying && kimIndex >= kimFrames.length - 1) {
      setIsPlaying(false);
    }
  }, [isKimView, isPlaying, kimIndex, kimFrames.length]);

  // 방송모드 재생은 목표 지점(현재 또는 예측 끝)에 도달하면 멈춘다.
  useEffect(() => {
    if (!isAccumView && !isKimView && isBroadcast && isPlaying && playTarget !== null && frameIndex >= playTarget) {
      setIsPlaying(false);
    }
  }, [isBroadcast, isPlaying, playTarget, frameIndex, isAccumView, isKimView]);

  // 관측 프레임은 선택 지점→현재, 예측 프레임은 선택 지점→예측 끝으로 재생한다.
  const handlePlayButton = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (isAccumView) {
      if (accumHours.length < 2 || accumStatus !== 'ready') {
        return;
      }
      if (accumIndex >= accumHours.length - 1) {
        setAccumIndex(0);
      }
      setIsPlaying(true);
      return;
    }
    if (isKimView) {
      if (kimFrames.length < 2 || kimStatus !== 'ready') return;
      const startIndex = kimIndex >= kimFrames.length - 1 ? 0 : kimIndex;
      if (startIndex !== kimIndex) setKimIndex(startIndex);
      const transitionCount = Math.max(1, kimFrames.length - 1 - startIndex);
      setKimPlayIntervalMs(Math.max(60, Math.round((playDurationSec * 1000) / transitionCount)));
      setIsPlaying(true);
      return;
    }
    if (!isBroadcast) {
      setIsPlaying(true);
      return;
    }

    const kinds = frames.map((frame) => frame.kind);
    const latestObsIndex = kinds.lastIndexOf('obs');
    if (latestObsIndex < 0) {
      setIsPlaying(true);
      return;
    }

    const currentKind = frames[frameIndex]?.kind;
    let nextTarget = latestObsIndex;
    if (currentKind === 'fct' || frameIndex === latestObsIndex) {
      nextTarget = frames.length - 1;
    }
    if (nextTarget <= frameIndex) {
      return;
    }

    const transitionCount = nextTarget - frameIndex;
    setPlayTarget(nextTarget);
    setPlayIntervalMs(Math.max(45, Math.round((playDurationSec * 1000) / transitionCount)));
    setIsPlaying(true);
  };

  const currentFrame = frames[frameIndex];

  // 타임라인은 프레임 개수가 아니라 시간에 비례한다. 왼쪽은 관측 6시간,
  // 오른쪽은 기상청이 실제 제공한 마지막 예측시각까지만 표시한다.
  const baseTimeMs = useMemo(() => {
    const latestObs = frames.filter((frame) => frame.kind === 'obs').at(-1);
    return latestObs ? latestObs.validTime.getTime() : null;
  }, [frames]);

  const frameOffsets = useMemo(
    () =>
      baseTimeMs === null
        ? []
        : frames.map((frame) => Math.round((frame.validTime.getTime() - baseTimeMs) / 60000)),
    [frames, baseTimeMs],
  );

  const currentOffset = frameOffsets[frameIndex] ?? 0;
  const timelineMinOffset = -OBS_TIMELINE_RANGE_MINUTES;
  const timelineMaxOffset = Math.max(0, frameOffsets.at(-1) ?? 0);
  const timelineSpan = timelineMaxOffset - timelineMinOffset;
  const thumbPercent = ((currentOffset - timelineMinOffset) / timelineSpan) * 100;
  const currentPercent = ((0 - timelineMinOffset) / timelineSpan) * 100;

  const handleTimelineChange = (offsetMinutes) => {
    if (frameOffsets.length === 0) {
      return;
    }
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    frameOffsets.forEach((offset, index) => {
      const distance = Math.abs(offset - offsetMinutes);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    setIsPlaying(false);
    setPlayTarget(null);
    setFrameIndex(nearestIndex);
  };

  const handleRadarRefresh = useCallback(() => {
    setManualRefreshTick((tick) => tick + 1);
  }, []);

  const handleKimRefresh = useCallback(() => {
    setKimRefreshTick((tick) => tick + 1);
  }, []);

  // ---------- 누적 강수량 뷰 ----------
  // 관측소 점 자료를 IDW(역거리가중)로 색면 보간해 오버레이 캔버스에 그린다.
  const buildAccumIdw = useCallback(
    (stations) => {
      const STEP = 2;
      const width = CANVAS_WIDTH;
      const height = canvasHeight;
      const latticeW = Math.ceil(width / STEP);
      const latticeH = Math.ceil(height / STEP);
      const yTop = mercatorY(VIEW_BOUNDS.latMax);
      const yBottom = mercatorY(VIEW_BOUNDS.latMin);

      const stationX = new Float32Array(stations.length);
      const stationY = new Float32Array(stations.length);
      stations.forEach((station, index) => {
        stationX[index] =
          ((station.lon - VIEW_BOUNDS.lonMin) / (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin)) * width;
        stationY[index] = ((yTop - mercatorY(station.lat)) / (yTop - yBottom)) * height;
      });

      // 공간 해시로 근접 지점 탐색을 가속한다.
      const CELL = 32;
      const gridW = Math.ceil(width / CELL);
      const gridH = Math.ceil(height / CELL);
      const buckets = Array.from({ length: gridW * gridH }, () => []);
      stations.forEach((_, index) => {
        const cx = Math.min(gridW - 1, Math.max(0, Math.floor(stationX[index] / CELL)));
        const cy = Math.min(gridH - 1, Math.max(0, Math.floor(stationY[index] / CELL)));
        buckets[cy * gridW + cx].push(index);
      });

      // 육지 마스크: 시도 폴리곤 내부는 넓게 내삽·외삽해 빈틈없이 채우고,
      // 바다(도서 관측점 주변)는 섬 규모(13km)의 점으로만 표출한다.
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = latticeW;
      maskCanvas.height = latticeH;
      const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
      maskContext.fillStyle = '#000';
      const projectPoint = (lon, lat) => [
        (((lon - VIEW_BOUNDS.lonMin) / (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin)) * width) / STEP,
        (((yTop - mercatorY(lat)) / (yTop - yBottom)) * height) / STEP,
      ];
      const fillRing = (ring) => {
        ring.forEach(([lon, lat], index) => {
          const [px, py] = projectPoint(lon, lat);
          if (index === 0) {
            maskContext.moveTo(px, py);
          } else {
            maskContext.lineTo(px, py);
          }
        });
        maskContext.closePath();
      };
      krProvinces.features.forEach(({ geometry }) => {
        maskContext.beginPath();
        if (geometry.type === 'Polygon') {
          geometry.coordinates.forEach(fillRing);
        } else if (geometry.type === 'MultiPolygon') {
          geometry.coordinates.forEach((polygon) => polygon.forEach(fillRing));
        }
        maskContext.fill('evenodd');
      });
      const maskData = maskContext.getImageData(0, 0, latticeW, latticeH).data;

      // 서해안처럼 만·해협이 많은 곳은 바다 노드가 13km 안에 관측소가 없어 공백으로 남았다.
      // 본토에서 가까운 바다는 육지와 같은 넓은 보간을 적용해 육지 값에서 자연스럽게
      // 이어지도록 채운다(강화도·태안반도 주변 공백 해소).
      //
      // 단, 기준을 '모든 육지'로 잡으면 백령도·연평도 같은 외딴 섬 주변 바다까지 먼 육지
      // 관측소를 끌어와 큰 후광(팔레트 단계가 겹쳐 링으로 보임)이 생긴다. 그래서 마스크를
      // 살짝 팽창시켜 연안 섬(강화도·안면도 등)을 본토와 한 덩어리로 묶은 뒤, 일정 크기
      // 이상인 덩어리(본토·제주)만 연안 채움의 기준으로 삼는다. 외딴 섬은 기존처럼
      // 관측점 주변 13km 블롭으로만 표출된다.
      const nodeCount = latticeW * latticeH;
      const landFlag = new Uint8Array(nodeCount);
      for (let i = 0; i < nodeCount; i++) {
        landFlag[i] = maskData[i * 4 + 3] > 0 ? 1 : 0;
      }
      const INF = 1e9;
      const D1 = 1;
      const D2 = Math.SQRT2;
      // 2-pass 체임퍼 거리변환 (격자 단위)
      const chamfer = (seedFlag) => {
        const dist = new Float32Array(nodeCount);
        for (let i = 0; i < nodeCount; i++) dist[i] = seedFlag[i] ? 0 : INF;
        for (let y = 0; y < latticeH; y++) {
          for (let x = 0; x < latticeW; x++) {
            const i = y * latticeW + x;
            let d = dist[i];
            if (y > 0) {
              d = Math.min(d, dist[i - latticeW] + D1);
              if (x > 0) d = Math.min(d, dist[i - latticeW - 1] + D2);
              if (x < latticeW - 1) d = Math.min(d, dist[i - latticeW + 1] + D2);
            }
            if (x > 0) d = Math.min(d, dist[i - 1] + D1);
            dist[i] = d;
          }
        }
        for (let y = latticeH - 1; y >= 0; y--) {
          for (let x = latticeW - 1; x >= 0; x--) {
            const i = y * latticeW + x;
            let d = dist[i];
            if (y < latticeH - 1) {
              d = Math.min(d, dist[i + latticeW] + D1);
              if (x > 0) d = Math.min(d, dist[i + latticeW - 1] + D2);
              if (x < latticeW - 1) d = Math.min(d, dist[i + latticeW + 1] + D2);
            }
            if (x < latticeW - 1) d = Math.min(d, dist[i + 1] + D1);
            dist[i] = d;
          }
        }
        return dist;
      };

      // 연결 요소는 팽창 없이 '실제 육지'에서만 찾는다. 마스크를 팽창시켜 묶으면 서해처럼
      // 섬이 줄지어 있는 곳에서 섬→섬→본토로 사슬처럼 이어져 낙월면 같은 먼 섬무리까지
      // 본토로 취급되고, 그 주변에 연안 띠가 원처럼 둘러져 링으로 보였다.
      const MIN_LAND_COMPONENT = 200; // ≈800km²: 본토·제주만 (강화도 이하 섬은 시드에서 제외)
      const label = new Int32Array(nodeCount).fill(-1);
      const componentSize = [];
      const stack = [];
      for (let start = 0; start < nodeCount; start++) {
        if (label[start] !== -1 || !landFlag[start]) continue;
        const id = componentSize.length;
        let size = 0;
        label[start] = id;
        stack.push(start);
        while (stack.length > 0) {
          const i = stack.pop();
          size++;
          const x = i % latticeW;
          const y = (i - x) / latticeW;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || nx >= latticeW || ny < 0 || ny >= latticeH) continue;
              const n = ny * latticeW + nx;
              if (label[n] !== -1 || !landFlag[n]) continue;
              label[n] = id;
              stack.push(n);
            }
          }
        }
        componentSize.push(size);
      }
      const mainlandFlag = new Uint8Array(nodeCount);
      for (let i = 0; i < nodeCount; i++) {
        const id = label[i];
        mainlandFlag[i] =
          landFlag[i] && id >= 0 && componentSize[id] >= MIN_LAND_COMPONENT ? 1 : 0;
      }
      const coastDist = chamfer(mainlandFlag);

      const NEIGHBORS = 10;
      const CUTOFF_LAND_PX = 100; // 육지는 넓게 보간해 결측 관측소 주변의 빈 영역을 최소화한다.
      const CUTOFF_SEA_PX = 13; // 먼바다: 섬 관측점 주변만
      const FADE_START_PX = 9;
      // 연안 바다(본토 해안에서 ~6km까지)는 육지와 동일하게 꽉 채우고, ~22km까지 길게
      // 옅어진다. 페이드가 짧으면 띠 끝이 선처럼 보이므로 넉넉히 준다. 1 캔버스 px ≈ 1km.
      const COAST_FILL_FULL_PX = 6;
      const COAST_FILL_MAX_PX = 22;
      const neighborIdx = new Int16Array(latticeW * latticeH * NEIGHBORS).fill(-1);
      const neighborW = new Float32Array(latticeW * latticeH * NEIGHBORS);
      const nodeAlpha = new Uint8Array(latticeW * latticeH);

      for (let ly = 0; ly < latticeH; ly++) {
        const py = ly * STEP + STEP / 2;
        for (let lx = 0; lx < latticeW; lx++) {
          const node = ly * latticeW + lx;
          const isLand = landFlag[node] === 1;
          const coastPx = coastDist[node] * STEP; // 격자 단위 → 캔버스 px(≈km)
          const isCoastal = !isLand && coastPx <= COAST_FILL_MAX_PX;
          // 연안 바다도 육지와 같은 넓은 보간 반경을 써서 육지 값이 이어지게 한다.
          const useLandFill = isLand || isCoastal;
          const cutoff = useLandFill ? CUTOFF_LAND_PX : CUTOFF_SEA_PX;
          const px = lx * STEP + STEP / 2;
          const candidates = [];
          const cx = Math.floor(px / CELL);
          const cy = Math.floor(py / CELL);
          const bucketRadius = Math.ceil(cutoff / CELL);
          for (let dy = -bucketRadius; dy <= bucketRadius; dy++) {
            for (let dx = -bucketRadius; dx <= bucketRadius; dx++) {
              const gx = cx + dx;
              const gy = cy + dy;
              if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) {
                continue;
              }
              for (const index of buckets[gy * gridW + gx]) {
                const d2 = (stationX[index] - px) ** 2 + (stationY[index] - py) ** 2;
                if (d2 <= cutoff * cutoff) {
                  candidates.push([d2, index]);
                }
              }
            }
          }
          // 드문 육지·연안 공백은 더 먼 관측소까지 단계적으로 찾아 외삽한다.
          if (useLandFill && candidates.length === 0) {
            for (let radius = bucketRadius + 1; radius <= 7 && candidates.length === 0; radius++) {
              for (let dx = -radius; dx <= radius; dx++) {
                for (const dy of [-radius, radius]) {
                  const gx = cx + dx;
                  const gy = cy + dy;
                  if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) continue;
                  for (const index of buckets[gy * gridW + gx]) {
                    const d2 = (stationX[index] - px) ** 2 + (stationY[index] - py) ** 2;
                    candidates.push([d2, index]);
                  }
                }
              }
              for (let dy = -radius + 1; dy < radius; dy++) {
                for (const dx of [-radius, radius]) {
                  const gx = cx + dx;
                  const gy = cy + dy;
                  if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) continue;
                  for (const index of buckets[gy * gridW + gx]) {
                    const d2 = (stationX[index] - px) ** 2 + (stationY[index] - py) ** 2;
                    candidates.push([d2, index]);
                  }
                }
              }
            }
          }
          if (candidates.length === 0) {
            continue;
          }
          candidates.sort((left, right) => left[0] - right[0]);
          const base = node * NEIGHBORS;
          for (let k = 0; k < Math.min(NEIGHBORS, candidates.length); k++) {
            neighborIdx[base + k] = candidates[k][1];
            neighborW[base + k] = 1 / (candidates[k][0] + 4);
          }
          if (isLand) {
            nodeAlpha[node] = OVERLAY_ALPHA;
          } else {
            // 섬 관측점 주변 페이드(기존)와 해안 거리 기반 페이드 중 진한 쪽을 쓴다.
            const nearest = Math.sqrt(candidates[0][0]);
            const islandFade =
              nearest <= FADE_START_PX
                ? 1
                : Math.max(
                    0,
                    1 - (nearest - FADE_START_PX) / (CUTOFF_SEA_PX - FADE_START_PX),
                  );
            const coastFade = !isCoastal
              ? 0
              : coastPx <= COAST_FILL_FULL_PX
                ? 1
                : Math.max(
                    0,
                    1 - (coastPx - COAST_FILL_FULL_PX) / (COAST_FILL_MAX_PX - COAST_FILL_FULL_PX),
                  );
            nodeAlpha[node] = Math.round(OVERLAY_ALPHA * Math.max(islandFade, coastFade));
          }
        }
      }

      return {
        latticeW,
        latticeH,
        NEIGHBORS,
        neighborIdx,
        neighborW,
        nodeAlpha,
        landFlag,
        mainlandFlag,
        coastDist,
        STEP,
        coastFillMaxPx: COAST_FILL_MAX_PX,
      };
    },
    [canvasHeight],
  );

  const renderAccumFrame = useCallback(
    (hourIndex) => {
      const canvas = overlayCanvasRef.current;
      const idw = accumIdwRef.current;
      const stations = accumStationsRef.current;
      const hour = accumHours[hourIndex];
      if (!canvas || !idw || !stations || !hour) {
        return;
      }
      // KMA 시간통계에서 0시(tm=…0000)의 RN_DAY는 '전날 하루 전체 누적'이므로
      // 자정 프레임은 완결된 날들의 합계(base)만 쓴다. 기간 시작 0시는 전부 0.
      const anchorHours = accumAnchorHoursRef.current;
      if (anchorHours.length === 0) {
        return;
      }

      const periodStart = accumHours[0];
      const targetMs = hour.getTime();
      let previousAnchor = anchorHours[0];
      let nextAnchor = anchorHours.at(-1);
      for (const anchor of anchorHours) {
        if (anchor.getTime() <= targetMs) {
          previousAnchor = anchor;
        }
        if (anchor.getTime() >= targetMs) {
          nextAnchor = anchor;
          break;
        }
      }

      const totalAtAnchor = (stationId, anchor) => {
        const dayIndex = Math.round(
          (new Date(anchor).setHours(0, 0, 0, 0) -
            new Date(periodStart).setHours(0, 0, 0, 0)) /
            86400000,
        );
        const base = accumBasesRef.current[dayIndex] ?? null;
        if (anchor.getHours() === 0) {
          return base ? (base.get(stationId) ?? 0) : 0;
        }
        const hourly = accumHourlyCacheRef.current.get(formatAccumHourTm(anchor));
        const hourlyValue = hourly?.get(stationId);
        return hourlyValue === undefined
          ? undefined
          : hourlyValue + (base ? (base.get(stationId) ?? 0) : 0);
      };

      const previousMs = previousAnchor.getTime();
      const nextMs = nextAnchor.getTime();
      const blend = nextMs === previousMs ? 0 : (targetMs - previousMs) / (nextMs - previousMs);

      const values = new Float32Array(stations.length).fill(-1);
      stations.forEach((station, index) => {
        const previousValue = totalAtAnchor(station.id, previousAnchor);
        const nextValue = totalAtAnchor(station.id, nextAnchor);
        if (previousValue === undefined && nextValue === undefined) {
          return;
        }
        if (previousValue === undefined) {
          values[index] = nextValue;
        } else if (nextValue === undefined) {
          values[index] = previousValue;
        } else {
          values[index] = previousValue + (nextValue - previousValue) * blend;
        }
      });

      if (import.meta.env.DEV) {
        window.__accumValues = { values, stations };
      }

      const {
        latticeW,
        latticeH,
        NEIGHBORS,
        neighborIdx,
        neighborW,
        nodeAlpha,
        coastDist,
        STEP: latticeStep,
        coastFillMaxPx,
      } = idw;
      // 본토 육지와 그 연안 띠 안쪽인가 — 3D에서 이 범위는 항상 면으로 이어 그린다.
      const isOnMainSurface = (node) => coastDist[node] * latticeStep <= coastFillMaxPx;
      const interpolateNodeValue = (node) => {
        const baseIndex = node * NEIGHBORS;
        let weightSum = 0;
        let valueSum = 0;
        for (let k = 0; k < NEIGHBORS; k++) {
          const stationIndex = neighborIdx[baseIndex + k];
          if (stationIndex < 0) {
            break;
          }
          const value = values[stationIndex];
          if (value < 0) {
            continue;
          }
          weightSum += neighborW[baseIndex + k];
          valueSum += neighborW[baseIndex + k] * value;
        }
        return weightSum > 0 ? valueSum / weightSum : -1;
      };

      const extrusionSource = mapRef.current?.getSource(ACCUM_EXTRUSION_SOURCE_ID);
      if (accumDisplayMode === '3d') {
        const features = [];
        const yTop = mercatorY(VIEW_BOUNDS.latMax);
        const yBottom = mercatorY(VIEW_BOUNDS.latMin);
        const halfCell = ACCUM_EXTRUSION_STRIDE * 0.505;
        const lonAt = (x) =>
          VIEW_BOUNDS.lonMin +
          (Math.min(latticeW, Math.max(0, x)) / latticeW) *
            (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin);
        const latAt = (y) =>
          inverseMercatorY(
            yTop +
              (Math.min(latticeH, Math.max(0, y)) / latticeH) * (yBottom - yTop),
          );
        const islandStations = stations.flatMap((station, index) => {
          if (!isSinglePillarIslandStation(station)) {
            return [];
          }
          return [
            {
              index,
              x:
                ((station.lon - VIEW_BOUNDS.lonMin) /
                  (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin)) *
                latticeW,
              y: ((yTop - mercatorY(station.lat)) / (yTop - yBottom)) * latticeH,
            },
          ];
        });
        const islandSuppressionRadius = 9;
        const isNearSinglePillarIsland = (x, y) =>
          islandStations.some(
            (station) =>
              (station.x - x) ** 2 + (station.y - y) ** 2 <= islandSuppressionRadius ** 2,
          );
        const pushExtrusion = (
          value,
          x,
          y,
          cellHalfSize = halfCell,
          heightScale = 1,
        ) => {
          if (accumBucket(value) <= 0) {
            return;
          }
          const west = lonAt(x - cellHalfSize);
          const east = lonAt(x + cellHalfSize);
          const north = latAt(y - cellHalfSize);
          const south = latAt(y + cellHalfSize);
          features.push({
            type: 'Feature',
            properties: {
              value: Math.round(value * 10) / 10,
              height:
                Math.min(130000, Math.max(1800, Math.pow(value, 0.68) * 2600)) *
                heightScale,
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [west, north],
                  [east, north],
                  [east, south],
                  [west, south],
                  [west, north],
                ],
              ],
            },
          });
        };

        const sampleOffset = Math.floor(ACCUM_EXTRUSION_STRIDE / 2);
        const sampleWidth = Math.ceil((latticeW - sampleOffset) / ACCUM_EXTRUSION_STRIDE);
        const sampleHeight = Math.ceil((latticeH - sampleOffset) / ACCUM_EXTRUSION_STRIDE);
        const rawGrid = new Float32Array(sampleWidth * sampleHeight).fill(-1);
        const validGrid = new Uint8Array(sampleWidth * sampleHeight);

        for (let gridY = 0; gridY < sampleHeight; gridY++) {
          const ly = sampleOffset + gridY * ACCUM_EXTRUSION_STRIDE;
          if (ly >= latticeH) continue;
          for (let gridX = 0; gridX < sampleWidth; gridX++) {
            const lx = sampleOffset + gridX * ACCUM_EXTRUSION_STRIDE;
            if (lx >= latticeW) continue;
            const node = ly * latticeW + lx;
            if (nodeAlpha[node] === 0) continue;
            // 섬 억제는 먼바다에서만. 본토·연안 띠까지 파내면 서해안처럼 섬이 많은 곳에서
            // 강화군·영종·단원구·충남 해안에 구멍이 뚫리고, 그 원이 도메인 경계와 만나
            // 반원처럼 보였다. 육지 값이 바다까지 이어지도록 이 범위는 면을 유지한다.
            if (!isOnMainSurface(node) && isNearSinglePillarIsland(lx, ly)) continue;
            const gridIndex = gridY * sampleWidth + gridX;
            validGrid[gridIndex] = 1;
            rawGrid[gridIndex] = interpolateNodeValue(node);
          }
        }

        const displayGrid = ACCUM_3D_SPATIAL_SMOOTHING
          ? smoothMaskedAccumGrid(
              rawGrid,
              sampleWidth,
              sampleHeight,
              ACCUM_3D_SMOOTHING_PASSES,
            )
          : rawGrid;

        const renderedGrid = new Float32Array(rawGrid.length).fill(-1);
        for (let index = 0; index < rawGrid.length; index++) {
          const rawValue = rawGrid[index];
          if (rawValue < 0) continue;
          renderedGrid[index] = ACCUM_3D_SPATIAL_SMOOTHING
            ? rawValue * (1 - ACCUM_3D_SMOOTHING_BLEND) +
              displayGrid[index] * ACCUM_3D_SMOOTHING_BLEND
            : rawValue;
        }

        if (accum3dStyle === 'surface') {
          accumSurfaceLayerRef.current?.setGrid({
            width: sampleWidth,
            height: sampleHeight,
            values: renderedGrid,
            valid: validGrid,
            sampleOffset,
            stride: ACCUM_EXTRUSION_STRIDE,
            latticeWidth: latticeW,
            latticeHeight: latticeH,
            bounds: VIEW_BOUNDS,
          });
        } else {
          accumSurfaceLayerRef.current?.clear();
          for (let gridY = 0; gridY < sampleHeight; gridY++) {
            const ly = sampleOffset + gridY * ACCUM_EXTRUSION_STRIDE;
            for (let gridX = 0; gridX < sampleWidth; gridX++) {
              const lx = sampleOffset + gridX * ACCUM_EXTRUSION_STRIDE;
              const value = renderedGrid[gridY * sampleWidth + gridX];
              if (value < 0) continue;
              pushExtrusion(value, lx, ly);
            }
          }
        }
        // 작은 섬은 표면 메쉬에서 제외하고 기존 단일 관측 기둥으로 정확한 위치를 표시한다.
        islandStations.forEach(({ index, x, y }) => {
          pushExtrusion(
            values[index],
            x,
            y,
            halfCell * 1.35 * ISLAND_PILLAR_WIDTH_SCALE,
            ISLAND_PILLAR_HEIGHT_SCALE,
          );
        });
        extrusionSource?.setData({ type: 'FeatureCollection', features });
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);
        refreshOverlaySource();
        return;
      }

      accumSurfaceLayerRef.current?.clear();
      extrusionSource?.setData({ type: 'FeatureCollection', features: [] });
      if (!accumCanvasRef.current) {
        accumCanvasRef.current = document.createElement('canvas');
        accumCanvasRef.current.width = latticeW;
        accumCanvasRef.current.height = latticeH;
      }
      const latticeCanvas = accumCanvasRef.current;
      const latticeContext = latticeCanvas.getContext('2d');
      const image = latticeContext.createImageData(latticeW, latticeH);
      const pixels = image.data;

      for (let node = 0; node < latticeW * latticeH; node++) {
        const value = interpolateNodeValue(node);
        if (value < 0) {
          continue;
        }
        const bucket = accumBucket(value);
        if (bucket <= 0) {
          continue; // 무강수는 투명
        }
        const [r, g, b] = ACCUM_PALETTE[bucket - 1].color;
        const offset = node * 4;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = nodeAlpha[node];
      }

      latticeContext.putImageData(image, 0, 0);

      const context = canvas.getContext('2d');
      const fromCanvas = transitionFromCanvasRef.current;
      const toCanvas = transitionToCanvasRef.current;
      if (!fromCanvas || !toCanvas) {
        return;
      }
      const toContext = toCanvas.getContext('2d');
      toContext.clearRect(0, 0, toCanvas.width, toCanvas.height);
      toContext.imageSmoothingEnabled = true;
      toContext.imageSmoothingQuality = 'high';
      toContext.drawImage(latticeCanvas, 0, 0, toCanvas.width, toCanvas.height);

      if (transitionAnimationRef.current !== null) {
        cancelAnimationFrame(transitionAnimationRef.current);
        transitionAnimationRef.current = null;
      }
      if (!isPlayingRef.current || !hasRenderedFrameRef.current) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(toCanvas, 0, 0);
        hasRenderedFrameRef.current = true;
        refreshOverlaySource();
        return;
      }

      const fromContext = fromCanvas.getContext('2d');
      fromContext.clearRect(0, 0, fromCanvas.width, fromCanvas.height);
      fromContext.drawImage(canvas, 0, 0);
      const durationMs = Math.min(140, Math.max(45, playIntervalRef.current * 0.82));
      const source = mapRef.current?.getSource('radar-overlay');
      source?.play();
      const startedAt = performance.now();
      const dissolve = (timestamp) => {
        const progress = Math.min(1, (timestamp - startedAt) / durationMs);
        const eased = progress * progress * (3 - 2 * progress);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.globalAlpha = 1 - eased;
        context.drawImage(fromCanvas, 0, 0);
        context.globalAlpha = eased;
        context.drawImage(toCanvas, 0, 0);
        context.globalAlpha = 1;
        mapRef.current?.triggerRepaint();

        if (progress < 1) {
          transitionAnimationRef.current = requestAnimationFrame(dissolve);
          return;
        }
        transitionAnimationRef.current = null;
        source?.pause();
        mapRef.current?.triggerRepaint();
      };
      transitionAnimationRef.current = requestAnimationFrame(dissolve);
    },
    [accum3dStyle, accumDisplayMode, accumHours, refreshOverlaySource],
  );

  // 누적 뷰 진입/일수 변경 시 시간축과 자료를 구성한다.
  useEffect(() => {
    if (!isAccumView) {
      return undefined;
    }
    let isActive = true;
    setIsPlaying(false);
    setAccumStatus('loading');
    setAccumError('');

    (async () => {
      try {
        if (!accumStationsRef.current) {
          accumStationsRef.current = await fetchAwsStationCoords();
        }
        if (!accumIdwRef.current) {
          accumIdwRef.current = buildAccumIdw(accumStationsRef.current);
          if (import.meta.env.DEV) {
            window.__accumIdw = accumIdwRef.current;
            window.__accumStations = accumStationsRef.current;
          }
        }
        if (!isActive) {
          return;
        }

        // 최신 발표 정시 탐색 (직전 정시부터 최대 3시간 소급)
        const now = new Date();
        now.setMinutes(0, 0, 0);
        let latest = null;
        for (let step = 0; step < 3 && !latest; step++) {
          const candidate = new Date(now.getTime() - step * 3600000);
          try {
            const data = await fetchHourlyRnDay(candidate);
            latest = { date: candidate, data };
          } catch {
            // 다음 후보
          }
        }
        if (!latest) {
          throw new Error('AWS 시간통계 자료를 찾지 못했습니다.');
        }
        if (!isActive) {
          return;
        }
        accumHourlyCacheRef.current.set(formatAccumHourTm(latest.date), latest.data);

        const start = new Date(latest.date);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - (accumDays - 1));

        // 완결된 과거 일들의 일합계 → 일 인덱스별 누적 베이스
        const bases = [new Map()];
        for (let dayOffset = 0; dayOffset < accumDays - 1; dayOffset++) {
          const day = new Date(start.getTime() + dayOffset * 86400000);
          const daily = await fetchDailyRnTotal(day);
          if (!isActive) {
            return;
          }
          const previous = bases[dayOffset];
          const next = new Map(previous);
          daily.forEach((value, stationId) => {
            next.set(stationId, (previous.get(stationId) ?? 0) + value);
          });
          bases.push(next);
        }
        accumBasesRef.current = bases;

        const hours = [];
        for (let t = start.getTime(); t <= latest.date.getTime(); t += 3600000) {
          hours.push(new Date(t));
        }
        if (hours.at(-1)?.getTime() !== latest.date.getTime()) {
          hours.push(new Date(latest.date));
        }

        const spanHours = Math.max(0, (latest.date.getTime() - start.getTime()) / 3600000);
        const frameStepHours = Math.max(
          1,
          Math.ceil(spanHours / (MAX_ACCUM_API_FRAMES - 1)),
        );
        const frameStepMs = frameStepHours * 3600000;
        const anchorHours = [];
        for (let t = start.getTime(); t <= latest.date.getTime(); t += frameStepMs) {
          anchorHours.push(new Date(t));
        }
        if (anchorHours.at(-1)?.getTime() !== latest.date.getTime()) {
          anchorHours.push(new Date(latest.date));
        }
        accumAnchorHoursRef.current = anchorHours;
        setAccumHours(hours);
        setAccumIndex(hours.length - 1);
        setAccumStatus('ready');

        // 기간 전체(최신 시각 기준) 최다 강수 5개 지점.
        // 최신 시각이 자정이면 RN_DAY가 전날 누적이므로 일합계 베이스만 쓴다.
        const latestBase = bases[accumDays - 1] ?? new Map();
        const latestIsMidnight = latest.date.getHours() === 0;
        const ranked = [];
        accumStationsRef.current.forEach((station) => {
          const hourValue = latest.data.get(station.id);
          if (!latestIsMidnight && hourValue === undefined) {
            return;
          }
          const total = (latestIsMidnight ? 0 : hourValue) + (latestBase.get(station.id) ?? 0);
          if (total >= 0.1) {
            ranked.push({ station, total });
          }
        });
        ranked.sort((left, right) => right.total - left.total);
        setAccumTop5(
          selectAccumTopStations(ranked).map(({ station, total }) => ({
            id: station.id,
            label: formatStationLabel(station),
            mm: Math.round(total * 10) / 10,
          })),
        );

        // API-backed anchor frames remain capped; displayed hours are interpolated.
        let cursor = 0;
        const pump = () => {
          if (!isActive || cursor >= anchorHours.length) {
            return;
          }
          const hour = anchorHours[cursor];
          cursor += 1;
          const tm = formatAccumHourTm(hour);
          // 자정 프레임은 시간통계를 쓰지 않으므로 프리페치도 건너뛴다.
          if (hour.getHours() === 0 || accumHourlyCacheRef.current.has(tm)) {
            window.setTimeout(pump, 0);
            return;
          }
          loadAccumAnchor(hour)
            .catch(() => {})
            .finally(() => {
              if (isActive) {
                window.setTimeout(pump, 120);
              }
            });
        };
        pump();
        pump();
      } catch (error) {
        if (isActive) {
          setAccumStatus('error');
          setAccumError(error.message);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [isAccumView, accumDays, buildAccumIdw, loadAccumAnchor]);

  // 누적 뷰 현재 프레임 렌더링 (자료 미도착 시 도착 후 렌더)
  useEffect(() => {
    if (!isAccumView || accumStatus !== 'ready') {
      return;
    }
    const hour = accumHours[accumIndex];
    if (!hour) {
      return;
    }
    const token = ++accumRenderTokenRef.current;
    const anchors = accumAnchorHoursRef.current;
    const targetMs = hour.getTime();
    let previousAnchor = anchors[0];
    let nextAnchor = anchors.at(-1);
    for (const anchor of anchors) {
      if (anchor.getTime() <= targetMs) {
        previousAnchor = anchor;
      }
      if (anchor.getTime() >= targetMs) {
        nextAnchor = anchor;
        break;
      }
    }
    const requiredAnchors = [previousAnchor, nextAnchor].filter(
      (anchor, index, list) =>
        anchor &&
        anchor.getHours() !== 0 &&
        list.findIndex((candidate) => candidate?.getTime() === anchor.getTime()) === index &&
        !accumHourlyCacheRef.current.has(formatAccumHourTm(anchor)),
    );
    if (requiredAnchors.length === 0) {
      renderAccumFrame(accumIndex);
      return;
    }
    Promise.all(
      requiredAnchors.map((anchor) => loadAccumAnchor(anchor)),
    )
      .then(() => {
        if (accumRenderTokenRef.current === token) {
          renderAccumFrame(accumIndex);
        }
      })
      .catch(() => {});
  }, [isAccumView, accumStatus, accumHours, accumIndex, loadAccumAnchor, renderAccumFrame]);

  // 뷰 전환 시 오버레이를 비워 이전 그림이 남지 않게 한다.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) {
      return;
    }
    if (transitionAnimationRef.current !== null) {
      cancelAnimationFrame(transitionAnimationRef.current);
      transitionAnimationRef.current = null;
    }
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    hasRenderedFrameRef.current = false;
    refreshOverlaySource();
    setIsPlaying(false);
  }, [isAccumView, refreshOverlaySource]);

  // 입체 누적 모드는 전용 기둥 레이어를 켜고 방송 화면에 맞는 각도로 자동 기울인다.
  useEffect(() => {
    const show3d = isAccumView && accumDisplayMode === '3d';
    const showSurface = show3d && accum3dStyle === 'surface';
    const applyMode = () => {
      const map = mapRef.current;
      if (!map) {
        return;
      }
      accumSurfaceLayerRef.current?.setVisible(showSurface);
      if (map.getLayer(ACCUM_EXTRUSION_LAYER_ID)) {
        map.setLayoutProperty(
          ACCUM_EXTRUSION_LAYER_ID,
          'visibility',
          show3d ? 'visible' : 'none',
        );
      }
      if (map.getLayer('radar-overlay')) {
        map.setLayoutProperty('radar-overlay', 'visibility', show3d ? 'none' : 'visible');
      }

      if (show3d && !accumWas3dRef.current) {
        accumPreviousPitchRef.current = map.getPitch();
        map.easeTo({ pitch: ACCUM_3D_DEFAULT_PITCH, bearing: 0, duration: 800 });
      } else if (!show3d && accumWas3dRef.current) {
        map.easeTo({ pitch: accumPreviousPitchRef.current, bearing: 0, duration: 650 });
      }
      accumWas3dRef.current = show3d;
    };

    applyMode();
    const timer = window.setTimeout(applyMode, 350);
    return () => window.clearTimeout(timer);
  }, [accum3dStyle, accumDisplayMode, isAccumView]);

  const currentAccumHour = accumHours[accumIndex] ?? null;
  const accumThumbPercent =
    accumHours.length > 1 ? (accumIndex / (accumHours.length - 1)) * 100 : 50;

  const accumTicks = useMemo(() => {
    if (accumHours.length < 2) {
      return [];
    }
    const span = accumHours.length - 1;
    const tickEvery = accumHours.length <= 30 ? 3 : 6;
    const labelEvery = accumHours.length <= 30 ? 6 : accumHours.length <= 80 ? 12 : 24;
    return accumHours
      .map((hour, index) => ({ hour, index }))
      .filter(({ hour }) => hour.getHours() % tickEvery === 0)
      .map(({ hour, index }) => {
        const isLabeled = hour.getHours() % labelEvery === 0;
        let label = '';
        if (isLabeled) {
          label =
            hour.getHours() === 0
              ? `${hour.getMonth() + 1}/${hour.getDate()}`
              : `${hour.getHours()}시`;
        }
        return { key: index, position: (index / span) * 100, isLabeled, label, dateLabel: '' };
      });
  }, [accumHours]);

  const timelineTicks = useMemo(() => {
    if (baseTimeMs === null) {
      return [];
    }
    let previousLabeledDate = null;
    const offsets = [];
    for (
      let offsetMinutes = -OBS_TIMELINE_RANGE_MINUTES;
      offsetMinutes <= timelineMaxOffset;
      offsetMinutes += 60
    ) {
      offsets.push(offsetMinutes);
    }
    return offsets.map((offsetMinutes) => {
      const position = ((offsetMinutes - timelineMinOffset) / timelineSpan) * 100;
      const isLabeled = offsetMinutes % 120 === 0;
      let label = '';
      let dateLabel = '';
      if (isLabeled) {
        const tickTime = new Date(baseTimeMs + offsetMinutes * 60 * 1000);
        label = offsetMinutes === 0 ? '현재' : formatHourMinute(tickTime);
        // 날짜가 바뀌는 첫 눈금에는 날짜를 함께 표시한다.
        const tickDate = `${tickTime.getMonth() + 1}.${tickTime.getDate()}`;
        if (previousLabeledDate !== null && tickDate !== previousLabeledDate) {
          dateLabel = tickDate;
        }
        previousLabeledDate = tickDate;
      }
      return { offsetMinutes, position, isLabeled, label, dateLabel };
    });
  }, [baseTimeMs, timelineMaxOffset, timelineMinOffset, timelineSpan]);

  const currentKimFrame = kimFrames[kimIndex] ?? null;
  const kimThumbPercent = kimFrames.length > 1 ? (kimIndex / (kimFrames.length - 1)) * 100 : 50;
  const kimTicks = useMemo(() => {
    if (kimFrames.length < 2) return [];
    const span = kimFrames.length - 1;
    return kimFrames
      .map((frame, index) => ({ frame, index }))
      .map(({ frame, index }) => {
        const hour = frame.validTime.getHours();
        const isEndpoint = index === 0 || index === span;
        const isLabeled = isEndpoint || hour === 0 || hour === 12;
        const dateLabel =
          isLabeled && (index === 0 || hour === 0)
            ? `${frame.validTime.getMonth() + 1}.${frame.validTime.getDate()}`
            : '';
        return {
          key: frame.key,
          position: (index / span) * 100,
          isLabeled,
          label: isLabeled ? formatHourMinute(frame.validTime) : '',
          dateLabel,
          offsetMinutes: frame.leadHour * 60,
        };
      });
  }, [kimFrames]);

  const toggleFullscreen = useCallback(async () => {
    if (fullscreenMode) {
      if (fullscreenMode === 'native' && document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      setFullscreenMode(null);
      return;
    }

    const element = sectionRef.current;
    try {
      if (!element?.requestFullscreen) {
        throw new Error('unsupported');
      }
      await element.requestFullscreen();
      setFullscreenMode('native');
    } catch {
      setFullscreenMode('css');
    }
  }, [fullscreenMode]);

  // Esc 등으로 네이티브 전체화면이 해제되면 상태를 따라간다.
  useEffect(() => {
    const handleChange = () => {
      if (!document.fullscreenElement) {
        setFullscreenMode((mode) => (mode === 'native' ? null : mode));
      }
    };
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  // 모바일 전체화면은 컨테이너 변경 후 남한 전체 경계를 다시 맞춰 위아래 구도를 채운다.
  useEffect(() => {
    if (isBroadcast) {
      return undefined;
    }
    const timers = [120, 500].map((delay) =>
      window.setTimeout(() => {
        const map = mapRef.current;
        if (!map) {
          return;
        }

        map.resize();
        if (!window.matchMedia('(max-width: 767px)').matches) {
          return;
        }

        map.fitBounds(KOREA_MAP_BOUNDS, { padding: isFullscreen ? 0 : 12, duration: 0 });
      }, delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isFullscreen, isBroadcast]);

  // 두 모드 모두 같은 줌 단계별 행정경계·지명을 사용한다. 무거운 읍면동 자료만 확대 시 불러온다.
  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    const applyVisibility = () => {
      map.setMaxZoom(16);
      setBroadcastAdminVisibility(map, true);
      if (map.getZoom() >= 9.4) {
        ensureBroadcastEmdLayers(map);
      }
    };

    const handleAdminZoom = () => {
      if (map.getZoom() >= 9.4) {
        ensureBroadcastEmdLayers(map);
      }
    };
    map.on('zoomend', handleAdminZoom);

    if (map.isStyleLoaded()) {
      applyVisibility();
      return () => map.off('zoomend', handleAdminZoom);
    }
    map.once('load', applyVisibility);
    return () => {
      map.off('load', applyVisibility);
      map.off('zoomend', handleAdminZoom);
    };
  }, [isBroadcast]);

  // 최종 전체화면 크기에서 지도를 맞춘 뒤 첫 렌더가 끝나면 전환 화면을 공개한다.
  useEffect(() => {
    if (!isBroadcast || !isFullscreen || isBroadcastMapReady) {
      return undefined;
    }
    const map = mapRef.current;
    const container = mapContainerRef.current;
    if (!map || !container) {
      return undefined;
    }

    let firstFrame = 0;
    let secondFrame = 0;
    let fallbackTimer = 0;
    let revealPending = false;
    let finished = false;
    const reveal = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallbackTimer);
      setIsBroadcastMapReady(true);
    };
    const alignMap = () => {
      if (finished) return;
      map.resize();
      fitBroadcastFlatView(map);
      if (!revealPending) {
        revealPending = true;
        map.once('render', reveal);
        fallbackTimer = window.setTimeout(reveal, 250);
      }
      map.triggerRepaint();
    };
    const scheduleAlignment = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(alignMap);
      });
    };
    const resizeObserver = new ResizeObserver(scheduleAlignment);
    resizeObserver.observe(container);
    scheduleAlignment();

    return () => {
      finished = true;
      resizeObserver.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(fallbackTimer);
      map.off('render', reveal);
    };
  }, [isBroadcast, isBroadcastMapReady, isFullscreen]);

  const enterBroadcastMode = useCallback(() => {
    setIsBroadcastMapReady(false);
    setIsBroadcast(true);
    if (!fullscreenMode) {
      toggleFullscreen();
    }
  }, [fullscreenMode, toggleFullscreen]);

  const exitBroadcastMode = useCallback(() => {
    setIsBroadcast(false);
    setIsPlaying(false);
    setPlayTarget(null);
    setBroadcastView('radar');
    if (fullscreenMode) {
      toggleFullscreen();
    }
  }, [fullscreenMode, toggleFullscreen]);

  // Esc 등으로 전체화면이 풀리면 방송모드도 함께 종료한다.
  useEffect(() => {
    if (!isFullscreen) {
      setIsBroadcast(false);
      setBroadcastView('radar');
    }
  }, [isFullscreen]);

  // CSS 대체 전체화면에서도 Esc 키로 방송모드를 빠져나올 수 있게 한다.
  useEffect(() => {
    if (!isBroadcast) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        exitBroadcastMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBroadcast, exitBroadcastMode]);

  // 방송모드에서는 +/− 줌 버튼을 숨긴다(터치스크린 두 손가락 줌 사용).
  useEffect(() => {
    const map = mapRef.current;
    const navControl = navControlRef.current;
    if (!map || !navControl) {
      return;
    }
    if (isBroadcast && navControlAddedRef.current) {
      map.removeControl(navControl);
      navControlAddedRef.current = false;
    } else if (!isBroadcast && !navControlAddedRef.current) {
      map.addControl(navControl, 'top-right');
      navControlAddedRef.current = true;
    }
  }, [isBroadcast]);

  // 방송모드 지도 배색 전환. 일반 화면에서 이미 생성된 지도에도 전환 완료까지 재적용한다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return undefined;
    }
    const theme = isBroadcast ? MAP_COLOR_THEMES.broadcast : MAP_COLOR_THEMES.default;
    const applyTheme = () => applyMapColorTheme(map, theme);
    let isListening = false;
    const stopStyleRetry = () => {
      if (!isListening) return;
      map.off('load', retryUntilReady);
      map.off('styledata', retryUntilReady);
      isListening = false;
    };
    const retryUntilReady = () => {
      if (applyTheme()) stopStyleRetry();
    };

    if (!applyTheme()) {
      isListening = true;
      map.on('load', retryUntilReady);
      map.on('styledata', retryUntilReady);
    }
    const timers = [80, 300, 800, 1500].map((delay) =>
      window.setTimeout(applyTheme, delay),
    );
    return () => {
      stopStyleRetry();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [isBroadcast]);

  // 방송모드에서는 끊김 없는 재생을 위해 전 구간 프레임을 미리 받아 둔다.
  useEffect(() => {
    if (!isBroadcast || broadcastView !== 'radar' || status !== 'ready') {
      return undefined;
    }
    cacheLimitRef.current = BROADCAST_CACHE_LIMIT;
    let isCancelled = false;
    const queue = frames.filter((frame) => !frameCacheRef.current.has(frame.key));
    let cursor = 0;
    const pump = () => {
      if (isCancelled || cursor >= queue.length) {
        return;
      }
      const frameDef = queue[cursor];
      cursor += 1;
      loadFrameData(frameDef)
        .catch(() => {})
        .finally(() => {
          window.setTimeout(pump, 150);
        });
    };
    pump();
    pump();
    return () => {
      isCancelled = true;
      cacheLimitRef.current = FRAME_CACHE_LIMIT;
    };
  }, [broadcastView, isBroadcast, status, frames, loadFrameData]);

  // 컨트롤바(재생 버튼 + 슬라이더 + 눈금). 방송모드에서는 어두운 배경 위에 얹는다.
  const renderTimeline = (broadcast) => (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handlePlayButton}
        disabled={isAccumView ? accumStatus !== 'ready' : isKimView ? kimStatus !== 'ready' : status !== 'ready'}
        className={`flex shrink-0 items-center justify-center rounded-full bg-[#0033a0] text-white shadow-sm transition hover:bg-blue-800 disabled:opacity-40 ${
          broadcast ? 'h-12 w-12 -translate-x-1/2' : 'h-10 w-10'
        }`}
        aria-label={isPlaying ? '일시정지' : '재생'}
      >
        {isPlaying ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
            <rect x="3" y="2" width="3.5" height="12" rx="1" />
            <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d="M4.5 2.7a1 1 0 0 1 1.53-.85l8 5.3a1 1 0 0 1 0 1.7l-8 5.3a1 1 0 0 1-1.53-.85V2.7Z" />
          </svg>
        )}
      </button>
      <div className="relative min-w-0 flex-1 pt-8">
        {isAccumView && currentAccumHour ? (
          <div
            className="pointer-events-none absolute top-0"
            style={{ left: `${Math.min(Math.max(accumThumbPercent, 6), 94)}%` }}
          >
            <span className="inline-block -translate-x-1/2 whitespace-nowrap rounded-full bg-slate-600 px-2.5 py-1 text-[11px] font-bold tabular-nums text-white shadow-sm">
              {currentAccumHour.getMonth() + 1}/{currentAccumHour.getDate()}{' '}
              {String(currentAccumHour.getHours()).padStart(2, '0')}:00
            </span>
          </div>
        ) : null}
        {isKimView && currentKimFrame ? (
          <div
            className="pointer-events-none absolute top-0"
            style={{ left: `${Math.min(Math.max(kimThumbPercent, 6), 94)}%` }}
          >
            <span className="inline-block -translate-x-1/2 whitespace-nowrap rounded-full bg-emerald-600 px-2.5 py-1 text-[11px] font-bold tabular-nums text-white shadow-sm">
              예상 {currentKimFrame.validTime.getMonth() + 1}/{currentKimFrame.validTime.getDate()}{' '}
              {formatHourMinute(currentKimFrame.validTime)}
            </span>
          </div>
        ) : null}
        {!isAccumView && !isKimView && currentFrame ? (
          <div
            className="pointer-events-none absolute top-0"
            style={{ left: `${Math.min(Math.max(thumbPercent, 6), 94)}%` }}
          >
            <span
              className={`inline-block -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums text-white shadow-sm ${
                currentFrame.kind === 'obs' ? 'bg-slate-600' : 'bg-blue-600'
              }`}
            >
              {currentFrame.kind === 'obs' ? '관측' : '예측'}{' '}
              {formatHourMinute(currentFrame.validTime)}
            </span>
          </div>
        ) : null}
        <input
          type="range"
          min={isAccumView || isKimView ? 0 : timelineMinOffset}
          max={
            isAccumView
              ? Math.max(accumHours.length - 1, 1)
              : isKimView
                ? Math.max(kimFrames.length - 1, 1)
                : timelineMaxOffset
          }
          step={isAccumView || isKimView ? 1 : 5}
          value={isAccumView ? accumIndex : isKimView ? kimIndex : currentOffset}
          onChange={(event) => {
            if (isAccumView) {
              setIsPlaying(false);
              setAccumIndex(Number(event.target.value));
            } else if (isKimView) {
              setIsPlaying(false);
              setKimIndex(Number(event.target.value));
            } else {
              handleTimelineChange(Number(event.target.value));
            }
          }}
          disabled={isAccumView ? accumStatus !== 'ready' : isKimView ? kimStatus !== 'ready' : status !== 'ready'}
          className={`relative z-10 w-full cursor-pointer appearance-none rounded-full accent-[#0033a0] ${
            broadcast ? 'broadcast-radar-range h-2.5' : 'h-2'
          }`}
          style={{
            background: isAccumView || isKimView
              ? '#3b71b8'
              : `linear-gradient(to right, #64748b ${currentPercent}%, #2563eb ${currentPercent}%)`,
          }}
        />
        <div className="relative mt-1 h-9">
          {(isAccumView ? accumTicks : isKimView ? kimTicks : timelineTicks).map(
            ({ offsetMinutes, key, position, isLabeled, label, dateLabel }) => (
            <div
              key={isAccumView || isKimView ? key : offsetMinutes}
              className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${position}%` }}
            >
              <div
                className={`w-px ${
                  isLabeled
                    ? `h-2 ${broadcast ? 'bg-white/60' : 'bg-slate-400'}`
                    : `h-1.5 ${broadcast ? 'bg-white/35' : 'bg-slate-300'}`
                }`}
              />
              {isLabeled ? (
                <div
                  className={`mt-0.5 whitespace-nowrap text-center text-[10px] font-medium tabular-nums ${
                    offsetMinutes === 0
                      ? `font-bold ${broadcast ? 'text-white' : 'text-slate-700'}`
                      : broadcast
                        ? 'text-white/75'
                        : 'text-slate-400'
                  }`}
                >
                  {label}
                  {dateLabel ? (
                    <div
                      className={`text-[9px] font-semibold ${broadcast ? 'text-white/70' : 'text-slate-500'}`}
                    >
                      {dateLabel}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // 방송모드 뷰 전환 — 지도 화면과 위성 화면 양쪽에서 쓴다.
  const broadcastViewPills = (
    <div className="flex rounded-xl border border-cyan-100/45 bg-slate-950/85 p-1 shadow-xl backdrop-blur-md">
      {[
        { id: 'radar', label: '레이더' },
        { id: 'kim', label: '강수 예상' },
        { id: 'accum', label: '강수량' },
        { id: 'satellite', label: '위성' },
      ].map(({ id, label }) => {
        const isActive = broadcastView === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              if (!isActive) {
                setIsPlaying(false);
                setBroadcastView(id);
              }
            }}
            className={`h-10 rounded-lg px-4 text-sm font-black tracking-tight transition ${
              isActive
                ? id === 'accum'
                  ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-950/30'
                  : id === 'kim'
                    ? 'bg-emerald-400 text-slate-950 shadow-md shadow-emerald-950/30'
                  : id === 'satellite'
                    ? 'bg-violet-400 text-slate-950 shadow-md shadow-violet-950/30'
                    : 'bg-cyan-400 text-slate-950 shadow-md shadow-cyan-950/30'
                : 'text-white/75 hover:bg-white/10 hover:text-white'
            }`}
            aria-pressed={isActive}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <section
      ref={sectionRef}
      className={`overflow-hidden bg-white ${
        isFullscreen
          ? `flex h-full flex-col ${fullscreenMode === 'css' ? 'fixed inset-0 z-[100]' : ''}`
          : 'rounded-3xl border border-slate-200 shadow-sm'
      }`}
    >
      {!isBroadcast ? (
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 text-lg font-bold tracking-tight text-slate-900">
              레이더 · 초단기예측
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={enterBroadcastMode}
                className="hidden shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-100 md:inline-flex"
                aria-label="방송모드"
              >
                <MonitorPlay size={16} />
                방송모드
              </button>
              <button
                type="button"
                onClick={toggleFullscreen}
                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-100"
                aria-label={isFullscreen ? '전체화면 종료' : '전체화면'}
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                <span className="hidden sm:inline">{isFullscreen ? '전체화면 종료' : '전체화면'}</span>
              </button>
            </div>
          </div>
          <div className={`mt-1 text-sm text-slate-500 ${isFullscreen ? 'hidden sm:block' : ''}`}>
            기상청 레이더 강수 실황(5분 간격, 과거 6시간)과 초단기 예측강수(10분 간격, 미래 6시간)입니다.
          </div>
        </div>
      ) : null}

      <div
        className={`relative ${isFullscreen ? 'min-h-0 flex-1' : ''} ${
          isBroadcast ? 'bg-[#46536a]' : ''
        }`}
      >
        <div
          ref={mapContainerRef}
          className={`${
            isFullscreen
              ? 'h-full w-full'
              : // 모바일에서는 카드 전체(헤더+지도+컨트롤바)가 한 화면에 들어오도록
                // 지도 높이를 화면 높이에서 나머지 UI 높이를 뺀 값으로 잡는다.
                'h-[calc(100dvh-31rem)] min-h-[280px] w-full sm:h-[60vh] sm:min-h-[420px]'
          } ${isBroadcast && !isBroadcastMapReady ? 'opacity-0' : 'opacity-100'}`}
          style={{ backgroundColor: isBroadcast ? MAP_COLOR_THEMES.broadcast.sea : undefined }}
        />
        {!isAccumView && !isKimView && !isSatelliteView && status === 'loading' && frames.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium text-slate-500">
            레이더 자료를 불러오는 중입니다…
          </div>
        ) : null}
        {!isAccumView && !isKimView && !isSatelliteView && status === 'error' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 px-6 text-center text-sm font-medium text-red-500">
            {statusMessage || '레이더 자료를 불러오지 못했습니다.'}
          </div>
        ) : null}
        {isAccumView && accumStatus === 'loading' ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/35 text-sm font-semibold text-white backdrop-blur-[1px]">
            누적 강수량 자료를 불러오는 중입니다…
          </div>
        ) : null}
        {isAccumView && accumStatus === 'error' ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/45 px-6 text-center text-sm font-semibold text-red-200">
            {accumError || '누적 강수량 자료를 불러오지 못했습니다.'}
          </div>
        ) : null}
        {isKimView && kimStatus === 'loading' ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/35 text-sm font-semibold text-white backdrop-blur-[1px]">
            KIM 국지모델 강수 예상도를 불러오는 중입니다…
          </div>
        ) : null}
        {isKimView && kimStatus === 'error' ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/45 px-6 text-center text-sm font-semibold text-red-200">
            {kimError || 'KIM 강수 예상도를 불러오지 못했습니다.'}
          </div>
        ) : null}

        {/* 위성 뷰: 자체 화면(fixed)이 지도를 덮고, 뷰 전환 버튼은 슬롯으로 넘겨 그대로 쓴다 */}
        {isSatelliteView ? <SatelliteView menuSlot={broadcastViewPills} /> : null}

        {isBroadcast && !isSatelliteView ? (
          <>
            {/* 좌상단: 타이틀 밴드(참고 그래픽과 동일 위치·비율) + 현재 프레임 날짜·시각 */}
            <div
              className="pointer-events-none absolute z-20 flex items-center gap-[1vw]"
              style={{ left: '4.4%', top: '14%' }}
            >
              <div
                className="relative flex items-center overflow-hidden rounded-md bg-gradient-to-r from-[#0a3070]/95 via-[#155bb5]/95 to-[#2f7cd6]/95 shadow-2xl"
                style={{
                  width: 'clamp(430px, 29vw, 700px)',
                  height: 'clamp(58px, 7.4vh, 96px)',
                  paddingLeft: '1.3vw',
                  paddingRight: '1.2vw',
                  gap: '1.1vw',
                }}
              >
                <div className="relative flex flex-col leading-none text-white">
                  <span
                    className="font-black tracking-[0.18em]"
                    style={{ fontSize: 'clamp(13px, 1vw, 22px)' }}
                  >
                    KBS
                  </span>
                  <span
                    className="mt-[0.2em] font-bold tracking-[0.1em] text-white/80"
                    style={{ fontSize: 'clamp(9px, 0.72vw, 16px)' }}
                  >
                    WEATHER
                  </span>
                  <svg
                    viewBox="0 0 12 12"
                    className="absolute -right-3 -top-1 h-[0.7vw] min-h-2 w-[0.7vw] min-w-2 fill-[#f4c542]"
                    aria-hidden="true"
                  >
                    <path d="M6 0l1.2 4.8L12 6l-4.8 1.2L6 12 4.8 7.2 0 6l4.8-1.2L6 0Z" />
                  </svg>
                </div>
                <span
                  className="whitespace-nowrap font-black tracking-tight text-white"
                  style={{
                    fontSize: 'clamp(26px, 2.1vw, 46px)',
                    textShadow: '0 2px 6px rgba(0,0,0,0.35)',
                  }}
                >
                  {isAccumView ? '누적 강수량' : isKimView ? '강수 예상도' : '레이더 영상'}
                </span>
                {(isAccumView ? currentAccumHour : isKimView ? currentKimFrame : currentFrame) ? (
                  <div
                    className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap"
                    style={{ gap: '0.6vw' }}
                  >
                    <span className="h-[52%] w-px bg-white/30" style={{ marginRight: '0.5vw' }} />
                    <span
                      className="font-black leading-none tabular-nums text-white"
                      style={{
                        fontSize: 'clamp(22px, 1.7vw, 38px)',
                        textShadow: '0 2px 5px rgba(0,0,0,0.3)',
                      }}
                    >
                      {formatHourMinute(
                        isAccumView
                          ? currentAccumHour
                          : isKimView
                            ? currentKimFrame.validTime
                            : currentFrame.validTime,
                      )}
                    </span>
                    <span
                      className="font-semibold text-[#bdd6fb]"
                      style={{ fontSize: 'clamp(13px, 0.95vw, 20px)' }}
                    >
                      {formatBroadcastDate(
                        isAccumView
                          ? currentAccumHour
                          : isKimView
                            ? currentKimFrame.validTime
                            : currentFrame.validTime,
                      )}
                    </span>
                    {isKimView ? (
                      <span
                        className="rounded bg-emerald-300 px-1.5 py-0.5 text-xs font-black text-emerald-950"
                        title={`KIM ${kimMeta?.sourceGridKm ?? 1} km · ${kimMeta?.baseTime ?? ''} 기준`}
                      >
                        KIM {kimMeta?.sourceGridKm ?? 1}km
                      </span>
                    ) : !isAccumView && currentFrame?.kind === 'fct' ? (
                      <span className="rounded bg-[#f4c542] px-1.5 py-0.5 text-xs font-black text-[#102a43]">
                        예측
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-[#3d86e8] to-[#8ec2ff]" />
              </div>
            </div>

            {/* 누적 강수량: 기간 최다 강수 5개 지점 */}
            {isAccumView && accumTop5.length > 0 ? (
              <div
                className="pointer-events-none absolute z-20 flex justify-center"
                style={{
                  left: '4.4%',
                  top: 'calc(50% - max(23vh, 140px) - 18.5px)',
                  width: 'clamp(430px, 29vw, 700px)',
                }}
              >
                <div
                  className="overflow-hidden rounded-md bg-slate-900/60 shadow-xl backdrop-blur-sm"
                  style={{ width: 'clamp(320px, 22vw, 500px)' }}
                >
                  <div className="divide-y divide-white/10">
                    {accumTop5.map((row, index) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-2.5 px-5 py-[0.9vh]"
                        style={{ fontSize: 'clamp(16px, 1.25vw, 26px)' }}
                      >
                        <span className="w-[1.2em] shrink-0 font-black text-[#f4c542]">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-semibold text-white">
                          {row.label}
                        </span>
                        <span className="shrink-0 font-black tabular-nums text-white">
                          {row.mm.toFixed(1)}
                          <span className="ml-0.5 font-semibold text-white/70">mm</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {/* 좌측 세로 스케일: 레이더(mm/h) 또는 누적 강수량(mm) */}
            <div
              className="pointer-events-none absolute left-5 z-20 rounded-lg bg-slate-900/50 px-2 py-2.5 shadow-lg backdrop-blur-sm"
              style={{ top: 'calc(50% - max(23vh, 140px) - 18.5px)' }}
            >
              {isAccumView ? (
                <>
                  <div className="flex h-[46vh] min-h-[280px]">
                    <div className="flex w-2.5 flex-col-reverse overflow-hidden rounded-sm">
                      {ACCUM_PALETTE.map(({ min, color }) => (
                        <div
                          key={min}
                          className="w-full flex-1"
                          style={{ backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }}
                        />
                      ))}
                    </div>
                    <div className="relative ml-1.5 w-7">
                      <span
                        className="absolute translate-y-1/2 text-[10px] font-semibold leading-none text-white/80"
                        style={{ bottom: '0%' }}
                      >
                        0
                      </span>
                      {ACCUM_MAJOR_BREAKS.map((value) => {
                        const index = ACCUM_PALETTE.findIndex((item) => item.min === value);
                        return (
                          <span
                            key={value}
                            className="absolute translate-y-1/2 text-[10px] font-bold leading-none text-white"
                            style={{ bottom: `${(index / ACCUM_PALETTE.length) * 100}%` }}
                          >
                            {value}
                          </span>
                        );
                      })}
                      <span
                        className="absolute translate-y-1/2 text-[10px] font-semibold leading-none text-white/80"
                        style={{ bottom: '100%' }}
                      >
                        {ACCUM_SCALE_TOP}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 text-center text-[9px] font-semibold text-white/80">mm</div>
                </>
              ) : (
                <>
                  <div className="flex h-[46vh] min-h-[280px]">
                    <div className="flex w-2.5 flex-col-reverse overflow-hidden rounded-sm">
                      {LEGEND_SEGMENTS.map((segment) => (
                        <div key={segment.key} className="flex flex-1 flex-col-reverse">
                          {segment.values.map((value) => {
                            const color = getPaletteColorByValue(value);
                            return (
                              <div
                                key={value}
                                className="w-full flex-1"
                                style={{ backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    <div className="relative ml-1.5 w-6">
                      {[
                        [0, 0],
                        [1, 1],
                        [5, 2],
                        [10, 3],
                        [30, 4],
                        [70, 5],
                        [150, 6],
                      ].map(([value, boundary]) => (
                        <span
                          key={value}
                          className="absolute translate-y-1/2 text-[10px] font-semibold leading-none text-white"
                          style={{ bottom: `${(boundary / 6) * 100}%` }}
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="mt-1.5 text-center text-[9px] font-semibold text-white/80">
                    mm/h
                  </div>
                </>
              )}
            </div>

            {/* 하단 반투명 컨트롤바 */}
            <div className="absolute bottom-0 left-1/2 right-0 z-10 bg-gradient-to-t from-slate-900/65 via-slate-900/35 to-transparent pb-4 pl-0 pr-6 pt-10">
              {renderTimeline(true)}
            </div>

            <div className="absolute bottom-[8.5rem] right-6 z-20 flex flex-col items-end gap-2.5">
              {broadcastViewPills}
              <div className="flex items-center gap-2">
                {isAccumView ? (
                  <>
                    <select
                      value={accumDays}
                      onChange={(event) => {
                        setIsPlaying(false);
                        setAccumDays(Number(event.target.value));
                      }}
                      className="h-10 cursor-pointer rounded-full border border-white/25 bg-slate-900/55 px-3 text-sm font-semibold text-white outline-none backdrop-blur-sm"
                      aria-label="누적 일수"
                    >
                      {[1, 2, 3, 4, 5].map((days) => (
                        <option key={days} value={days} className="text-slate-900">
                          {days}일
                        </option>
                      ))}
                    </select>
                    <div className="flex h-10 items-center rounded-full border border-white/25 bg-slate-900/65 p-1 shadow-lg backdrop-blur-sm">
                      {[
                        { id: 'flat', label: '평면' },
                        { id: '3d', label: '입체' },
                      ].map(({ id, label }) => {
                        const isActive = accumDisplayMode === id;
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              if (!isActive) {
                                setIsPlaying(false);
                                setAccumDisplayMode(id);
                              }
                            }}
                            className={`h-8 rounded-full px-3 text-xs font-black transition ${
                              isActive
                                ? id === '3d'
                                  ? 'bg-amber-400 text-slate-950 shadow-sm'
                                  : 'bg-white text-slate-900 shadow-sm'
                                : 'text-white/65 hover:text-white'
                            }`}
                            aria-pressed={isActive}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {accumDisplayMode === '3d' ? (
                      <div className="flex h-10 items-center rounded-full border border-amber-300/35 bg-slate-900/65 p-1 shadow-lg backdrop-blur-sm">
                        {[
                          { id: 'columns', label: '기둥형' },
                          { id: 'surface', label: '곡면형' },
                        ].map(({ id, label }) => {
                          const isActive = accum3dStyle === id;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                if (!isActive) {
                                  setIsPlaying(false);
                                  setAccum3dStyle(id);
                                }
                              }}
                              className={`h-8 rounded-full px-3 text-xs font-black transition ${
                                isActive
                                  ? 'bg-cyan-300 text-slate-950 shadow-sm'
                                  : 'text-white/65 hover:text-white'
                              }`}
                              aria-pressed={isActive}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </>
                ) : null}
                <select
                  value={playDurationSec}
                  onChange={(event) => setPlayDurationSec(Number(event.target.value))}
                  className="h-10 cursor-pointer rounded-full border border-white/25 bg-slate-900/55 px-3 text-sm font-semibold text-white outline-none backdrop-blur-sm"
                  aria-label="재생 길이"
                >
                  {BROADCAST_PLAY_DURATIONS.map((seconds) => (
                    <option key={seconds} value={seconds} className="text-slate-900">
                      {seconds}초
                    </option>
                  ))}
                </select>
                {!isAccumView ? (
                  <button
                    type="button"
                    onClick={isKimView ? handleKimRefresh : handleRadarRefresh}
                    disabled={isKimView ? kimStatus === 'loading' : status === 'loading'}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-slate-900/55 text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-900/75 disabled:cursor-wait disabled:opacity-60"
                    aria-label={isKimView ? '강수 예상도 새로고침' : '레이더 영상 새로고침'}
                    title={isKimView ? '강수 예상도 새로고침' : '레이더 영상 새로고침'}
                  >
                    <RefreshCw
                      size={18}
                      className={(isKimView ? kimStatus : status) === 'loading' ? 'animate-spin' : ''}
                    />
                  </button>
                ) : null}
              </div>
            </div>

          </>
        ) : null}
      </div>

      {!isBroadcast ? (
        <div className="space-y-3 border-t border-slate-200 px-5 py-4 sm:px-6">
          {renderTimeline(false)}
          <div className="pb-3">
            <RadarLegend />
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default RadarMapView;
