import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import krProvinces from '../data/map/krProvinces.json';
import interKoreanSeam from '../data/map/interKoreanSeam.json';
import neighborCoasts from '../data/map/neighborCoasts.json';
import { formatStationLabel } from '../api/accumApi';
import {
  fetchHeatwaveBroadcastData,
  fetchTemperatureChangeData,
} from '../api/heatwaveApi';
import VideoExportMenu from './VideoExportMenu';
import WeatherWorkspaceMenu from './WeatherWorkspaceMenu.jsx';
import {
  getWorkspaceModeFromLocation,
  updateWorkspaceModeInUrl,
} from '../utils/weatherWorkspaceMode.js';

const VIEW_BOUNDS = { lonMin: 120.18, lonMax: 133.56, latMin: 30.1, latMax: 43.34 };
const GRID_WIDTH = 576;
const GRID_HEIGHT = 715;
const GRID_NEIGHBORS = 6;
const GRID_BUCKET_SIZE = 16;
const COLUMN_STRIDE = 2;
const TIMELINE_COLUMN_STRIDE = COLUMN_STRIDE;
const OVERLAY_ALPHA = 218;
const TROPICAL_EXTRUSION_THRESHOLD = 25;
const HEAT_EXTRUSION_THRESHOLD = 33;
const TEMPERATURE_SOURCE_ID = 'heat-temperature-columns';
const TEMPERATURE_LAYER_ID = 'heat-temperature-columns-layer';
const TIMELINE_OVERLAY_SOURCE_ID = 'heat-temperature-overlay-next';
const TIMELINE_OVERLAY_LAYER_ID = 'heat-temperature-overlay-next-layer';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TIMELINE_RENDER_INTERVAL_MS = 40;
const TIMELINE_PLAY_DURATIONS = [6, 8, 10, 12, 15, 20];

const formatKstDateInput = (nowMs = Date.now()) => {
  const date = new Date(nowMs + KST_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

const formatShortDate = (value) => {
  const [, month = '', day = ''] = value.split('-');
  return `${Number(month)}/${Number(day)}`;
};

const formatKstDateTimeInput = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

const buildDefaultTimelineRange = (nowMs = Date.now()) => {
  const now = new Date(nowMs + KST_OFFSET_MS - 3 * 60 * 1000);
  now.setUTCMinutes(Math.floor(now.getUTCMinutes() / 30) * 30, 0, 0);
  const start = new Date(now);
  start.setUTCHours(7, 0, 0, 0);
  if (start >= now) start.setTime(now.getTime() - 30 * 60 * 1000);
  return {
    start: formatKstDateTimeInput(start),
    end: formatKstDateTimeInput(now),
  };
};

const formatTimelineClock = (timestamp = '') =>
  timestamp.length >= 12 ? `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}` : '';

const getInitialTemperatureMode = () => {
  const requested = new URLSearchParams(window.location.search).get('temperatureMode');
  return requested === 'change' ? 'change' : 'tropical';
};

const shiftDateInput = (value, dayOffset) => {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const pad = (part) => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
};

const ADMIN_SOURCE_DEFINITIONS = {
  'heat-sido': '/data/map/kr-sido-20260701.geojson',
  'heat-sgg': '/data/map/kr-sgg-20260701.geojson',
  'heat-emd': '/data/map/kr-emd-20260701.geojson',
  'heat-sido-labels': '/data/map/kr-sido-labels-20260701.geojson',
  'heat-sgg-labels': '/data/map/kr-sgg-labels-20260701.geojson',
  'heat-emd-labels': '/data/map/kr-emd-labels-20260701.geojson',
};
const HEAT_PLACE_LABEL_LAYER_IDS = [
  'heat-sido-label',
  'heat-sgg-label',
  'heat-emd-label',
];

const TROPICAL_PALETTE = [
  { value: 18, color: [62, 108, 196] },
  { value: 22, color: [75, 183, 219] },
  { value: 24.9, color: [114, 205, 159] },
  { value: 25, color: [250, 204, 57] },
  { value: 27, color: [241, 122, 45] },
  { value: 30, color: [187, 47, 91] },
  { value: 33, color: [92, 35, 126] },
];

const HEAT_PALETTE = [
  { value: 15, color: [68, 111, 191] },
  { value: 24, color: [73, 183, 214] },
  { value: 30, color: [244, 207, 63] },
  { value: 33, color: [243, 139, 44] },
  { value: 35, color: [218, 54, 48] },
  { value: 40, color: [128, 42, 138] },
  { value: 43, color: [64, 24, 93] },
];

const TIMELINE_PALETTE = [
  { value: 20, color: [55, 105, 196] },
  { value: 25, color: [69, 190, 205] },
  { value: 30, color: [245, 207, 58] },
  { value: 35, color: [239, 105, 43] },
  { value: 40, color: [198, 39, 72] },
  { value: 45, color: [73, 25, 103] },
];

const MAP_STYLE = {
  version: 8,
  sources: {
    provinces: { type: 'geojson', data: krProvinces },
    neighbors: { type: 'geojson', data: neighborCoasts },
    interKoreanSeam: { type: 'geojson', data: interKoreanSeam },
  },
  layers: [
    { id: 'sea', type: 'background', paint: { 'background-color': '#46536a' } },
    {
      id: 'neighbor-land',
      type: 'fill',
      source: 'neighbors',
      paint: { 'fill-color': '#828c9c' },
    },
    {
      id: 'inter-korean-seam',
      type: 'fill',
      source: 'interKoreanSeam',
      paint: { 'fill-color': '#828c9c', 'fill-opacity': 1 },
    },
    {
      id: 'neighbor-coast',
      type: 'line',
      source: 'neighbors',
      paint: { 'line-color': '#5d6879', 'line-width': 0.8 },
    },
    {
      id: 'land',
      type: 'fill',
      source: 'provinces',
      paint: { 'fill-color': '#eef0f2' },
    },
    {
      id: 'province-border',
      type: 'line',
      source: 'provinces',
      paint: { 'line-color': '#4a5568', 'line-width': 1 },
    },
  ],
};

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
  '광주광역시',
  '광주',
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

const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const inverseMercatorY = (value) =>
  ((2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180) / Math.PI;
const yTop = mercatorY(VIEW_BOUNDS.latMax);
const yBottom = mercatorY(VIEW_BOUNDS.latMin);

const projectGridPoint = (lon, lat) => ({
  x: ((lon - VIEW_BOUNDS.lonMin) / (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin)) * GRID_WIDTH,
  y: ((yTop - mercatorY(lat)) / (yTop - yBottom)) * GRID_HEIGHT,
});
const gridLon = (x) =>
  VIEW_BOUNDS.lonMin + (x / GRID_WIDTH) * (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin);
const gridLat = (y) => inverseMercatorY(yTop + (y / GRID_HEIGHT) * (yBottom - yTop));

const drawPolygonPath = (context, coordinates) => {
  coordinates.forEach((ring) => {
    ring.forEach(([lon, lat], index) => {
      const point = projectGridPoint(lon, lat);
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
  });
};

const buildLandMask = () => {
  const canvas = document.createElement('canvas');
  canvas.width = GRID_WIDTH;
  canvas.height = GRID_HEIGHT;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.beginPath();
  krProvinces.features.forEach((feature) => {
    if (feature.geometry.type === 'Polygon') {
      drawPolygonPath(context, feature.geometry.coordinates);
    } else if (feature.geometry.type === 'MultiPolygon') {
      feature.geometry.coordinates.forEach((polygon) => drawPolygonPath(context, polygon));
    }
  });
  context.fill('evenodd');
  const pixels = context.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT).data;
  return Uint8Array.from(
    { length: GRID_WIDTH * GRID_HEIGHT },
    (_, index) => (pixels[index * 4 + 3] > 0 ? 1 : 0),
  );
};

const smoothMaskedGrid = (source, valid, passes = 2) => {
  const kernel = [1, 4, 6, 4, 1];
  let current = source;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(source.length).fill(-1);
    const output = new Float32Array(source.length).fill(-1);
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        const index = y * GRID_WIDTH + x;
        if (!valid[index]) continue;
        let total = 0;
        let weights = 0;
        for (let offset = -2; offset <= 2; offset += 1) {
          const sampleX = x + offset;
          if (sampleX < 0 || sampleX >= GRID_WIDTH) continue;
          const sampleIndex = y * GRID_WIDTH + sampleX;
          if (!valid[sampleIndex]) continue;
          const weight = kernel[offset + 2];
          total += current[sampleIndex] * weight;
          weights += weight;
        }
        horizontal[index] = weights ? total / weights : current[index];
      }
    }
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        const index = y * GRID_WIDTH + x;
        if (!valid[index]) continue;
        let total = 0;
        let weights = 0;
        for (let offset = -2; offset <= 2; offset += 1) {
          const sampleY = y + offset;
          if (sampleY < 0 || sampleY >= GRID_HEIGHT) continue;
          const sampleIndex = sampleY * GRID_WIDTH + x;
          if (!valid[sampleIndex]) continue;
          const weight = kernel[offset + 2];
          total += horizontal[sampleIndex] * weight;
          weights += weight;
        }
        output[index] = weights ? total / weights : horizontal[index];
      }
    }
    current = output;
  }
  return current;
};

