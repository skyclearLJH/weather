import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  Columns2,
  Flame,
  Gauge,
  Layers2,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import VideoExportMenu from './VideoExportMenu.jsx';
import krProvinces from '../data/map/krProvinces.json';
import interKoreanSeam from '../data/map/interKoreanSeam.json';
import neighborCoasts from '../data/map/neighborCoasts.json';
import {
  LCC_RHO0_KM,
  RADAR_DOWNSAMPLE,
  RADAR_GRID,
  RAIN_PALETTE,
  fetchRadarFrame,
  floorToTenMinutes,
  formatRadarTm,
  lccRhoKm,
  lccTheta,
  parseRadarTm,
  probeLatestRadarTm,
} from '../api/radarApi.js';
import {
  fetchAwsStationCoords,
  fetchDailyRnTotal,
  fetchHourlyRnDay,
  formatStationLabel,
} from '../api/accumApi.js';
import { fetchTemperatureChangeData } from '../api/heatwaveApi.js';

const VIEW_BOUNDS = { lonMin: 120.18, lonMax: 133.56, latMin: 30.1, latMax: 43.34 };
const MAP_BOUNDS = [
  [124.3, 32.5],
  [130.8, 39.2],
];
const CANVAS_WIDTH = 768;
const OVERLAY_ALPHA = 218;
const PLAY_INTERVAL_MS = 620;
const MAX_FRAME_COUNT = 25;
const KST_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const RAIN_DURATION_OPTIONS = [1, 3, 6];
const HEAT_DURATION_OPTIONS = [3, 6, 12];

const pad2 = (value) => String(value).padStart(2, '0');
const formatDateTimeInput = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
  `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
const formatCaseTime = (date) =>
  date
    ? `${date.getMonth() + 1}/${date.getDate()} (${KST_WEEKDAYS[date.getDay()]}) ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    : '--';
const formatShortTime = (date) =>
  date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : '--:--';
const sameLocalDay = (first, second) =>
  first.getFullYear() === second.getFullYear() &&
  first.getMonth() === second.getMonth() &&
  first.getDate() === second.getDate();
const floorToHour = (date) => {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  return next;
};
const parseInput = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const parseObservedAtCode = (value) => {
  if (!/^\d{12}$/.test(value ?? '')) return null;
  return new Date(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12)),
  );
};

const mercatorY = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const mercatorYToLat = (value) =>
  ((2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180) / Math.PI;
const canvasHeight = Math.round(
  (CANVAS_WIDTH * (mercatorY(VIEW_BOUNDS.latMax) - mercatorY(VIEW_BOUNDS.latMin))) /
    ((VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin) * (Math.PI / 180)),
);

let radarPixelMapping = null;
const getRadarPixelMapping = () => {
  if (radarPixelMapping) return radarPixelMapping;
  const yTop = mercatorY(VIEW_BOUNDS.latMax);
  const yBottom = mercatorY(VIEW_BOUNDS.latMin);
  const radarWidth = Math.floor(RADAR_GRID.nx / RADAR_DOWNSAMPLE);
  const radarHeight = Math.floor(RADAR_GRID.ny / RADAR_DOWNSAMPLE);
  const radarCellKm = RADAR_GRID.cellKm * RADAR_DOWNSAMPLE;
  const mapping = new Int32Array(CANVAS_WIDTH * canvasHeight).fill(-1);
  const sinTheta = new Float64Array(CANVAS_WIDTH);
  const cosTheta = new Float64Array(CANVAS_WIDTH);

  for (let x = 0; x < CANVAS_WIDTH; x += 1) {
    const lon =
      VIEW_BOUNDS.lonMin +
      ((x + 0.5) / CANVAS_WIDTH) * (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin);
    const theta = lccTheta(lon);
    sinTheta[x] = Math.sin(theta);
    cosTheta[x] = Math.cos(theta);
  }

  for (let y = 0; y < canvasHeight; y += 1) {
    const lat = mercatorYToLat(yTop - ((y + 0.5) / canvasHeight) * (yTop - yBottom));
    const rho = lccRhoKm(lat);
    for (let x = 0; x < CANVAS_WIDTH; x += 1) {
      const xKm = rho * sinTheta[x];
      const yKm = LCC_RHO0_KM - rho * cosTheta[x];
      const gridX = Math.round(
        xKm / radarCellKm + RADAR_GRID.originI / RADAR_DOWNSAMPLE,
      );
      const gridY = Math.round(
        yKm / radarCellKm + RADAR_GRID.originJ / RADAR_DOWNSAMPLE,
      );
      if (gridX >= 0 && gridX < radarWidth && gridY >= 0 && gridY < radarHeight) {
        mapping[y * CANVAS_WIDTH + x] = gridY * radarWidth + gridX;
      }
    }
  }
  radarPixelMapping = mapping;
  return mapping;
};

const radarImageCache = new WeakMap();
const getRadarImage = (frame) => {
  if (!frame?.buckets) return null;
  const cached = radarImageCache.get(frame);
  if (cached) return cached;
  const mapping = getRadarPixelMapping();
  const image = new ImageData(CANVAS_WIDTH, canvasHeight);
  const pixels = image.data;
  for (let index = 0; index < mapping.length; index += 1) {
    const sourceIndex = mapping[index];
    const bucket = sourceIndex >= 0 ? frame.buckets[sourceIndex] : 0;
    const offset = index * 4;
    if (!bucket) continue;
    const [red, green, blue] = RAIN_PALETTE[bucket - 1].color;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = OVERLAY_ALPHA;
  }
  radarImageCache.set(frame, image);
  return image;
};

const renderRadarFrame = (canvas, frame) => {
  if (!canvas || !frame?.buckets) return;
  const image = getRadarImage(frame);
  if (image) canvas.getContext('2d').putImageData(image, 0, 0);
};

const createMapStyle = () => ({
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
      paint: { 'fill-color': '#828c9c' },
    },
    {
      id: 'neighbor-coast',
      type: 'line',
      source: 'neighbors',
      paint: { 'line-color': '#5d6879', 'line-width': 0.8 },
    },
    { id: 'land', type: 'fill', source: 'provinces', paint: { 'fill-color': '#eef0f2' } },
    {
      id: 'province-border',
      type: 'line',
      source: 'provinces',
      paint: { 'line-color': '#4a5568', 'line-width': 1.1 },
    },
  ],
});

