import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import krProvinces from '../data/map/krProvinces.json';
import interKoreanSeam from '../data/map/interKoreanSeam.json';
import neighborCoasts from '../data/map/neighborCoasts.json';
import { formatStationLabel } from '../api/accumApi';
import { fetchHeatwaveBroadcastData } from '../api/heatwaveApi';

const VIEW_BOUNDS = { lonMin: 120.18, lonMax: 133.56, latMin: 30.1, latMax: 43.34 };
const GRID_WIDTH = 576;
const GRID_HEIGHT = 715;
const GRID_NEIGHBORS = 6;
const GRID_BUCKET_SIZE = 16;
const COLUMN_STRIDE = 2;
const OVERLAY_ALPHA = 218;
const TEMPERATURE_SOURCE_ID = 'heat-temperature-columns';
const TEMPERATURE_LAYER_ID = 'heat-temperature-columns-layer';

const ADMIN_SOURCE_DEFINITIONS = {
  'heat-sido': '/data/map/kr-sido-20260701.geojson',
  'heat-sgg': '/data/map/kr-sgg-20260701.geojson',
  'heat-emd': '/data/map/kr-emd-20260701.geojson',
  'heat-sido-labels': '/data/map/kr-sido-labels-20260701.geojson',
  'heat-sgg-labels': '/data/map/kr-sgg-labels-20260701.geojson',
  'heat-emd-labels': '/data/map/kr-emd-labels-20260701.geojson',
};

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
  const baseHeight = mode === 'tropical'
    ? Math.min(105000, 3500 + Math.max(0, value - 25) * 14500)
    : Math.min(115000, 2400 + Math.max(0, value - 12) * 4000);
  return baseHeight * 2;
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