const buildTemperatureGrid = (observations, landMask) => {
  const projectedStations = observations
    .filter(
      (station) =>
        Number.isFinite(station.lon) &&
        Number.isFinite(station.lat) &&
        Number.isFinite(station.value),
    )
    .map((station) => ({
      ...projectGridPoint(station.lon, station.lat),
      value: station.value,
    }))
    .filter(
      (station) =>
        station.x >= 0 &&
        station.x < GRID_WIDTH &&
        station.y >= 0 &&
        station.y < GRID_HEIGHT,
    );
  const bucketColumns = Math.ceil(GRID_WIDTH / GRID_BUCKET_SIZE);
  const bucketRows = Math.ceil(GRID_HEIGHT / GRID_BUCKET_SIZE);
  const buckets = Array.from(
    { length: bucketColumns * bucketRows },
    () => [],
  );
  projectedStations.forEach((station) => {
    const bucketX = Math.min(
      bucketColumns - 1,
      Math.floor(station.x / GRID_BUCKET_SIZE),
    );
    const bucketY = Math.min(
      bucketRows - 1,
      Math.floor(station.y / GRID_BUCKET_SIZE),
    );
    buckets[bucketY * bucketColumns + bucketX].push(station);
  });
  const maxBucketRing = Math.max(bucketColumns, bucketRows);
  const values = new Float32Array(GRID_WIDTH * GRID_HEIGHT).fill(-1);
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const node = y * GRID_WIDTH + x;
      if (!landMask[node]) continue;
      const nearest = [];
      const centerBucketX = Math.floor(x / GRID_BUCKET_SIZE);
      const centerBucketY = Math.floor(y / GRID_BUCKET_SIZE);
      let stopAfterRing = null;
      for (let ring = 0; ring <= maxBucketRing; ring += 1) {
        for (let offsetY = -ring; offsetY <= ring; offsetY += 1) {
          for (let offsetX = -ring; offsetX <= ring; offsetX += 1) {
            if (
              ring > 0 &&
              Math.abs(offsetX) !== ring &&
              Math.abs(offsetY) !== ring
            ) {
              continue;
            }
            const bucketX = centerBucketX + offsetX;
            const bucketY = centerBucketY + offsetY;
            if (
              bucketX < 0 ||
              bucketX >= bucketColumns ||
              bucketY < 0 ||
              bucketY >= bucketRows
            ) {
              continue;
            }
            buckets[bucketY * bucketColumns + bucketX].forEach((station) => {
              const distance = (station.x - x) ** 2 + (station.y - y) ** 2;
              let insertAt = nearest.findIndex(
                (candidate) => distance < candidate.distance,
              );
              if (insertAt < 0) insertAt = nearest.length;
              if (insertAt < GRID_NEIGHBORS) {
                nearest.splice(insertAt, 0, { distance, value: station.value });
                if (nearest.length > GRID_NEIGHBORS) nearest.pop();
              }
            });
          }
        }
        if (nearest.length >= GRID_NEIGHBORS && stopAfterRing === null) {
          stopAfterRing = ring + 1;
        }
        if (stopAfterRing !== null && ring >= stopAfterRing) break;
      }
      let weightedValue = 0;
      let weightSum = 0;
      nearest.forEach(({ distance, value }) => {
        const weight = 1 / (distance + 0.3);
        weightedValue += value * weight;
        weightSum += weight;
      });
      if (weightSum > 0) values[node] = weightedValue / weightSum;
    }
  }
  return smoothMaskedGrid(values, landMask, 2);
};

const interpolatePaletteColor = (value, palette) => {
  if (value <= palette[0].value) return palette[0].color;
  for (let index = 1; index < palette.length; index += 1) {
    const previous = palette[index - 1];
    const next = palette[index];
    if (value > next.value) continue;
    const blend = (value - previous.value) / (next.value - previous.value);
    return previous.color.map((channel, channelIndex) =>
      Math.round(channel + (next.color[channelIndex] - channel) * blend),
    );
  }
  return palette.at(-1).color;
};