const buildStationFeatures = (kind, stations, rainTotals, temperatureFrame) => {
  if (kind === 'rain') {
    return stations.flatMap((station) => {
      const value = rainTotals?.get(station.id);
      if (!Number.isFinite(value) || value < 0.1) return [];
      return [{
        type: 'Feature',
        properties: {
          id: station.id,
          label: formatStationLabel(station),
          value: Number(value.toFixed(1)),
          unit: 'mm',
        },
        geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
      }];
    });
  }

  return (temperatureFrame?.observations ?? []).map((row) => ({
    type: 'Feature',
    properties: {
      id: row.id,
      label: formatStationLabel(row),
      value: Number(row.value.toFixed(1)),
      unit: '℃',
    },
    geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
  }));
};

const addComparisonLayers = (map, canvas) => {
  map.addSource('case-radar', {
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
      id: 'case-radar',
      type: 'raster',
      source: 'case-radar',
      paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' },
    },
    'province-border',
  );

  map.addSource('case-stations', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'case-rain-stations',
    type: 'circle',
    source: 'case-stations',
    filter: ['==', ['get', 'unit'], 'mm'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'value'], 0.1, 3, 10, 6, 50, 11, 150, 17, 300, 22],
      'circle-color': ['interpolate', ['linear'], ['get', 'value'], 0.1, '#56d5ff', 20, '#2dd4bf', 50, '#facc15', 100, '#f97316', 200, '#e11d48', 300, '#8b5cf6'],
      'circle-opacity': 0.86,
      'circle-stroke-color': 'rgba(255,255,255,0.94)',
      'circle-stroke-width': 1.2,
    },
  });
  map.addLayer({
    id: 'case-temperature-stations',
    type: 'circle',
    source: 'case-stations',
    filter: ['==', ['get', 'unit'], '℃'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 8, 8, 14],
      'circle-color': ['interpolate', ['linear'], ['get', 'value'], 20, '#2c7bb6', 25, '#65c2a5', 30, '#ffffbf', 33, '#fdae61', 35, '#f46d43', 38, '#d73027', 43, '#762a83', 45, '#3f007d'],
      'circle-opacity': 0.88,
      'circle-stroke-color': 'rgba(255,255,255,0.82)',
      'circle-stroke-width': 0.8,
    },
  });

  map.addSource('case-sido-labels', {
    type: 'geojson',
    data: '/data/map/kr-sido-labels-20260701.geojson',
  });
  map.addSource('case-sgg', {
    type: 'geojson',
    data: '/data/map/kr-sgg-20260701.geojson',
  });
  map.addSource('case-sgg-labels', {
    type: 'geojson',
    data: '/data/map/kr-sgg-labels-20260701.geojson',
  });
  map.addLayer({
    id: 'case-sgg-border',
    type: 'line',
    source: 'case-sgg',
    minzoom: 6.6,
    paint: { 'line-color': '#6b7280', 'line-width': 0.55, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'case-sido-label',
    type: 'symbol',
    source: 'case-sido-labels',
    maxzoom: 7.2,
    layout: {
      'text-field': ['get', 'sidonm'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 4.5, 11, 7, 15],
      'text-font': ['Open Sans Bold'],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#263244',
      'text-halo-color': 'rgba(255,255,255,0.94)',
      'text-halo-width': 1.4,
    },
  });
  map.addLayer({
    id: 'case-sgg-label',
    type: 'symbol',
    source: 'case-sgg-labels',
    minzoom: 6.8,
    layout: {
      'text-field': ['get', 'sggnm'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 6.8, 9, 9.5, 13],
      'text-font': ['Open Sans Semibold'],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#2f3b4d',
      'text-halo-color': 'rgba(255,255,255,0.92)',
      'text-halo-width': 1.2,
    },
  });
};

function ComparisonMapPane({
  caseId,
  kind,
  radarFrame,
  rainTotals,
  temperatureFrame,
  stations,
  showPlaceLabels,
  onMapReady,
  onCameraChange,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = canvasHeight;
    canvasRef.current = canvas;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: createMapStyle(),
      bounds: MAP_BOUNDS,
      fitBoundsOptions: { padding: 0 },
      minZoom: 4.5,
      maxZoom: 13,
      attributionControl: false,
      localIdeographFontFamily: '"Noto Sans KR", "Malgun Gothic", sans-serif',
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    const setup = () => {
      if (map.getSource('case-radar')) return;
      addComparisonLayers(map, canvas);
      onMapReady(caseId, map);
    };
    map.on('load', setup);
    const handleMove = () => onCameraChange(caseId, map);
    map.on('move', handleMove);
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    let popup = null;
    const handleStationClick = (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      popup?.remove();
      popup = new maplibregl.Popup({ closeButton: false, offset: 12 })
        .setLngLat(event.lngLat)
        .setHTML(
          `<div style="font-weight:800;color:#172033">${feature.properties.label}</div>` +
            `<div style="margin-top:2px;font-weight:900;color:#0f766e">${feature.properties.value} ${feature.properties.unit}</div>`,
        )
        .addTo(map);
    };
    map.on('click', 'case-rain-stations', handleStationClick);
    map.on('click', 'case-temperature-stations', handleStationClick);

    return () => {
      popup?.remove();
      resizeObserver.disconnect();
      map.off('move', handleMove);
      map.off('click', 'case-rain-stations', handleStationClick);
      map.off('click', 'case-temperature-stations', handleStationClick);
      onMapReady(caseId, null);
      map.remove();
      mapRef.current = null;
      canvasRef.current = null;
    };
  }, [caseId, onCameraChange, onMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map || !canvas || !map.getSource('case-radar')) return;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (kind === 'rain' && radarFrame) renderRadarFrame(canvas, radarFrame);
    const source = map.getSource('case-radar');
    source.play();
    requestAnimationFrame(() => {
      source.pause();
      map.triggerRepaint();
    });
  }, [kind, radarFrame]);

  useEffect(() => {
    const source = mapRef.current?.getSource('case-stations');
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: buildStationFeatures(kind, stations, rainTotals, temperatureFrame),
    });
  }, [kind, rainTotals, stations, temperatureFrame]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    ['case-sido-label', 'case-sgg-label'].forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', showPlaceLabels ? 'visible' : 'none');
      }
    });
  }, [showPlaceLabels]);

  return <div ref={containerRef} className="h-full w-full" />;
}