const ScaleBar = ({ mode }) => {
  const palette = mode === 'tropical' ? TROPICAL_PALETTE : HEAT_PALETTE;
  const labels = mode === 'tropical' ? [18, 22, 25, 27, 30, 33] : [15, 24, 30, 33, 35, 40, 43];
  const min = palette[0].value;
  const max = palette.at(-1).value;
  return (
    <div
      className="pointer-events-none absolute left-5 z-20 rounded-lg bg-slate-900/50 px-2 py-2.5 shadow-lg backdrop-blur-sm"
      style={{ top: 'calc(50% - max(23vh, 140px) - 18.5px)' }}
    >
      <div className="flex h-[46vh] min-h-[280px]">
        <div
          className="w-3 rounded-sm"
          style={{
            background: `linear-gradient(to top, ${palette
              .map(({ color }) => `rgb(${color.join(',')})`)
              .join(', ')})`,
          }}
        />
        <div className="relative ml-2 w-8">
          {labels.map((value) => (
            <span
              key={value}
              className="absolute -translate-y-1/2 text-[10px] font-bold leading-none text-white"
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
  const landMaskRef = useRef(null);
  const [mode, setMode] = useState('tropical');
  const [dataset, setDataset] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  const palette = mode === 'tropical' ? TROPICAL_PALETTE : HEAT_PALETTE;
  const top5 = useMemo(() => {
    if (!dataset) return [];
    return [...dataset.observations]
      .filter(
        (row) =>
          mode === 'heat' ||
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
      dragRotate: false,
      pitchWithRotate: true,
      touchPitch: true,
      localIdeographFontFamily: '"Noto Sans KR", "Malgun Gothic", sans-serif',
    });
    map.dragRotate._mousePitch?.enable();
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    if (import.meta.env.DEV) {
      window.__heatwaveMap = map;
    }

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = GRID_WIDTH;
    overlayCanvas.height = GRID_HEIGHT;
    overlayCanvasRef.current = overlayCanvas;
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

    const handleEscape = (event) => {
      if (event.key !== 'Escape') return;
      if (window.history.length > 1) window.history.back();
      else window.location.href = '/';
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchHeatwaveBroadcastData(mode, {
      refreshToken: refreshToken ? `${Date.now()}` : '',
    })
      .then((result) => {
        if (!active) return;
        setDataset(result);
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
  }, [mode, refreshToken]);

  const handleModeChange = useCallback((nextMode) => {
    setDataset(null);
    setStatus('loading');
    setError('');
    setMode(nextMode);
  }, []);

  const handleRefresh = useCallback(() => {
    setStatus('loading');
    setError('');
    setRefreshToken((value) => value + 1);
  }, []);

  const renderDataset = useCallback(() => {
    const map = mapRef.current;
    const canvas = overlayCanvasRef.current;
    const landMask = landMaskRef.current;
    if (!map?.isStyleLoaded() || !dataset || !canvas || !landMask) return false;
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
    const halfCell = COLUMN_STRIDE * 0.505;
    for (let y = Math.floor(COLUMN_STRIDE / 2); y < GRID_HEIGHT; y += COLUMN_STRIDE) {
      for (let x = Math.floor(COLUMN_STRIDE / 2); x < GRID_WIDTH; x += COLUMN_STRIDE) {
        const index = y * GRID_WIDTH + x;
        const value = values[index];
        if (!landMask[index] || value < -40 || (mode === 'tropical' && value < 25)) continue;
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
    map.getSource(TEMPERATURE_SOURCE_ID)?.setData({
      type: 'FeatureCollection',
      features,
    });
    map.triggerRepaint();
    return true;
  }, [dataset, mode, palette]);

  useEffect(() => {
    if (status !== 'ready') return undefined;
    const timer = window.setInterval(() => {
      if (renderDataset()) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [renderDataset, status]);

  useEffect(() => {
    const timer = window.setInterval(handleRefresh, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [handleRefresh]);

  return (
    <section className="fixed inset-0 overflow-hidden bg-[#46536a] text-white">
      <div className="absolute inset-0">
        <div ref={mapContainerRef} className="h-full w-full" aria-label="폭염 방송 지도" />
      </div>

      {status === 'loading' ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/25 text-xl font-bold">
          {mode === 'tropical' ? '열대야' : '폭염'} 관측 자료를 불러오는 중입니다…
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
            {mode === 'tropical' ? '열대야 현황' : '오늘 최고기온'}
          </span>
          {dataset ? (
            <div className="ml-auto flex shrink-0 flex-col items-end whitespace-nowrap">
              <span className="font-black tabular-nums" style={{ fontSize: 'clamp(16px, 1.2vw, 26px)' }}>
                {dataset.observedAtCode.slice(8, 10)}:{dataset.observedAtCode.slice(10, 12)}
              </span>
              <span className="text-xs font-semibold text-[#bdd6fb]">
                {Number(dataset.observedAtCode.slice(4, 6))}/{Number(dataset.observedAtCode.slice(6, 8))}
              </span>
            </div>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-[#3d86e8] to-[#8ec2ff]" />
        </div>
      </div>

      {top5.length > 0 ? (
        <div
          className="pointer-events-none absolute z-20 flex justify-center"
          style={{
            left: '4.4%',
            top: 'calc(50% - max(23vh, 140px) - 18.5px)',
            width: 'clamp(430px, 29vw, 700px)',
          }}
        >
          <div className="overflow-hidden rounded-md bg-slate-900/60 shadow-xl backdrop-blur-sm" style={{ width: 'clamp(320px, 22vw, 500px)' }}>
            <div className="border-b border-white/15 px-5 py-2 text-sm font-black text-white/80">
              {mode === 'tropical' ? '열대야 순위 · ASOS' : '최고기온 순위 · ASOS+AWS'}
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

      <ScaleBar mode={mode} />

      {dataset ? (
        <div className="pointer-events-none absolute bottom-5 left-5 z-20 max-w-[46vw] rounded-lg bg-slate-900/55 px-4 py-2 text-sm font-semibold text-white/85 shadow-lg backdrop-blur-sm">
          <span className="font-black text-white">{dataset.windowLabel}</span>
          <span className="mx-2 text-white/35">|</span>
          {dataset.note}
        </div>
      ) : null}

      <div className="absolute bottom-6 right-6 z-30 flex items-center gap-2">
        <div className="flex h-12 items-center rounded-full border border-white/20 bg-slate-950/75 p-1 shadow-xl backdrop-blur-sm">
          {[
            { id: 'tropical', label: '열대야' },
            { id: 'heat', label: '폭염' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleModeChange(item.id)}
              aria-pressed={mode === item.id}
              className={`h-10 rounded-full px-5 text-sm font-black transition ${
                mode === item.id
                  ? item.id === 'tropical'
                    ? 'bg-[#2875d9] text-white'
                    : 'bg-[#ef6c32] text-white'
                  : 'text-white/65 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
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
    </section>
  );
};

export default HeatwaveBroadcastView;