const temperatureHeight = (value, mode) => {
  if (mode === 'change') {
    const bounded = Math.min(45, Math.max(20, value));
    // 온도가 높을수록 막대 증가폭이 커지는 볼록(가속) 곡선.
    // 30도 이하는 완만하게 낮고, 30도 이상에서 급격히 상승한다.
    // 기준점: 20도 → 4500, 45도 → 161000(폭염 지도 최대 높이와 동일).
    // 이차식이라 증가폭(1차 미분)이 온도에 비례해 계속 커진다.
    const t = bounded - 20; // 0~25
    return 4500 + 250.4 * t * t;
  }
  const baseHeight = mode === 'tropical'
    ? Math.min(105000, 3500 + Math.max(0, value - 25) * 14500)
    : Math.min(115000, 1800 + Math.max(0, value - 33) * 16000);
  return baseHeight * (mode === 'tropical' ? 2 : 1.4);
};

const drawTemperatureGrid = (canvas, grid, palette) => {
  const context = canvas.getContext('2d');
  const image = context.createImageData(GRID_WIDTH, GRID_HEIGHT);
  for (let index = 0; index < grid.length; index += 1) {
    const value = grid[index];
    if (value === -1 || value < -40) continue;
    const color = interpolatePaletteColor(value, palette);
    const offset = index * 4;
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = OVERLAY_ALPHA;
  }
  context.putImageData(image, 0, 0);
};

const buildTimelineExtrusionFeatures = (fromGrid, toGrid) => {
  const features = [];
  const halfCell = TIMELINE_COLUMN_STRIDE * 0.505;
  for (
    let y = Math.floor(TIMELINE_COLUMN_STRIDE / 2);
    y < GRID_HEIGHT;
    y += TIMELINE_COLUMN_STRIDE
  ) {
    for (
      let x = Math.floor(TIMELINE_COLUMN_STRIDE / 2);
      x < GRID_WIDTH;
      x += TIMELINE_COLUMN_STRIDE
    ) {
      const index = y * GRID_WIDTH + x;
      const fromValue = fromGrid[index];
      const toValue = toGrid[index];
      const fromMissing = fromValue === -1 || fromValue < -40;
      const toMissing = toValue === -1 || toValue < -40;
      if (fromMissing && toMissing) continue;
      const safeFromValue = fromMissing ? toValue : fromValue;
      const safeToValue = toMissing ? safeFromValue : toValue;
      const fromColor = interpolatePaletteColor(safeFromValue, TIMELINE_PALETTE);
      const toColor = interpolatePaletteColor(safeToValue, TIMELINE_PALETTE);
      features.push({
        type: 'Feature',
        properties: {
          fromHeight: temperatureHeight(safeFromValue, 'change'),
          toHeight: temperatureHeight(safeToValue, 'change'),
          fromColor: `rgb(${fromColor.join(',')})`,
          toColor: `rgb(${toColor.join(',')})`,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [gridLon(x - halfCell), gridLat(y - halfCell)],
              [gridLon(x + halfCell), gridLat(y - halfCell)],
              [gridLon(x + halfCell), gridLat(y + halfCell)],
              [gridLon(x - halfCell), gridLat(y + halfCell)],
              [gridLon(x - halfCell), gridLat(y - halfCell)],
            ],
          ],
        },
      });
    }
  }
  return features;
};

const ensureAdminLayers = (map) => {
  Object.entries(ADMIN_SOURCE_DEFINITIONS).forEach(([id, data]) => {
    map.addSource(id, { type: 'geojson', data });
  });
  map.addSource('heat-dokdo', { type: 'geojson', data: DOKDO_GEOJSON });
  [
    {
      id: 'heat-sido-border',
      type: 'line',
      source: 'heat-sido',
      paint: { 'line-color': '#364152', 'line-width': ['interpolate', ['linear'], ['zoom'], 4.5, 1.2, 8, 2] },
    },
    {
      id: 'heat-sgg-border',
      type: 'line',
      source: 'heat-sgg',
      minzoom: 6.8,
      paint: { 'line-color': '#6b7280', 'line-width': ['interpolate', ['linear'], ['zoom'], 6.8, 0.45, 10, 1] },
    },
    {
      id: 'heat-emd-border',
      type: 'line',
      source: 'heat-emd',
      minzoom: 9.55,
      paint: { 'line-color': '#9ca3af', 'line-width': 0.55 },
    },
    {
      id: 'heat-sido-label',
      type: 'symbol',
      source: 'heat-sido-labels',
      maxzoom: 7,
      layout: {
        'text-field': SIDO_SHORT_NAME,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4.5, 12, 7, 17],
        'text-font': ['Open Sans Bold'],
        'text-padding': 4,
      },
      paint: { 'text-color': '#263244', 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.5 },
    },
    {
      id: 'heat-sgg-label',
      type: 'symbol',
      source: 'heat-sgg-labels',
      minzoom: 6.9,
      maxzoom: 10,
      layout: {
        'text-field': ['get', 'sggnm'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6.9, 9, 9.5, 14],
        'text-font': ['Open Sans Semibold'],
        'text-padding': 2,
      },
      paint: { 'text-color': '#2f3b4d', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.25 },
    },
    {
      id: 'heat-emd-label',
      type: 'symbol',
      source: 'heat-emd-labels',
      minzoom: 9.8,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9.8, 9, 12, 13],
        'text-font': ['Open Sans Regular'],
        'text-padding': 1,
      },
      paint: { 'text-color': '#3b4657', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.1 },
    },
    {
      id: 'heat-dokdo-dot',
      type: 'circle',
      source: 'heat-dokdo',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 1.1, 8, 1.5, 12, 2],
        'circle-color': '#f8fafc',
        'circle-stroke-color': '#263244',
        'circle-stroke-width': 0.6,
      },
    },
  ].forEach((layer) => map.addLayer(layer));
};

const setHeatPlaceLabelVisibility = (map, visible) => {
  HEAT_PLACE_LABEL_LAYER_IDS.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  });
};