const addMaps = (first, second, operation) => {
  const ids = new Set([...first.keys(), ...second.keys()]);
  const result = new Map();
  ids.forEach((id) => {
    const value = operation(first.get(id) ?? 0, second.get(id) ?? 0);
    if (Number.isFinite(value) && value >= 0) result.set(id, value);
  });
  return result;
};

const fetchAccumAt = async (date) =>
  date.getHours() === 0 ? new Map() : fetchHourlyRnDay(date);

const fetchRainWindowTotals = async (endInput, hours) => {
  const end = floorToHour(endInput);
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const [startAccum, endAccum] = await Promise.all([fetchAccumAt(start), fetchAccumAt(end)]);
  if (sameLocalDay(start, end)) {
    return addMaps(endAccum, startAccum, (endValue, startValue) =>
      Math.max(0, endValue - startValue),
    );
  }
  const startDayTotal = await fetchDailyRnTotal(start);
  const remainder = addMaps(startDayTotal, startAccum, (dayValue, startValue) =>
    Math.max(0, dayValue - startValue),
  );
  return addMaps(remainder, endAccum, (firstValue, secondValue) => firstValue + secondValue);
};

const getRadarStepMinutes = (hours) => (hours <= 1 ? 5 : hours <= 3 ? 10 : 15);
const buildRadarDefinitions = (end, hours) => {
  const stepMinutes = getRadarStepMinutes(hours);
  const count = Math.min(MAX_FRAME_COUNT, Math.floor((hours * 60) / stepMinutes) + 1);
  const start = new Date(end.getTime() - (count - 1) * stepMinutes * 60 * 1000);
  return Array.from({ length: count }, (_, index) => {
    const validTime = new Date(start.getTime() + index * stepMinutes * 60 * 1000);
    return { tm: formatRadarTm(validTime), validTime };
  });
};