const ScaleBar = ({ mode }) => {
  const palette = mode === 'tropical'
    ? TROPICAL_PALETTE
    : mode === 'change'
      ? TIMELINE_PALETTE
      : HEAT_PALETTE.filter(({ value }) => value >= 30);
  const labels = mode === 'tropical'
    ? [18, 22, 25, 27, 30, 33]
    : mode === 'change'
      ? [20, 25, 30, 35, 40, 45]
      : [30, 33, 35, 40, 43];
  const min = palette[0].value;
  const max = palette.at(-1).value;
  return (
    <div
      data-video-hide
      className="pointer-events-none absolute left-5 z-20 rounded-lg bg-slate-900/50 px-2 py-2.5 shadow-lg backdrop-blur-sm"
      style={{ top: 'calc(50% - max(23vh, 140px) - 18.5px)' }}
    >
      <div className="flex h-[46vh] min-h-[280px]">
        <div
          className="w-3 rounded-sm"
          style={{
            background: `linear-gradient(to top, ${palette
              .map(
                ({ value, color }) =>
                  `rgb(${color.join(',')}) ${((value - min) / (max - min)) * 100}%`,
              )
              .join(', ')})`,
          }}
        />
        <div className="relative ml-2 w-8">
          {labels.map((value) => (
            <span
              key={value}
              className={`absolute text-[10px] font-bold leading-none text-white ${
                value === max ? 'translate-y-full' : '-translate-y-1/2'
              }`}
              style={{ bottom: `${((value - min) / (max - min)) * 100}%` }}
            >
              {value}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-1.5 text-center text-[9px] font-semibold text-white/80">°C</div>
    </div>
  );
};

const HeatwaveBroadcastView = () => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const timelineOverlayCanvasRef = useRef(null);
  const landMaskRef = useRef(null);
  const timelinePairRef = useRef(-1);
  const timelinePlaybackStartedAtRef = useRef(0);
  const videoPrepareResolverRef = useRef(null);
  const [mode, setMode] = useState(getInitialTemperatureMode);
  const [workspaceMode, setWorkspaceMode] = useState(() =>
    getWorkspaceModeFromLocation('edit'),
  );
  const [showPlaceLabels, setShowPlaceLabels] = useState(true);
  const [mapStyleMode, setMapStyleMode] = useState('threeD');
  const [dataset, setDataset] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [targetDate, setTargetDate] = useState('');
  const [dateInput, setDateInput] = useState(() => formatKstDateInput());
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [initialTimelineRange] = useState(buildDefaultTimelineRange);
  const [timelineStartInput, setTimelineStartInput] = useState(initialTimelineRange.start);
  const [timelineEndInput, setTimelineEndInput] = useState(initialTimelineRange.end);
  const [timelineRange, setTimelineRange] = useState(initialTimelineRange);
  const [isTimelineRangeOpen, setIsTimelineRangeOpen] = useState(false);
  const [timelineProgress, setTimelineProgress] = useState(0);
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);
  const [timelineDurationSec, setTimelineDurationSec] = useState(10);
  const [showTimelineTop5, setShowTimelineTop5] = useState(true);
  const todayDate = formatKstDateInput();

  const palette = mode === 'tropical'
    ? TROPICAL_PALETTE
    : mode === 'change'
      ? TIMELINE_PALETTE
      : HEAT_PALETTE;
  const timelineFrames = useMemo(
    () => (mode === 'change' ? dataset?.frames ?? [] : []),
    [dataset, mode],
  );
  const timelineMaxProgress = Math.max(0, timelineFrames.length - 1);
  const activeTimelineFrame = timelineFrames[
    Math.min(timelineFrames.length - 1, Math.round(timelineProgress))
  ] ?? null;
  const top5 = useMemo(() => {
    if (!dataset) return [];
    const sourceRows = mode === 'change' ? dataset.ranking ?? [] : dataset.observations ?? [];
    return [...sourceRows]
      .filter(
        (row) =>
          mode === 'heat' || mode === 'change' ||
          (row.stationType === 'ASOS' && row.value >= 25),
      )
      .sort((left, right) => right.value - left.value)
      .slice(0, 5)
      .map((row) => ({ ...row, label: formatStationLabel(row) }));
  }, [dataset, mode]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [127.8, 36.1],
      zoom: 5.75,
      minZoom: 4.5,
      maxZoom: 11,
      maxPitch: 60,
      pitch: 52,
      bearing: 0,
      attributionControl: false,
      dragRotate: true,
      pitchWithRotate: true,
      touchPitch: true,
      localIdeographFontFamily: '"Noto Sans KR", "Malgun Gothic", sans-serif',
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    if (import.meta.env.DEV) {
      window.__heatwaveMap = map;
    }

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = GRID_WIDTH;
    overlayCanvas.height = GRID_HEIGHT;
    overlayCanvasRef.current = overlayCanvas;
    const timelineOverlayCanvas = document.createElement('canvas');
    timelineOverlayCanvas.width = GRID_WIDTH;
    timelineOverlayCanvas.height = GRID_HEIGHT;
    timelineOverlayCanvasRef.current = timelineOverlayCanvas;
    landMaskRef.current = buildLandMask();

    map.on('load', () => {
      map.addSource('heat-temperature-overlay', {
        type: 'canvas',
        canvas: overlayCanvas,
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
          id: 'heat-temperature-overlay-layer',
          type: 'raster',
          source: 'heat-temperature-overlay',
          paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' },
        },
        'province-border',
      );
      map.addSource(TIMELINE_OVERLAY_SOURCE_ID, {
        type: 'canvas',
        canvas: timelineOverlayCanvas,
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
          id: TIMELINE_OVERLAY_LAYER_ID,
          type: 'raster',
          source: TIMELINE_OVERLAY_SOURCE_ID,
          paint: {
            'raster-opacity': 0,
            'raster-resampling': 'linear',
          },
        },
        'province-border',
      );
      map.addSource(TEMPERATURE_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer(
        {
          id: TEMPERATURE_LAYER_ID,
          type: 'fill-extrusion',
          source: TEMPERATURE_SOURCE_ID,
          paint: {
            'fill-extrusion-base': 0,
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-opacity': 0.94,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        'province-border',
      );
      ensureAdminLayers(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      timelineOverlayCanvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const applyVisibility = () => setHeatPlaceLabelVisibility(map, showPlaceLabels);
    if (map.isStyleLoaded()) {
      applyVisibility();
      return undefined;
    }
    map.on('load', applyVisibility);
    return () => map.off('load', applyVisibility);
  }, [showPlaceLabels]);

  useEffect(() => {
    let active = true;
    const refreshValue = refreshToken ? `${Date.now()}` : '';
    const request = mode === 'change'
      ? fetchTemperatureChangeData({
          start: timelineRange.start,
          end: timelineRange.end,
          refreshToken: refreshValue,
        })
      : fetchHeatwaveBroadcastData(mode, {
          refreshToken: refreshValue,
          targetDate,
        });

    request
      .then(async (result) => {
        if (!active) return;
        if (mode === 'change') {
          const landMask = landMaskRef.current;
          if (!landMask) throw new Error('기온 변화 지도 영역을 준비하지 못했습니다.');
          const preparedFrames = [];
          for (const frame of result.frames) {
            if (!active) return;
            preparedFrames.push({
              ...frame,
              grid: buildTemperatureGrid(frame.observations, landMask),
            });
            await new Promise((resolve) => window.setTimeout(resolve, 0));
          }
          if (!active) return;
          setDataset({ ...result, frames: preparedFrames });
          setTimelineProgress(0);
          timelinePairRef.current = -1;
        } else {
          setDataset(result);
        }
        setStatus('ready');
      })
      .catch((loadError) => {
        if (!active) return;
        setStatus('error');
        setError(loadError.message);
      });
    return () => {
      active = false;
    };
  }, [mode, refreshToken, targetDate, timelineRange]);

  const handleModeChange = useCallback((nextMode) => {
    setIsTimelinePlaying(false);
    timelinePairRef.current = -1;
    setDataset(null);
    setStatus('loading');
    setError('');
    setMode(nextMode);
    const url = new URL(window.location.href);
    url.searchParams.set('temperatureMode', nextMode);
    window.history.replaceState({}, '', url);
  }, []);

  const handleWorkspaceModeChange = useCallback((nextMode) => {
    setWorkspaceMode(nextMode);
    updateWorkspaceModeInUrl(nextMode);
  }, []);

  useEffect(() => {
    if (workspaceMode !== 'broadcast') return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') handleWorkspaceModeChange('edit');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleWorkspaceModeChange, workspaceMode]);

  const handleRefresh = useCallback(() => {
    setIsTimelinePlaying(false);
    setStatus('loading');
    setError('');
    setRefreshToken((value) => value + 1);
  }, []);

  const handleDateSelect = useCallback((nextDate) => {
    if (!nextDate) return;
    const nextTargetDate = nextDate === formatKstDateInput() ? '' : nextDate;
    setDateInput(nextDate);
    setDataset(null);
    setStatus('loading');
    setError('');
    setIsDatePickerOpen(false);
    if (nextTargetDate === targetDate) {
      setRefreshToken((value) => value + 1);
    } else {
      setTargetDate(nextTargetDate);
    }
  }, [targetDate]);

  const handleLatest = useCallback(() => {
    setDataset(null);
    setStatus('loading');
    setError('');
    setDateInput(formatKstDateInput());
    setTargetDate('');
    setIsDatePickerOpen(false);
  }, []);

  const handleDateStep = useCallback((dayOffset) => {
    const currentDate = targetDate || todayDate;
    const shiftedDate = shiftDateInput(currentDate, dayOffset);
    const nextTargetDate = shiftedDate >= todayDate ? '' : shiftedDate;

    setDataset(null);
    setStatus('loading');
    setError('');
    setDateInput(nextTargetDate || todayDate);
    setTargetDate(nextTargetDate);
    setIsDatePickerOpen(false);
  }, [targetDate, todayDate]);

  const handleTimelineRangeApply = useCallback(() => {
    const startTime = Date.parse(timelineStartInput);
    const endTime = Date.parse(timelineEndInput);
    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      startTime >= endTime ||
      endTime - startTime > 24 * 60 * 60 * 1000
    ) {
      setError('시작보다 늦은 종료 시각을 선택하고 기간은 24시간 이내로 설정해 주세요.');
      setStatus('error');
      return;
    }
    setIsTimelinePlaying(false);
    setIsTimelineRangeOpen(false);
    setDataset(null);
    setStatus('loading');
    setError('');
    const nextRange = { start: timelineStartInput, end: timelineEndInput };
    if (
      nextRange.start === timelineRange.start &&
      nextRange.end === timelineRange.end
    ) {
      setRefreshToken((value) => value + 1);
    } else {
      setTimelineRange(nextRange);
    }
  }, [timelineEndInput, timelineRange, timelineStartInput]);

  const handleTimelinePlayToggle = useCallback(() => {
    if (timelineMaxProgress <= 0) return;
    if (isTimelinePlaying) {
      setIsTimelinePlaying(false);
      return;
    }
    if (timelineProgress >= timelineMaxProgress) {
      setTimelineProgress(0);
      timelinePairRef.current = -1;
      timelinePlaybackStartedAtRef.current = performance.now();
    } else {
      timelinePlaybackStartedAtRef.current =
        performance.now() -
        (timelineProgress / timelineMaxProgress) * timelineDurationSec * 1000;
    }
    setIsTimelinePlaying(true);
  }, [isTimelinePlaying, timelineDurationSec, timelineMaxProgress, timelineProgress]);

  const handleVideoPrepare = useCallback(({ start, end, durationSec }) => {
    const nextRange = {
      start: start || timelineRange.start,
      end: end || timelineRange.end,
    };
    setTimelineDurationSec(durationSec);
    setTimelineStartInput(nextRange.start);
    setTimelineEndInput(nextRange.end);
    setIsTimelinePlaying(false);
    if (
      mode === 'change' &&
      status === 'ready' &&
      nextRange.start === timelineRange.start &&
      nextRange.end === timelineRange.end
    ) {
      return Promise.resolve();
    }
    setDataset(null);
    setStatus('loading');
    setError('');
    setMode('change');
    setTimelineRange(nextRange);
    return new Promise((resolve, reject) => {
      videoPrepareResolverRef.current = { resolve, reject };
    });
  }, [mode, status, timelineRange]);

  const handleVideoStart = useCallback(({ durationSec }) => {
    setTimelineDurationSec(durationSec);
    setTimelineProgress(0);
    timelinePairRef.current = -1;
    timelinePlaybackStartedAtRef.current = performance.now();
    setIsTimelinePlaying(true);
  }, []);

  const renderDataset = useCallback(() => {
    const map = mapRef.current;
    const canvas = overlayCanvasRef.current;
    const landMask = landMaskRef.current;
    if (
      mode === 'change' ||
      !map?.isStyleLoaded() ||
      !dataset ||
      !canvas ||
      !landMask
    ) return false;
    map.setPaintProperty(TIMELINE_OVERLAY_LAYER_ID, 'raster-opacity', 0);
    map.setPaintProperty(TEMPERATURE_LAYER_ID, 'fill-extrusion-height', ['get', 'height']);
    map.setPaintProperty(TEMPERATURE_LAYER_ID, 'fill-extrusion-color', ['get', 'color']);
    const values = buildTemperatureGrid(dataset.observations, landMask);
    const context = canvas.getContext('2d');
    const image = context.createImageData(GRID_WIDTH, GRID_HEIGHT);
    for (let index = 0; index < values.length; index += 1) {
      if (!landMask[index] || values[index] < -40) continue;
      const color = interpolatePaletteColor(values[index], palette);
      const offset = index * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = OVERLAY_ALPHA;
    }
    context.putImageData(image, 0, 0);
    const overlaySource = map.getSource('heat-temperature-overlay');
    overlaySource?.play?.();
    requestAnimationFrame(() => {
      overlaySource?.pause?.();
      map.triggerRepaint();
    });

    const features = [];
    if (mapStyleMode === 'threeD') {
      const halfCell = COLUMN_STRIDE * 0.505;
      const extrusionThreshold =
        mode === 'tropical'
          ? TROPICAL_EXTRUSION_THRESHOLD
          : HEAT_EXTRUSION_THRESHOLD;
      for (let y = Math.floor(COLUMN_STRIDE / 2); y < GRID_HEIGHT; y += COLUMN_STRIDE) {
        for (let x = Math.floor(COLUMN_STRIDE / 2); x < GRID_WIDTH; x += COLUMN_STRIDE) {
          const index = y * GRID_WIDTH + x;
          const value = values[index];
          if (!landMask[index] || value < extrusionThreshold) continue;
          const color = interpolatePaletteColor(value, palette);
          features.push({
            type: 'Feature',
            properties: {
              value: Math.round(value * 10) / 10,
              height: temperatureHeight(value, mode),
              color: `rgb(${color.join(',')})`,
            },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [gridLon(x - halfCell), gridLat(y - halfCell)],
                  [gridLon(x + halfCell), gridLat(y - halfCell)],
                  [gridLon(x + halfCell), gridLat(y + halfCell)],
                  [gridLon(x - halfCell), gridLat(y + halfCell)],
                  [gridLon(x - halfCell), gridLat(y - halfCell)],
                ],
              ],
            },
          });
        }
      }
    }
    map.getSource(TEMPERATURE_SOURCE_ID)?.setData({
      type: 'FeatureCollection',
      features,
    });
    map.triggerRepaint();
    return true;
  }, [dataset, mapStyleMode, mode, palette]);

  const renderTimelineDataset = useCallback((progress) => {
    const map = mapRef.current;
    const baseCanvas = overlayCanvasRef.current;
    const nextCanvas = timelineOverlayCanvasRef.current;
    if (
      mode !== 'change' ||
      !map?.isStyleLoaded() ||
      !baseCanvas ||
      !nextCanvas ||
      timelineFrames.length < 2
    ) return false;

    const boundedProgress = Math.min(timelineMaxProgress, Math.max(0, progress));
    const fromIndex = Math.min(
      timelineFrames.length - 2,
      Math.floor(boundedProgress),
    );
    const toIndex = fromIndex + 1;
    const blend = boundedProgress >= timelineMaxProgress
      ? 1
      : boundedProgress - fromIndex;

    if (timelinePairRef.current !== fromIndex) {
      const fromFrame = timelineFrames[fromIndex];
      const toFrame = timelineFrames[toIndex];
      drawTemperatureGrid(baseCanvas, fromFrame.grid, TIMELINE_PALETTE);
      drawTemperatureGrid(nextCanvas, toFrame.grid, TIMELINE_PALETTE);
      map.getSource('heat-temperature-overlay')?.play?.();
      map.getSource(TIMELINE_OVERLAY_SOURCE_ID)?.play?.();
      map.getSource(TEMPERATURE_SOURCE_ID)?.setData({
        type: 'FeatureCollection',
        features: buildTimelineExtrusionFeatures(fromFrame.grid, toFrame.grid),
      });
      timelinePairRef.current = fromIndex;
    }

    map.setPaintProperty(TIMELINE_OVERLAY_LAYER_ID, 'raster-opacity', blend);
    map.setPaintProperty(TEMPERATURE_LAYER_ID, 'fill-extrusion-height', [
      'interpolate',
      ['linear'],
      blend,
      0,
      ['get', 'fromHeight'],
      1,
      ['get', 'toHeight'],
    ]);
    map.setPaintProperty(TEMPERATURE_LAYER_ID, 'fill-extrusion-color', [
      'interpolate',
      ['linear'],
      blend,
      0,
      ['get', 'fromColor'],
      1,
      ['get', 'toColor'],
    ]);
    map.triggerRepaint();
    return true;
  }, [mode, timelineFrames, timelineMaxProgress]);

  useEffect(() => {
    if (status !== 'ready' || mode === 'change') return undefined;
    const timer = window.setInterval(() => {
      if (renderDataset()) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [mode, renderDataset, status]);

  useEffect(() => {
    if (status !== 'ready' || mode !== 'change') return undefined;
    if (renderTimelineDataset(timelineProgress)) return undefined;
    const timer = window.setInterval(() => {
      if (renderTimelineDataset(timelineProgress)) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [mode, renderTimelineDataset, status, timelineProgress]);

  useEffect(() => {
    if (
      !isTimelinePlaying ||
      mode !== 'change' ||
      status !== 'ready' ||
      timelineMaxProgress <= 0
    ) return undefined;

    const timer = window.setInterval(() => {
      const elapsed = performance.now() - timelinePlaybackStartedAtRef.current;
      const nextProgress = Math.min(
        timelineMaxProgress,
        (elapsed / (timelineDurationSec * 1000)) * timelineMaxProgress,
      );
      setTimelineProgress(nextProgress);
      if (nextProgress >= timelineMaxProgress) setIsTimelinePlaying(false);
    }, TIMELINE_RENDER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isTimelinePlaying, mode, status, timelineDurationSec, timelineMaxProgress]);

  useEffect(() => {
    if (targetDate || mode === 'change') return undefined;
    const timer = window.setInterval(handleRefresh, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [handleRefresh, mode, targetDate]);

  useEffect(() => {
    const pending = videoPrepareResolverRef.current;
    if (!pending || mode !== 'change') return;
    if (status === 'ready') {
      videoPrepareResolverRef.current = null;
      pending.resolve();
    } else if (status === 'error') {
      videoPrepareResolverRef.current = null;
      pending.reject(new Error(error || '기온 변화 자료를 준비하지 못했습니다.'));
    }
  }, [error, mode, status]);

  const displayObservedAtCode = mode === 'change'
    ? activeTimelineFrame?.observedAtCode ?? ''
    : dataset?.observedAtCode ?? '';
  const timelineProgressPercent = timelineMaxProgress > 0
    ? (timelineProgress / timelineMaxProgress) * 100
    : 0;
  const timelineInputMax = buildDefaultTimelineRange().end;
  const workspaceMenu = workspaceMode === 'broadcast' ? null : (
    <WeatherWorkspaceMenu
      workspaceMode={workspaceMode}
      onWorkspaceModeChange={handleWorkspaceModeChange}
      section="heat"
      onSectionChange={(nextSection) => {
        if (nextSection === 'heat') return;
        window.location.href = `/?view=radar&mode=${workspaceMode}&videoTarget=radar`;
      }}
      activeView={mode}
      onViewChange={handleModeChange}
      showPlaceLabels={showPlaceLabels}
      onShowPlaceLabelsChange={setShowPlaceLabels}
      onExit={() => {
        window.location.href = '/';
      }}
    />
  );

  return (
    <section className="fixed inset-0 overflow-hidden bg-[#46536a] text-white">
      <div className="absolute inset-0">
        <div ref={mapContainerRef} className="h-full w-full" aria-label="폭염 방송 지도" />
      </div>

      {workspaceMode === 'record' ? (
        <VideoExportMenu
          currentTarget="temperature"
          mapRef={mapRef}
          defaultStart={timelineRange.start}
          defaultEnd={timelineRange.end}
          onPreparePlayback={handleVideoPrepare}
          onStartPlayback={handleVideoStart}
        />
      ) : null}

      {status === 'loading' ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/25 text-xl font-bold">
          {mode === 'tropical' ? '열대야' : mode === 'change' ? '기온 변화' : '폭염'} 관측 자료를 불러오는 중입니다…
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="absolute inset-x-0 top-1/2 z-30 mx-auto w-fit -translate-y-1/2 rounded-2xl bg-slate-950/80 px-8 py-5 text-lg font-bold shadow-2xl">
          {error || '기온 관측 자료를 불러오지 못했습니다.'}
        </div>
      ) : null}

      <div
        className="pointer-events-none absolute z-20 flex items-center"
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
          <div className="relative flex flex-col leading-none">
            <span className="font-black tracking-[0.18em]" style={{ fontSize: 'clamp(13px, 1vw, 22px)' }}>
              KBS
            </span>
            <span className="mt-[0.2em] font-bold tracking-[0.1em] text-white/80" style={{ fontSize: 'clamp(9px, 0.72vw, 16px)' }}>
              WEATHER
            </span>
            <span className="absolute -right-3 -top-2 text-[#f4c542]">✦</span>
          </div>
          <span
            className="whitespace-nowrap font-black tracking-tight"
            style={{ fontSize: 'clamp(25px, 2vw, 44px)', textShadow: '0 2px 6px rgba(0,0,0,0.35)' }}
          >
            {mode === 'tropical'
              ? '열대야 현황'
              : mode === 'change'
                ? '기온 변화'
              : dataset?.status === 'historical'
                ? '최고기온'
                : '오늘 최고기온'}
          </span>
          {displayObservedAtCode ? (
            <div className="ml-auto flex shrink-0 flex-col items-end whitespace-nowrap">
              {targetDate && mode !== 'change' ? (
                <span className="font-black tabular-nums" style={{ fontSize: 'clamp(16px, 1.2vw, 26px)' }}>
                  {Number(displayObservedAtCode.slice(4, 6))}/{Number(displayObservedAtCode.slice(6, 8))}
                </span>
              ) : (
                <>
                  <span className="font-black tabular-nums" style={{ fontSize: 'clamp(16px, 1.2vw, 26px)' }}>
                    {displayObservedAtCode.slice(8, 10)}:{displayObservedAtCode.slice(10, 12)}
                  </span>
                  <span className="text-xs font-semibold text-[#bdd6fb]">
                    {Number(displayObservedAtCode.slice(4, 6))}/{Number(displayObservedAtCode.slice(6, 8))}
                  </span>
                </>
              )}
            </div>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-[#3d86e8] to-[#8ec2ff]" />
        </div>
      </div>

      {top5.length > 0 && showTimelineTop5 ? (
        <div
          data-video-hide
          className="pointer-events-none absolute z-20 flex justify-center"
          style={{
            left: '4.4%',
            top: 'calc(50% - max(23vh, 140px) - 18.5px)',
            width: 'clamp(430px, 29vw, 700px)',
          }}
        >
          <div className="overflow-hidden rounded-md bg-slate-900/60 shadow-xl backdrop-blur-sm" style={{ width: 'clamp(320px, 22vw, 500px)' }}>
            <div className="border-b border-white/15 px-5 py-2 text-sm font-black text-white/80">
              {mode === 'tropical' ? '열대야 순위' : '최고기온 순위'}
            </div>
            <div className="divide-y divide-white/10">
              {top5.map((row, index) => (
                <div key={row.id} className="flex items-center gap-2.5 px-5 py-[0.9vh]" style={{ fontSize: 'clamp(16px, 1.25vw, 26px)' }}>
                  <span className="w-[1.2em] shrink-0 font-black text-[#f4c542]">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{row.label}</span>
                  <span className="shrink-0 font-black tabular-nums">
                    {row.value.toFixed(1)}
                    <span className="ml-0.5 font-semibold text-white/70">°C</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {workspaceMode !== 'broadcast' ? <ScaleBar mode={mode} /> : null}

      {mode === 'change' ? (
        <div data-video-hide className="absolute bottom-0 left-[43%] right-0 z-20 bg-gradient-to-t from-slate-950/75 via-slate-950/35 to-transparent pb-3 pl-6 pr-6 pt-10">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleTimelinePlayToggle}
              disabled={status !== 'ready' || timelineFrames.length < 2}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#1d5fd1] text-white shadow-xl transition hover:bg-[#2875d9] disabled:cursor-wait disabled:opacity-45"
              aria-label={isTimelinePlaying ? '기온 변화 일시정지' : '기온 변화 재생'}
              title={isTimelinePlaying ? '일시정지' : '재생'}
            >
              {isTimelinePlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex items-center justify-between text-xs font-bold tabular-nums text-white/75">
                <span>{formatTimelineClock(timelineFrames[0]?.observedAtCode)}</span>
                <span className="rounded-full bg-slate-950/75 px-3 py-1 text-sm text-white">
                  {formatTimelineClock(activeTimelineFrame?.observedAtCode)}
                </span>
                <span>{formatTimelineClock(timelineFrames.at(-1)?.observedAtCode)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={timelineMaxProgress}
                step="0.01"
                value={timelineProgress}
                onChange={(event) => {
                  setIsTimelinePlaying(false);
                  setTimelineProgress(Number(event.target.value));
                }}
                disabled={timelineFrames.length < 2}
                className="h-2.5 w-full cursor-pointer appearance-none rounded-full accent-[#2875d9] disabled:cursor-wait"
                style={{
                  background: `linear-gradient(to right, #2875d9 ${timelineProgressPercent}%, rgba(255,255,255,0.28) ${timelineProgressPercent}%)`,
                }}
                aria-label="기온 변화 재생 위치"
              />
            </div>
          </div>
        </div>
      ) : null}

      <div data-video-hide className={`absolute right-6 z-30 flex flex-col items-end gap-2 ${mode === 'change' ? 'bottom-[7.2rem]' : 'bottom-6'}`}>
        {workspaceMenu}
        {workspaceMode !== 'broadcast' ? (
        <div className="flex items-center gap-2">
        {mode !== 'change' ? (
          <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleDateStep(-1)}
            disabled={status === 'loading'}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-slate-900/70 text-white/85 shadow-lg backdrop-blur-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`${mode === 'tropical' ? '열대야' : '폭염'} 전날 조회`}
            title="전날 조회"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>

          <div className="relative">
            {isDatePickerOpen ? (
              <div className="absolute bottom-14 right-0 flex w-72 flex-col gap-2 rounded-xl border border-white/20 bg-slate-950/90 p-4 shadow-2xl backdrop-blur-md">
                <label className="text-xs font-black tracking-wide text-white/70" htmlFor="heat-history-date">
                  조회 날짜
                </label>
                <input
                  id="heat-history-date"
                  type="date"
                  value={dateInput}
                  max={todayDate}
                  onInput={(event) => handleDateSelect(event.currentTarget.value)}
                  className="h-10 rounded-lg border border-white/15 bg-slate-800 px-3 text-sm font-semibold text-white outline-none [color-scheme:dark] focus:border-blue-400"
                />
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setIsDatePickerOpen((value) => !value)}
              className={`flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-black shadow-lg backdrop-blur-sm transition ${
                targetDate
                  ? 'border-blue-300/70 bg-blue-500 text-white hover:bg-blue-400'
                  : 'border-white/25 bg-slate-900/70 text-white/85 hover:bg-slate-800'
              }`}
              aria-expanded={isDatePickerOpen}
              aria-label="과거 기온 날짜 선택"
            >
              <CalendarDays className="h-5 w-5" />
              {targetDate ? formatShortDate(targetDate) : '과거 날짜'}
            </button>
          </div>

          <button
            type="button"
            onClick={() => handleDateStep(1)}
            disabled={!targetDate || status === 'loading'}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-slate-900/70 text-white/85 shadow-lg backdrop-blur-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`${mode === 'tropical' ? '열대야' : '폭염'} 다음날 조회`}
            title="다음날 조회"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
          </div>
        ) : null}
        {targetDate && mode !== 'change' ? (
          <button
            type="button"
            onClick={handleLatest}
            className="h-12 rounded-full border border-white/25 bg-white px-4 text-sm font-black text-slate-900 shadow-lg transition hover:bg-white/85"
          >
            최신
          </button>
        ) : null}
        {mode === 'change' ? (
          <>
            <div className="relative">
              {isTimelineRangeOpen ? (
                <div className="absolute bottom-14 right-0 flex w-80 flex-col gap-3 rounded-lg border border-white/20 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md">
                  <label className="flex flex-col gap-1.5 text-xs font-black text-white/70">
                    시작 시각
                    <input
                      type="datetime-local"
                      step="1800"
                      value={timelineStartInput}
                      max={timelineEndInput || timelineInputMax}
                      onChange={(event) => setTimelineStartInput(event.target.value)}
                      className="h-10 rounded-md border border-white/15 bg-slate-800 px-3 text-sm font-semibold text-white outline-none [color-scheme:dark] focus:border-blue-400"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-black text-white/70">
                    종료 시각
                    <input
                      type="datetime-local"
                      step="1800"
                      value={timelineEndInput}
                      min={timelineStartInput || undefined}
                      max={timelineInputMax}
                      onChange={(event) => setTimelineEndInput(event.target.value)}
                      className="h-10 rounded-md border border-white/15 bg-slate-800 px-3 text-sm font-semibold text-white outline-none [color-scheme:dark] focus:border-blue-400"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleTimelineRangeApply}
                    className="h-10 rounded-md bg-blue-500 text-sm font-black text-white transition hover:bg-blue-400"
                  >
                    기간 적용
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setIsTimelineRangeOpen((value) => !value)}
                aria-expanded={isTimelineRangeOpen}
                className="flex h-12 items-center gap-2 rounded-full border border-white/25 bg-slate-950/75 px-4 text-sm font-black text-white shadow-xl backdrop-blur-sm transition hover:bg-slate-800"
                aria-label="기온 변화 기간 설정"
              >
                <SlidersHorizontal className="h-4 w-4" />
                {timelineRange.start.slice(11)}–{timelineRange.end.slice(11)}
              </button>
            </div>
            <select
              value={timelineDurationSec}
              onChange={(event) => setTimelineDurationSec(Number(event.target.value))}
              className="h-12 cursor-pointer rounded-full border border-white/20 bg-slate-950/75 px-4 text-sm font-black text-white shadow-xl outline-none backdrop-blur-sm"
              aria-label="기온 변화 재생 길이"
            >
              {TIMELINE_PLAY_DURATIONS.map((seconds) => (
                <option key={seconds} value={seconds} className="text-slate-900">
                  {seconds}초
                </option>
              ))}
            </select>
          </>
        ) : (
          <div
            className="flex h-12 items-center rounded-full border border-white/20 bg-slate-950/75 p-1 shadow-xl backdrop-blur-sm"
            role="group"
            aria-label="지도 표현 방식"
          >
            {[
              { id: 'flat', label: '평면' },
              { id: 'threeD', label: '입체' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMapStyleMode(item.id)}
                aria-pressed={mapStyleMode === item.id}
                className={`h-10 rounded-full px-4 text-sm font-black transition ${
                  mapStyleMode === item.id
                    ? 'bg-white text-slate-900'
                    : 'text-white/65 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <label className="flex h-12 cursor-pointer items-center gap-2 rounded-full border border-white/20 bg-slate-950/75 px-4 text-sm font-black text-white shadow-xl backdrop-blur-sm">
          <input
            type="checkbox"
            checked={showTimelineTop5}
            onChange={(event) => setShowTimelineTop5(event.target.checked)}
            className="h-4 w-4 accent-[#f4c542]"
          />
          {mode === 'tropical' ? '열대야 5위' : '최고기온 5위'}
        </label>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={status === 'loading'}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-slate-900/70 shadow-lg backdrop-blur-sm transition hover:bg-slate-800 disabled:opacity-50"
          aria-label="기온 자료 새로고침"
          title="기온 자료 새로고침"
        >
          <RefreshCw className={`h-5 w-5 ${status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
        </div>
        ) : (
          <label className="flex h-12 cursor-pointer items-center gap-2 rounded-full border border-white/20 bg-slate-950/75 px-4 text-sm font-black text-white shadow-xl backdrop-blur-sm">
            <input
              type="checkbox"
              checked={showTimelineTop5}
              onChange={(event) => setShowTimelineTop5(event.target.checked)}
              className="h-4 w-4 accent-[#f4c542]"
            />
            {mode === 'tropical' ? '열대야 5위' : '최고기온 5위'}
          </label>
        )}
      </div>
    </section>
  );
};

export default HeatwaveBroadcastView;