const distanceKm = (first, second) => {
  const radians = (value) => (value * Math.PI) / 180;
  const lat1 = radians(first.lat);
  const lat2 = radians(second.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(second.lon - first.lon);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const pearsonCorrelation = (pairs) => {
  if (pairs.length < 10) return null;
  const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;
  pairs.forEach(([x, y]) => {
    numerator += (x - meanX) * (y - meanY);
    denominatorX += (x - meanX) ** 2;
    denominatorY += (y - meanY) ** 2;
  });
  const denominator = Math.sqrt(denominatorX * denominatorY);
  return denominator > 0 ? numerator / denominator : null;
};

const findTopStation = (values, stationsById) => {
  let top = null;
  values?.forEach((value, id) => {
    const station = stationsById.get(id);
    if (station && (!top || value > top.value)) top = { ...station, value };
  });
  return top;
};

const buildRainMetrics = (currentFrame, historicalFrame, currentTotals, historicalTotals, stations) => {
  const thresholdBucket = RAIN_PALETTE.findIndex((item) => item.min >= 10) + 1;
  let intersection = 0;
  let union = 0;
  if (currentFrame?.buckets && historicalFrame?.buckets) {
    const length = Math.min(currentFrame.buckets.length, historicalFrame.buckets.length);
    for (let index = 0; index < length; index += 16) {
      const currentStrong = currentFrame.buckets[index] >= thresholdBucket;
      const historicalStrong = historicalFrame.buckets[index] >= thresholdBucket;
      if (currentStrong || historicalStrong) union += 1;
      if (currentStrong && historicalStrong) intersection += 1;
    }
  }
  const commonPairs = [];
  currentTotals?.forEach((value, id) => {
    if (historicalTotals?.has(id)) commonPairs.push([value, historicalTotals.get(id)]);
  });
  const correlation = pearsonCorrelation(commonPairs);
  const stationsById = new Map(stations.map((station) => [station.id, station]));
  const currentTop = findTopStation(currentTotals, stationsById);
  const historicalTop = findTopStation(historicalTotals, stationsById);
  const topDistance = currentTop && historicalTop ? distanceKm(currentTop, historicalTop) : null;
  return [
    {
      label: '강한 에코 겹침',
      value: union > 0 ? `${Math.round((intersection / union) * 100)}%` : '자료 없음',
      note: '10 mm/h 이상 관측영역',
    },
    {
      label: 'AWS 누적 분포',
      value: correlation === null ? '자료 없음' : `r ${correlation.toFixed(2)}`,
      note: `${commonPairs.length}개 공통 지점`,
    },
    {
      label: '최다 지점 거리',
      value: topDistance === null ? '자료 없음' : `${Math.round(topDistance)} km`,
      note:
        currentTop && historicalTop
          ? `${formatStationLabel(currentTop)} ↔ ${formatStationLabel(historicalTop)}`
          : 'AWS 누적 기준',
    },
  ];
};

const buildHeatMetrics = (currentFrame, historicalFrame, currentRanking, historicalRanking, stations) => {
  const historicalById = new Map(
    (historicalFrame?.observations ?? []).map((row) => [row.id, row]),
  );
  const pairs = (currentFrame?.observations ?? []).flatMap((row) => {
    const historical = historicalById.get(row.id);
    return historical ? [[row.value, historical.value]] : [];
  });
  const meanDifference = pairs.length
    ? pairs.reduce((sum, [current, historical]) => sum + Math.abs(current - historical), 0) /
      pairs.length
    : null;
  const currentHotShare = pairs.length
    ? pairs.filter(([current]) => current >= 33).length / pairs.length
    : null;
  const historicalHotShare = pairs.length
    ? pairs.filter(([, historical]) => historical >= 33).length / pairs.length
    : null;
  const stationsById = new Map(stations.map((station) => [station.id, station]));
  const currentValues = new Map((currentRanking ?? []).map((row) => [row.id, row.value]));
  const historicalValues = new Map((historicalRanking ?? []).map((row) => [row.id, row.value]));
  const currentTop = findTopStation(currentValues, stationsById);
  const historicalTop = findTopStation(historicalValues, stationsById);
  const topDistance = currentTop && historicalTop ? distanceKm(currentTop, historicalTop) : null;
  return [
    {
      label: '공통지점 기온차',
      value: meanDifference === null ? '자료 없음' : `${meanDifference.toFixed(1)}℃`,
      note: `${pairs.length}개 지점 평균 절대차`,
    },
    {
      label: '33℃ 이상 지점 비율',
      value:
        currentHotShare === null
          ? '자료 없음'
          : `${Math.round(currentHotShare * 100)}% / ${Math.round(historicalHotShare * 100)}%`,
      note: '현재 / 과거',
    },
    {
      label: '최고기온 지점 거리',
      value: topDistance === null ? '자료 없음' : `${Math.round(topDistance)} km`,
      note:
        currentTop && historicalTop
          ? `${formatStationLabel(currentTop)} ↔ ${formatStationLabel(historicalTop)}`
          : '일 최고기온 기준',
    },
  ];
};

const MetricPanel = ({ metrics }) => (
  <div className="grid w-[min(760px,92vw)] grid-cols-3 overflow-hidden rounded-md border border-white/15 bg-slate-950/72 shadow-2xl backdrop-blur-md">
    {metrics.map((metric) => (
      <div key={metric.label} className="border-r border-white/10 px-4 py-3 last:border-r-0">
        <div className="text-[11px] font-black text-cyan-200">{metric.label}</div>
        <div className="mt-0.5 text-xl font-black tabular-nums text-white">{metric.value}</div>
        <div className="mt-0.5 truncate text-[10px] font-semibold text-white/55" title={metric.note}>
          {metric.note}
        </div>
      </div>
    ))}
  </div>
);

function HistoricalCaseComparison({
  workspaceMode,
  showPlaceLabels,
  menuSlot,
  onBeforeScreenShare,
}) {
  const now = useMemo(() => floorToTenMinutes(new Date()), []);
  const priorYear = useMemo(() => {
    const date = new Date(now);
    date.setFullYear(date.getFullYear() - 1);
    return date;
  }, [now]);
  const [kind, setKind] = useState('rain');
  const [layout, setLayout] = useState('side');
  const [durationHours, setDurationHours] = useState(3);
  const [currentEndInput, setCurrentEndInput] = useState(formatDateTimeInput(now));
  const [historicalEndInput, setHistoricalEndInput] = useState(formatDateTimeInput(priorYear));
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [stations, setStations] = useState([]);
  const [cases, setCases] = useState(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playIntervalMs, setPlayIntervalMs] = useState(PLAY_INTERVAL_MS);
  const [radarFrames, setRadarFrames] = useState(() => new Map());
  const [preloadProgress, setPreloadProgress] = useState({ done: 0, total: 0 });
  const [splitPercent, setSplitPercent] = useState(50);
  const rootRef = useRef(null);
  const primaryMapRef = useRef(null);
  const mapsRef = useRef({ current: null, historical: null });
  const cameraSyncRef = useRef(false);
  const radarCacheRef = useRef(new Map());
  const loadGenerationRef = useRef(0);
  const initialLoadRef = useRef(false);

  const onMapReady = useCallback((caseId, map) => {
    mapsRef.current[caseId] = map;
    if (caseId === 'current') primaryMapRef.current = map;
  }, []);

  const onCameraChange = useCallback((caseId, sourceMap) => {
    if (cameraSyncRef.current) return;
    const targetId = caseId === 'current' ? 'historical' : 'current';
    const targetMap = mapsRef.current[targetId];
    if (!targetMap) return;
    cameraSyncRef.current = true;
    const center = sourceMap.getCenter();
    targetMap.jumpTo({
      center: [center.lng, center.lat],
      zoom: sourceMap.getZoom(),
      bearing: 0,
      pitch: 0,
    });
    requestAnimationFrame(() => {
      cameraSyncRef.current = false;
    });
  }, []);

  const rememberRadarFrame = useCallback((tm, frame) => {
    radarCacheRef.current.set(tm, { value: frame });
    setRadarFrames((previous) => {
      const next = new Map(previous);
      next.set(tm, frame);
      return next;
    });
  }, []);

  const loadRadar = useCallback((tm) => {
    const cached = radarCacheRef.current.get(tm);
    if (cached?.value) return Promise.resolve(cached.value);
    if (cached?.promise) return cached.promise;
    const promise = fetchRadarFrame(tm, { broadcast: true })
      .then((frame) => {
        radarCacheRef.current.set(tm, { value: frame });
        setRadarFrames((previous) => {
          const next = new Map(previous);
          next.set(tm, frame);
          return next;
        });
        return frame;
      })
      .catch((loadError) => {
        radarCacheRef.current.delete(tm);
        throw loadError;
      });
    radarCacheRef.current.set(tm, { promise });
    return promise;
  }, []);

  const loadCases = useCallback(async (nextKind = kind) => {
    const currentEnd = parseInput(currentEndInput);
    const historicalEnd = parseInput(historicalEndInput);
    if (!currentEnd || !historicalEnd) {
      setError('비교할 두 사례의 종료 시각을 확인해 주세요.');
      return;
    }
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setStatus('loading');
    setError('');
    setWarning('');
    setIsPlaying(false);

    try {
      const stationRows = stations.length > 0 ? stations : await fetchAwsStationCoords();
      if (generation !== loadGenerationRef.current) return;
      if (stations.length === 0) setStations(stationRows);

      if (nextKind === 'rain') {
        radarCacheRef.current.clear();
        setRadarFrames(new Map());
        setPreloadProgress({ done: 0, total: 0 });
        const [currentLatest, historicalLatest] = await Promise.all([
          probeLatestRadarTm(currentEnd, 40, null, { broadcast: true }),
          probeLatestRadarTm(historicalEnd, 40, null, { broadcast: true }),
        ]);
        const currentActualEnd = parseRadarTm(currentLatest.tm);
        const historicalActualEnd = parseRadarTm(historicalLatest.tm);
        rememberRadarFrame(currentLatest.tm, currentLatest.frame);
        rememberRadarFrame(historicalLatest.tm, historicalLatest.frame);
        const [currentRainResult, historicalRainResult] = await Promise.allSettled([
          fetchRainWindowTotals(currentActualEnd, durationHours),
          fetchRainWindowTotals(historicalActualEnd, durationHours),
        ]);
        if (generation !== loadGenerationRef.current) return;
        const nextCases = {
          kind: 'rain',
          current: {
            end: currentActualEnd,
            frames: buildRadarDefinitions(currentActualEnd, durationHours),
            totals: currentRainResult.status === 'fulfilled' ? currentRainResult.value : null,
          },
          historical: {
            end: historicalActualEnd,
            frames: buildRadarDefinitions(historicalActualEnd, durationHours),
            totals:
              historicalRainResult.status === 'fulfilled' ? historicalRainResult.value : null,
          },
        };
        const awsErrors = [currentRainResult, historicalRainResult]
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason?.message)
          .filter(Boolean);
        if (awsErrors.length) {
          setWarning(`레이더는 표시했지만 AWS 누적 일부를 불러오지 못했습니다. ${awsErrors[0]}`);
        }
        setPreloadProgress({ done: 0, total: nextCases.current.frames.length });
        setCases(nextCases);
        setFrameIndex(nextCases.current.frames.length - 1);
        setCurrentEndInput(formatDateTimeInput(currentActualEnd));
        setHistoricalEndInput(formatDateTimeInput(historicalActualEnd));
      } else {
        setPreloadProgress({ done: 0, total: 0 });
        const currentStart = new Date(currentEnd.getTime() - durationHours * 60 * 60 * 1000);
        const historicalStart = new Date(
          historicalEnd.getTime() - durationHours * 60 * 60 * 1000,
        );
        const [currentData, historicalData] = await Promise.all([
          fetchTemperatureChangeData({
            start: formatDateTimeInput(currentStart),
            end: formatDateTimeInput(currentEnd),
          }),
          fetchTemperatureChangeData({
            start: formatDateTimeInput(historicalStart),
            end: formatDateTimeInput(historicalEnd),
          }),
        ]);
        if (generation !== loadGenerationRef.current) return;
        const frameCount = Math.min(currentData.frames.length, historicalData.frames.length);
        setCases({
          kind: 'heat',
          current: {
            end: parseObservedAtCode(currentData.endAtCode) ?? currentEnd,
            frames: currentData.frames.slice(-frameCount),
            ranking: currentData.ranking,
          },
          historical: {
            end: parseObservedAtCode(historicalData.endAtCode) ?? historicalEnd,
            frames: historicalData.frames.slice(-frameCount),
            ranking: historicalData.ranking,
          },
        });
        setFrameIndex(frameCount - 1);
      }
      setStatus('ready');
    } catch (loadError) {
      if (generation !== loadGenerationRef.current) return;
      setStatus('error');
      setError(loadError?.message || '과거 사례 비교 자료를 불러오지 못했습니다.');
    }
  }, [currentEndInput, durationHours, historicalEndInput, kind, rememberRadarFrame, stations]);

  useEffect(() => {
    if (initialLoadRef.current) return;
    const timer = window.setTimeout(() => {
      if (initialLoadRef.current) return;
      initialLoadRef.current = true;
      loadCases('rain');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCases]);

  const frameCount = cases?.current?.frames?.length ?? 0;
  const ensureRainIndex = useCallback(
    async (index) => {
      if (cases?.kind !== 'rain') return [];
      const currentDefinition = cases.current.frames[index];
      const historicalDefinition = cases.historical.frames[index];
      if (!currentDefinition || !historicalDefinition) return [];
      return Promise.all([
        loadRadar(currentDefinition.tm),
        loadRadar(historicalDefinition.tm),
      ]);
    },
    [cases, loadRadar],
  );

  useEffect(() => {
    if (status !== 'ready' || cases?.kind !== 'rain') return undefined;
    let cancelled = false;
    ensureRainIndex(frameIndex).catch((frameError) => {
      if (!cancelled) setWarning(frameError?.message || '선택한 레이더 프레임을 불러오지 못했습니다.');
    });
    const neighbor = frameIndex > 0 ? frameIndex - 1 : frameIndex + 1;
    const timer = window.setTimeout(() => ensureRainIndex(neighbor).catch(() => {}), 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cases, ensureRainIndex, frameIndex, status]);

  // 편집 중 전체 비교 구간을 미리 받아 두면 방송 재생에서는 원본 API 응답을
  // 기다리지 않고 프레임만 교체할 수 있다. 한 인덱스가 현재/과거 두 장을 함께
  // 준비하며, 두 작업자만 사용해 KMA 프록시와 브라우저 메모리 압박을 제한한다.
  useEffect(() => {
    if (status !== 'ready' || cases?.kind !== 'rain' || frameCount < 2) {
      return undefined;
    }
    let cancelled = false;
    const indexes = [
      frameCount - 1,
      ...Array.from({ length: frameCount - 1 }, (_, index) => index),
    ];
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (!cancelled && cursor < indexes.length) {
        const queueIndex = cursor;
        cursor += 1;
        try {
          const loadedFrames = await ensureRainIndex(indexes[queueIndex]);
          loadedFrames.forEach((frame) => getRadarImage(frame));
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        } catch {
          // 선택 시 다시 시도하며, 한 프레임 실패가 나머지 준비를 막지 않게 한다.
        }
        completed += 1;
        if (!cancelled) {
          setPreloadProgress({ done: completed, total: indexes.length });
        }
      }
    };
    Promise.all([worker(), worker()]).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cases?.kind, ensureRainIndex, frameCount, status]);

  useEffect(() => {
    if (!isPlaying || frameCount < 2) return undefined;
    const timer = window.setTimeout(() => {
      const nextIndex = frameIndex + 1;
      if (nextIndex >= frameCount) {
        setIsPlaying(false);
        return;
      }
      setFrameIndex(nextIndex);
    }, playIntervalMs);
    return () => window.clearTimeout(timer);
  }, [frameCount, frameIndex, isPlaying, playIntervalMs]);

  const currentDefinition = cases?.current?.frames?.[frameIndex] ?? null;
  const historicalDefinition = cases?.historical?.frames?.[frameIndex] ?? null;
  const currentRadarFrame =
    cases?.kind === 'rain' && currentDefinition
      ? radarFrames.get(currentDefinition.tm) ?? null
      : null;
  const historicalRadarFrame =
    cases?.kind === 'rain' && historicalDefinition
      ? radarFrames.get(historicalDefinition.tm) ?? null
      : null;

  const currentTemperatureFrame = cases?.kind === 'heat' ? currentDefinition : null;
  const historicalTemperatureFrame = cases?.kind === 'heat' ? historicalDefinition : null;
  const currentTime =
    cases?.kind === 'rain'
      ? currentDefinition?.validTime ?? null
      : parseObservedAtCode(currentTemperatureFrame?.observedAtCode);
  const historicalTime =
    cases?.kind === 'rain'
      ? historicalDefinition?.validTime ?? null
      : parseObservedAtCode(historicalTemperatureFrame?.observedAtCode);

  const metrics = useMemo(
    () =>
      cases?.kind === 'heat'
        ? buildHeatMetrics(
            currentTemperatureFrame,
            historicalTemperatureFrame,
            cases.current.ranking,
            cases.historical.ranking,
            stations,
          )
        : buildRainMetrics(
            currentRadarFrame,
            historicalRadarFrame,
            cases?.current?.totals,
            cases?.historical?.totals,
            stations,
          ),
    [
      cases,
      currentRadarFrame,
      currentTemperatureFrame,
      historicalRadarFrame,
      historicalTemperatureFrame,
      stations,
    ],
  );

  const timelineFrames = cases?.current?.frames;
  const timelineDates = useMemo(() => {
    if (!timelineFrames) return [];
    return cases?.kind === 'rain'
      ? timelineFrames.map((frame) => frame.validTime)
      : timelineFrames
          .map((frame) => parseObservedAtCode(frame.observedAtCode))
          .filter(Boolean);
  }, [cases?.kind, timelineFrames]);
  const videoDefaultStart = timelineDates[0] ? formatDateTimeInput(timelineDates[0]) : '';
  const videoDefaultEnd = timelineDates.at(-1) ? formatDateTimeInput(timelineDates.at(-1)) : '';

  const findVideoRange = useCallback(
    (start, end) => {
      if (timelineDates.length < 2) return null;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      const startIndex = Number.isFinite(startMs)
        ? timelineDates.findIndex((date) => date.getTime() >= startMs)
        : 0;
      const endIndex = Number.isFinite(endMs)
        ? timelineDates.findLastIndex((date) => date.getTime() <= endMs)
        : timelineDates.length - 1;
      return startIndex >= 0 && endIndex > startIndex ? { startIndex, endIndex } : null;
    },
    [timelineDates],
  );

  const handleVideoPrepare = useCallback(
    async ({ start, end }) => {
      const range = findVideoRange(start, end);
      if (!range) throw new Error('선택한 기간에 재생할 프레임이 2개 이상 필요합니다.');
      setIsPlaying(false);
      if (cases?.kind === 'rain') await ensureRainIndex(range.startIndex);
      setFrameIndex(range.startIndex);
    },
    [cases?.kind, ensureRainIndex, findVideoRange],
  );

  const handleVideoStart = useCallback(
    ({ start, end, durationSec }) => {
      const range = findVideoRange(start, end);
      if (!range) return;
      const transitions = Math.max(1, range.endIndex - range.startIndex);
      setFrameIndex(range.startIndex);
      setPlayIntervalMs(Math.max(80, Math.round((durationSec * 1000) / transitions)));
      requestAnimationFrame(() => setIsPlaying(true));
    },
    [findVideoRange],
  );

  const handleKindChange = (nextKind) => {
    if (nextKind === kind) return;
    setKind(nextKind);
    setDurationHours(nextKind === 'rain' ? 3 : 6);
    setCases(null);
    setStatus('idle');
    setError('');
    setWarning('종료 시각과 기간을 확인한 뒤 적용을 눌러 주세요.');
    setIsPlaying(false);
  };

  const handlePlay = () => {
    if (status !== 'ready' || frameCount < 2) return;
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (frameIndex >= frameCount - 1) {
      setFrameIndex(0);
    }
    setPlayIntervalMs(PLAY_INTERVAL_MS);
    requestAnimationFrame(() => setIsPlaying(true));
  };

  const handleDividerPointerDown = (event) => {
    if (layout !== 'swipe') return;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleDividerPointerMove = (event) => {
    if (layout !== 'swipe' || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const next = ((event.clientX - bounds.left) / bounds.width) * 100;
    setSplitPercent(Math.min(82, Math.max(18, next)));
  };

  const mapPane = (caseId) => {
    const isCurrent = caseId === 'current';
    return (
      <div className="relative h-full min-w-0 overflow-hidden bg-[#46536a]">
        <ComparisonMapPane
          caseId={caseId}
          kind={kind}
          radarFrame={isCurrent ? currentRadarFrame : historicalRadarFrame}
          rainTotals={isCurrent ? cases?.current?.totals : cases?.historical?.totals}
          temperatureFrame={isCurrent ? currentTemperatureFrame : historicalTemperatureFrame}
          stations={stations}
          showPlaceLabels={showPlaceLabels}
          onMapReady={onMapReady}
          onCameraChange={onCameraChange}
        />
        <div
          className={`pointer-events-none absolute top-5 z-20 rounded-md border px-4 py-2 shadow-xl backdrop-blur-md ${
            isCurrent
              ? 'left-5 border-cyan-200/35 bg-cyan-950/76 text-cyan-50'
              : 'right-5 border-amber-200/35 bg-amber-950/76 text-amber-50'
          }`}
        >
          <div className="text-[10px] font-black tracking-wide text-white/60">
            {isCurrent ? '현재 사례' : '과거 사례'}
          </div>
          <div className="mt-0.5 text-base font-black tabular-nums">
            {formatCaseTime(isCurrent ? currentTime : historicalTime)}
          </div>
        </div>
      </div>
    );
  };

  const durationOptions = kind === 'rain' ? RAIN_DURATION_OPTIONS : HEAT_DURATION_OPTIONS;
  const progress = frameCount > 1 ? (frameIndex / (frameCount - 1)) * 100 : 0;
  const isPlaybackPreparing =
    cases?.kind === 'rain' &&
    preloadProgress.total > 0 &&
    preloadProgress.done < preloadProgress.total;

  return (
    <div ref={rootRef} className="absolute inset-0 z-30 overflow-hidden bg-[#46536a] text-white">
      <div className={layout === 'side' ? 'grid h-full grid-cols-2 gap-px bg-white/25' : 'relative h-full'}>
        {layout === 'side' ? (
          <>
            {mapPane('current')}
            {mapPane('historical')}
          </>
        ) : (
          <>
            <div className="absolute inset-0">{mapPane('current')}</div>
            <div
              className="absolute inset-0"
              style={{ clipPath: `inset(0 0 0 ${splitPercent}%)` }}
            >
              {mapPane('historical')}
            </div>
            <div
              className="absolute inset-y-0 z-30 w-1 -translate-x-1/2 cursor-ew-resize bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.65),0_0_18px_rgba(15,23,42,0.8)]"
              style={{ left: `${splitPercent}%`, touchAction: 'none' }}
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              role="separator"
              aria-label="현재와 과거 지도 비교 경계"
              aria-valuenow={Math.round(splitPercent)}
            >
              <div className="absolute left-1/2 top-1/2 flex h-14 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-white/35 bg-slate-950/85 shadow-xl">
                <span className="text-base font-black text-white/85">↔</span>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="pointer-events-none absolute left-[4.4%] top-[9%] z-40">
        <div className="relative flex h-20 w-[620px] max-w-[72vw] items-center gap-4 overflow-hidden rounded-md bg-gradient-to-r from-[#0a3070]/95 via-[#155bb5]/95 to-[#2f7cd6]/95 px-5 shadow-2xl">
          <div className="flex flex-col leading-none"><span className="text-sm font-black">KBS</span><span className="mt-1 text-[10px] font-bold text-white/75">WEATHER</span></div>
          <span className="whitespace-nowrap text-3xl font-black">과거 사례 비교</span>
          <div className="ml-auto flex shrink-0 flex-col items-center whitespace-nowrap border-l border-white/30 pl-4 leading-tight text-[#bdd6fb]">
            <span className="text-[11px] font-bold">{kind === 'rain' ? '레이더 · AWS' : 'AWS 기온'}</span>
            <span className="text-[11px] font-bold tabular-nums">{kind === 'rain' ? `${durationHours}시간 누적` : `${durationHours}시간 변화`}</span>
          </div>
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-[#8ec2ff]" />
        </div>
      </div>

      {status === 'ready' ? (
        <div className="pointer-events-none absolute left-1/2 top-[9%] z-40 -translate-x-1/2 translate-y-[94px]">
          <MetricPanel metrics={metrics} />
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/32 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-md border border-white/15 bg-slate-950/85 px-5 py-4 text-sm font-black shadow-2xl">
            <RefreshCw className="h-5 w-5 animate-spin text-cyan-300" />
            관측 자료를 맞춰 불러오는 중입니다
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="absolute left-1/2 top-1/2 z-50 w-[min(520px,80vw)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-rose-300/35 bg-slate-950/92 p-5 text-center shadow-2xl">
          <div className="font-black text-rose-200">{error}</div>
          <button
            type="button"
            onClick={() => loadCases(kind)}
            className="mt-4 h-10 rounded-md bg-white px-4 text-sm font-black text-slate-950 transition hover:bg-slate-100"
          >
            다시 시도
          </button>
        </div>
      ) : null}

      {workspaceMode !== 'broadcast' ? (
        <div data-video-hide className="absolute bottom-[8.8rem] right-6 z-50 flex flex-col items-end gap-2">
          {menuSlot}
          <div className="w-[min(430px,calc(100vw-3rem))] rounded-md border border-white/18 bg-slate-950/88 p-3 shadow-2xl backdrop-blur-md">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 grid grid-cols-2 rounded-md border border-white/12 bg-white/5 p-1">
                <button
                  type="button"
                  onClick={() => handleKindChange('rain')}
                  className={`flex h-9 items-center justify-center gap-2 rounded text-xs font-black transition ${kind === 'rain' ? 'bg-cyan-400 text-slate-950' : 'text-white/65 hover:bg-white/10'}`}
                >
                  <Gauge className="h-4 w-4" /> 호우
                </button>
                <button
                  type="button"
                  onClick={() => handleKindChange('heat')}
                  className={`flex h-9 items-center justify-center gap-2 rounded text-xs font-black transition ${kind === 'heat' ? 'bg-orange-400 text-slate-950' : 'text-white/65 hover:bg-white/10'}`}
                >
                  <Flame className="h-4 w-4" /> 폭염
                </button>
              </div>
              <label className="flex flex-col gap-1 text-[11px] font-bold text-white/60">
                현재 사례 종료
                <input
                  type="datetime-local"
                  value={currentEndInput}
                  max={formatDateTimeInput(now)}
                  onChange={(event) => setCurrentEndInput(event.target.value)}
                  className="h-9 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white outline-none [color-scheme:dark] focus:border-cyan-300"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-bold text-white/60">
                과거 사례 종료
                <input
                  type="datetime-local"
                  value={historicalEndInput}
                  max={formatDateTimeInput(now)}
                  onChange={(event) => setHistoricalEndInput(event.target.value)}
                  className="h-9 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white outline-none [color-scheme:dark] focus:border-cyan-300"
                />
              </label>
              <div className="flex h-9 items-center rounded-md border border-white/12 bg-white/5 p-1">
                {durationOptions.map((hours) => (
                  <button
                    key={hours}
                    type="button"
                    onClick={() => setDurationHours(hours)}
                    className={`h-7 flex-1 rounded text-[11px] font-black transition ${durationHours === hours ? 'bg-white text-slate-950' : 'text-white/60 hover:bg-white/10'}`}
                  >
                    {hours}시간
                  </button>
                ))}
              </div>
              <div className="grid h-9 grid-cols-2 rounded-md border border-white/12 bg-white/5 p-1">
                <button
                  type="button"
                  onClick={() => setLayout('side')}
                  title="나란히 비교"
                  className={`flex items-center justify-center gap-1.5 rounded text-[11px] font-black transition ${layout === 'side' ? 'bg-emerald-400 text-slate-950' : 'text-white/60 hover:bg-white/10'}`}
                >
                  <Columns2 className="h-3.5 w-3.5" /> 나란히
                </button>
                <button
                  type="button"
                  onClick={() => setLayout('swipe')}
                  title="경계 밀어 비교"
                  className={`flex items-center justify-center gap-1.5 rounded text-[11px] font-black transition ${layout === 'swipe' ? 'bg-emerald-400 text-slate-950' : 'text-white/60 hover:bg-white/10'}`}
                >
                  <Layers2 className="h-3.5 w-3.5" /> 겹쳐보기
                </button>
              </div>
              <button
                type="button"
                onClick={() => loadCases(kind)}
                disabled={status === 'loading'}
                className="col-span-2 flex h-10 items-center justify-center gap-2 rounded-md bg-cyan-400 text-sm font-black text-slate-950 transition hover:bg-cyan-300 disabled:opacity-50"
              >
                <CalendarClock className="h-4 w-4" /> 비교 자료 적용
              </button>
              {warning ? <div className="col-span-2 text-[11px] font-semibold text-amber-200">{warning}</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {workspaceMode === 'record' ? (
        <VideoExportMenu
          currentTarget="history"
          mapRef={primaryMapRef}
          defaultStart={videoDefaultStart}
          defaultEnd={videoDefaultEnd}
          onBeforeScreenShare={onBeforeScreenShare}
          onPreparePlayback={handleVideoPrepare}
          onStartPlayback={handleVideoStart}
        />
      ) : null}

      <div data-video-hide className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-slate-950/82 via-slate-950/48 to-transparent px-[8%] pb-5 pt-12">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handlePlay}
            disabled={status !== 'ready' || frameCount < 2 || isPlaybackPreparing}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#0b4bc2] text-white shadow-xl transition hover:bg-blue-500 disabled:opacity-40"
            aria-label={isPlaying ? '일시정지' : '재생'}
          >
            {isPlaying ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center justify-between text-xs font-black tabular-nums text-white/80">
              <span>
                {isPlaybackPreparing
                  ? `재생 준비 ${preloadProgress.done} / ${preloadProgress.total}`
                  : `경과 ${frameIndex + 1} / ${Math.max(frameCount, 1)}`}
              </span>
              <span>{formatShortTime(currentTime)} · {formatShortTime(historicalTime)}</span>
            </div>
            <input
              type="range"
              min="0"
              max={Math.max(0, frameCount - 1)}
              value={Math.min(frameIndex, Math.max(0, frameCount - 1))}
              onChange={(event) => {
                setIsPlaying(false);
                setFrameIndex(Number(event.target.value));
              }}
              disabled={frameCount < 2}
              className="broadcast-radar-range h-2 w-full cursor-pointer appearance-none rounded-full bg-white/35 accent-blue-500 disabled:opacity-40"
              style={{ background: `linear-gradient(to right, #38bdf8 0%, #38bdf8 ${progress}%, rgba(255,255,255,0.35) ${progress}%, rgba(255,255,255,0.35) 100%)` }}
              aria-label="사례 비교 경과 시각"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default HistoricalCaseComparison;
