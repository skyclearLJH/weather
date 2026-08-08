import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Columns2,
  Gauge,
  Globe2,
  Grid2X2,
  Layers3,
  LoaderCircle,
  MapPin,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchGlobalModelBundle,
  fetchGlobalModelMetadata,
  fetchGlobalModelTile,
  fetchKimPressure,
  warmGlobalModelCache,
} from '../api/globalModelApi.js';
import { buildPressureFeatures } from '../utils/modelPressure.js';
import VideoExportMenu from './VideoExportMenu.jsx';

const MODEL_IDS = ['kim-global', 'ifs', 'aifs', 'gfs'];
const MODEL_META = {
  'kim-global': { label: 'KIM 전구', short: 'KIM', color: '#22d3ee' },
  ifs: { label: 'ECMWF IFS', short: 'IFS', color: '#facc15' },
  aifs: { label: 'ECMWF AIFS', short: 'AIFS', color: '#f472b6' },
  gfs: { label: 'NOAA GFS', short: 'GFS', color: '#4ade80' },
};
const BASE_STYLE = 'https://demotiles.maplibre.org/style.json';
const CANVAS_WIDTH = 1024;
const MISSING_VALUE = 65535;
const WORLD_VIEWPORT = [-179.5, -79.5, 179.5, 79.5];
const PLAY_DURATIONS = [5, 8, 10, 12, 15, 20, 30];
const EMPTY_FEATURES = { type: 'FeatureCollection', features: [] };
const PALETTE = [
  { min: 0.1, color: [65, 197, 255] },
  { min: 0.5, color: [26, 151, 240] },
  { min: 1, color: [22, 199, 132] },
  { min: 3, color: [84, 210, 71] },
  { min: 5, color: [241, 220, 50] },
  { min: 10, color: [255, 147, 37] },
  { min: 20, color: [245, 65, 54] },
  { min: 30, color: [220, 52, 166] },
  { min: 50, color: [155, 55, 212] },
  { min: 70, color: [67, 42, 173] },
];

const mercatorY = (latitude) => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
const mercatorYToLat = (value) => ((2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180) / Math.PI;
const formatTime = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const formatDate = (date) => `${date.getMonth() + 1}/${date.getDate()} (${['일', '월', '화', '수', '목', '금', '토'][date.getDay()]})`;
const round = (value, precision = 2) => Number(value.toFixed(precision));

const stepForZoom = (zoom) => {
  if (zoom < 2) return 5;
  if (zoom < 2.8) return 2.5;
  if (zoom < 3.8) return 1;
  if (zoom < 4.8) return 0.5;
  if (zoom < 6.2) return 0.25;
  return 0.125;
};

const viewportForMap = (map) => {
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const step = stepForZoom(zoom);
  if (zoom < 2) {
    return {
      bbox: WORLD_VIEWPORT,
      step,
      zoom: round(zoom, 1),
      key: `${WORLD_VIEWPORT.join(',')}@${step}`,
    };
  }
  const rawSpan = bounds.getEast() - bounds.getWest();
  let lonMin;
  let lonMax;
  if (rawSpan >= 350) {
    lonMin = -179.5;
    lonMax = 179.5;
  } else {
    lonMin = Math.max(-179.5, bounds.getWest() - step * 2);
    lonMax = Math.min(179.5, bounds.getEast() + step * 2);
    if (lonMax <= lonMin) {
      lonMin = -179.5;
      lonMax = 179.5;
    }
  }
  const latMin = Math.max(-79.5, bounds.getSouth() - step * 2);
  const latMax = Math.min(79.5, bounds.getNorth() + step * 2);
  const bbox = [
    Math.floor(lonMin / step) * step,
    Math.floor(latMin / step) * step,
    Math.ceil(lonMax / step) * step,
    Math.ceil(latMax / step) * step,
  ].map((value, index) => round(index < 2 ? Math.max(index ? -80 : -180, value) : Math.min(index === 2 ? 180 : 80, value), 3));
  return { bbox, step, zoom: round(zoom, 1), key: `${bbox.join(',')}@${step}` };
};

const colorForEncoded = (encoded) => {
  const value = encoded / 100;
  let color = null;
  for (const entry of PALETTE) {
    if (value >= entry.min) color = entry.color;
    else break;
  }
  return color;
};

const buildCanvasMapping = (width, height, grid) => {
  const yTop = mercatorY(grid.latMax);
  const yBottom = mercatorY(grid.latMin);
  const baseIndex = new Int32Array(width * height).fill(-1);
  const fractionX = new Uint8Array(width * height);
  const fractionY = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const latitude = mercatorYToLat(yTop - ((y + 0.5) / height) * (yTop - yBottom));
    const gridY = (grid.latMax - latitude) / grid.step;
    const top = Math.floor(gridY);
    if (top < 0 || top + 1 >= grid.height) continue;
    for (let x = 0; x < width; x += 1) {
      const longitude = grid.lonMin + ((x + 0.5) / width) * (grid.lonMax - grid.lonMin);
      const gridX = (longitude - grid.lonMin) / grid.step;
      const left = Math.floor(gridX);
      if (left < 0 || left + 1 >= grid.width) continue;
      const index = y * width + x;
      baseIndex[index] = top * grid.width + left;
      fractionX[index] = Math.round((gridX - left) * 255);
      fractionY[index] = Math.round((gridY - top) * 255);
    }
  }
  return { baseIndex, fractionX, fractionY };
};

const sampleGrid = (values, frameOffset, sourceIndex, fxByte, fyByte, gridWidth) => {
  if (!values || sourceIndex < 0) return MISSING_VALUE;
  const bottomIndex = sourceIndex + gridWidth;
  const samples = [sourceIndex, sourceIndex + 1, bottomIndex, bottomIndex + 1]
    .map((index) => values[frameOffset + index]);
  if (samples.some((value) => value === MISSING_VALUE || !Number.isFinite(value))) return MISSING_VALUE;
  const fx = fxByte / 255;
  const fy = fyByte / 255;
  const top = samples[0] * (1 - fx) + samples[1] * fx;
  const bottom = samples[2] * (1 - fx) + samples[3] * fx;
  return Math.round(top * (1 - fy) + bottom * fy);
};

const nearestGridIndex = (point, grid) => {
  const column = Math.round((point.lon - grid.lonMin) / grid.step);
  const row = Math.round((grid.latMax - point.lat) / grid.step);
  return column < 0 || column >= grid.width || row < 0 || row >= grid.height ? -1 : row * grid.width + column;
};

const modelForPixel = (layout, x, y, width, height, splitPercent, leftModel, rightModel) => {
  if (layout === 'split') return x < (width * splitPercent) / 100 ? leftModel : rightModel;
  if (x < width / 2 && y < height / 2) return 'kim-global';
  if (x >= width / 2 && y < height / 2) return 'ifs';
  if (x < width / 2) return 'aifs';
  return 'gfs';
};

function ModelPointChart({ tiles, times, frameIndex, point }) {
  const chart = useMemo(() => {
    if (!point || !times?.length) return null;
    const series = MODEL_IDS.flatMap((modelId) => {
      const tile = tiles[modelId];
      if (!tile?.rain?.available) return [];
      const gridIndex = nearestGridIndex(point, tile.grid);
      if (gridIndex < 0) return [];
      const pointCount = tile.grid.width * tile.grid.height;
      return [{
        modelId,
        values: times.map((_, index) => {
          const value = tile.rain.values[index * pointCount + gridIndex];
          return value === MISSING_VALUE ? null : value / 100;
        }),
      }];
    });
    if (!series.length) return null;
    return { series, maximum: Math.max(5, ...series.flatMap((entry) => entry.values.filter(Number.isFinite))) };
  }, [point, tiles, times]);
  if (!chart) return null;
  const width = 430;
  const height = 142;
  const plotHeight = 112;
  const xOf = (index) => (index / Math.max(1, times.length - 1)) * width;
  const yOf = (value) => 10 + plotHeight - (value / chart.maximum) * plotHeight;
  return (
    <div className="pointer-events-auto absolute bottom-28 left-[8%] z-30 w-[470px] rounded-md border border-white/20 bg-slate-950/88 p-4 text-white shadow-2xl backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-black"><MapPin className="h-4 w-4 text-cyan-300" />{point.lat.toFixed(2)}°N, {point.lon.toFixed(2)}°E</div>
        <span className="text-xs font-bold text-white/55">6시간 누적 강수량</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[142px] w-full" aria-label="모델별 예상 강수량 그래프">
        {[0, 0.5, 1].map((ratio) => <line key={ratio} x1="0" x2={width} y1={10 + plotHeight * ratio} y2={10 + plotHeight * ratio} stroke="rgba(255,255,255,0.15)" />)}
        <line x1={xOf(frameIndex)} x2={xOf(frameIndex)} y1="10" y2={122} stroke="rgba(255,255,255,0.75)" />
        {chart.series.map(({ modelId, values }) => {
          const path = values.reduce((result, value, index) => Number.isFinite(value) ? `${result}${result ? 'L' : 'M'}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}` : result, '');
          return path ? <path key={modelId} d={path} fill="none" stroke={MODEL_META[modelId].color} strokeWidth="2.2" strokeLinejoin="round" /> : null;
        })}
      </svg>
      <div className="mt-1 grid grid-cols-4 gap-2">
        {chart.series.map(({ modelId, values }) => <div key={modelId} className="min-w-0 border-l-2 pl-2" style={{ borderColor: MODEL_META[modelId].color }}><div className="truncate text-[10px] font-bold text-white/55">{MODEL_META[modelId].short}</div><div className="text-sm font-black tabular-nums">{Number.isFinite(values[frameIndex]) ? values[frameIndex].toFixed(1) : '-'}<span className="ml-0.5 text-[9px] text-white/55">mm</span></div></div>)}
      </div>
    </div>
  );
}

function GlobalModelView({ activeView, workspaceMode, showPlaceLabels, menuSlot, onBeforeScreenShare }) {
  const mapContainerRef = useRef(null);
  const shellRef = useRef(null);
  const mapRef = useRef(null);
  const canvasRef = useRef(null);
  const mappingRef = useRef(null);
  const markerRef = useRef(null);
  const baseLabelLayersRef = useRef([]);
  const [metadata, setMetadata] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [tiles, setTiles] = useState({});
  const [status, setStatus] = useState('loading');
  const [tileLoading, setTileLoading] = useState(false);
  const [error, setError] = useState('');
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(39);
  const [compareLayout, setCompareLayout] = useState('split');
  const [leftModel, setLeftModel] = useState('kim-global');
  const [rightModel, setRightModel] = useState('ifs');
  const [splitPercent, setSplitPercent] = useState(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [showConsensus, setShowConsensus] = useState(true);
  const [showPressure, setShowPressure] = useState(true);
  const [pressureModel, setPressureModel] = useState('kim-global');
  const [kimPressure, setKimPressure] = useState(null);
  const [kimWarmProgress, setKimWarmProgress] = useState(null);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const isCompare = activeView === 'compare';
  const times = metadata?.times ?? [];
  const visibleModels = useMemo(() => isCompare ? MODEL_IDS : [activeView], [activeView, isCompare]);
  const contourModel = isCompare ? pressureModel : activeView;

  useEffect(() => {
    const controller = new AbortController();
    fetchGlobalModelMetadata({ signal: controller.signal })
      .then((next) => {
        setMetadata(next);
        setFrameIndex(0);
        setRangeStart(0);
        setRangeEnd(next.times.length - 1);
        setStatus('ready');
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(loadError.message);
        setStatus('error');
      });
    return () => controller.abort();
  }, [refreshTick]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: BASE_STYLE,
      center: [126, 33],
      zoom: 1.7,
      minZoom: 0.7,
      maxZoom: 8,
      attributionControl: false,
      localIdeographFontFamily: '"Noto Sans KR", "Malgun Gothic", sans-serif',
      dragRotate: true,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    const updateViewport = () => setViewport(viewportForMap(map));
    map.on('load', () => {
      map.setProjection({ type: 'globe' });
      baseLabelLayersRef.current = (map.getStyle().layers ?? []).filter((layer) => layer.type === 'symbol').map((layer) => layer.id);
      const beforeId = baseLabelLayersRef.current[0];
      map.addSource('global-isobars', { type: 'geojson', data: EMPTY_FEATURES });
      map.addSource('global-pressure-centers', { type: 'geojson', data: EMPTY_FEATURES });
      map.addLayer({
        id: 'global-isobars-line', type: 'line', source: 'global-isobars',
        paint: {
          'line-color': 'rgba(255,255,255,0.9)',
          'line-width': ['case', ['==', ['get', 'major'], 1], 1.8, 1],
          'line-opacity': 0.9,
        },
      }, beforeId);
      map.addLayer({
        id: 'global-isobars-label', type: 'symbol', source: 'global-isobars',
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 280,
          'text-field': ['to-string', ['get', 'level']], 'text-size': 12,
          'text-allow-overlap': false, 'text-padding': 3,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#243148', 'text-halo-width': 1.4 },
      });
      map.addLayer({
        id: 'global-pressure-centers-label', type: 'symbol', source: 'global-pressure-centers',
        layout: {
          'text-field': ['concat', ['get', 'kind'], '\n', ['to-string', ['get', 'value']]],
          'text-size': 19, 'text-font': ['Open Sans Bold'], 'text-line-height': 0.9,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': ['case', ['==', ['get', 'kind'], 'H'], '#ff4d61', '#4cc9ff'],
          'text-halo-color': 'rgba(10,20,36,0.94)', 'text-halo-width': 2.2,
        },
      });
      updateViewport();
    });
    map.on('moveend', updateViewport);
    map.on('click', ({ lngLat }) => setSelectedPoint({ lon: lngLat.lng, lat: lngLat.lat }));
    return () => {
      markerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.loaded()) return;
    baseLabelLayersRef.current.forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', showPlaceLabels ? 'visible' : 'none');
    });
  }, [showPlaceLabels, viewport]);

  useEffect(() => {
    if (!metadata || !viewport) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTileLoading(true);
      setError('');
      const requests = isCompare
        ? fetchGlobalModelBundle({
            bbox: viewport.bbox,
            step: viewport.step,
            cycle: metadata.cycle,
            signal: controller.signal,
          }).then((bundle) => MODEL_IDS.map((model) => [model, bundle.models[model]]))
        : Promise.all(visibleModels.map(async (model) => [model, await fetchGlobalModelTile({
            model,
            bbox: viewport.bbox,
            step: viewport.step,
            cycle: metadata.cycle,
            signal: controller.signal,
          })]));
      requests
        .then((entries) => entries.map((entry) => ({ status: 'fulfilled', value: entry })))
        .catch((reason) => visibleModels.map(() => ({ status: 'rejected', reason })))
        .then((results) => {
          if (controller.signal.aborted) return;
          const nextTiles = {};
          const failures = [];
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') nextTiles[result.value[0]] = result.value[1];
            else failures.push(`${MODEL_META[visibleModels[index]].short}: ${result.reason.message}`);
          });
          setTiles(nextTiles);
          if (!Object.keys(nextTiles).length) setError(failures.join(' / '));
          else if (failures.length) setError(failures.join(' / '));
        })
        .finally(() => { if (!controller.signal.aborted) setTileLoading(false); });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isCompare, metadata, refreshTick, viewport, visibleModels]);

  useEffect(() => {
    const kimRain = tiles['kim-global']?.rain;
    if (kimRain?.available) return undefined;
    if (!kimRain?.cacheProgress) return undefined;
    const controller = new AbortController();
    let active = true;
    const warm = async () => {
      let progress = kimRain.cacheProgress;
      while (active && !controller.signal.aborted) {
        const result = await warmGlobalModelCache({ signal: controller.signal });
        progress = { count: result.frames, total: result.totalFrames };
        if (!active) return;
        setKimWarmProgress(progress);
        if (result.ready) {
          setRefreshTick((value) => value + 1);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
    };
    warm().catch(() => {});
    return () => { active = false; controller.abort(); };
  }, [tiles]);

  const primaryTile = tiles[visibleModels.find((model) => tiles[model])] ?? null;
  const canvasHeight = useMemo(() => {
    if (!primaryTile) return 620;
    const ySpan = Math.abs(mercatorY(primaryTile.grid.latMax) - mercatorY(primaryTile.grid.latMin));
    const xSpan = Math.max(0.01, ((primaryTile.grid.lonMax - primaryTile.grid.lonMin) * Math.PI) / 180);
    return Math.max(240, Math.min(1100, Math.round((CANVAS_WIDTH * ySpan) / xSpan)));
  }, [primaryTile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.loaded() || !primaryTile) return undefined;
    if (map.getLayer('global-model-overlay')) map.removeLayer('global-model-overlay');
    if (map.getSource('global-model-overlay')) map.removeSource('global-model-overlay');
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = canvasHeight;
    canvasRef.current = canvas;
    mappingRef.current = buildCanvasMapping(CANVAS_WIDTH, canvasHeight, primaryTile.grid);
    const beforeId = baseLabelLayersRef.current.find((layerId) => map.getLayer(layerId));
    map.addSource('global-model-overlay', {
      type: 'canvas', canvas, animate: false,
      coordinates: [
        [primaryTile.grid.lonMin, primaryTile.grid.latMax],
        [primaryTile.grid.lonMax, primaryTile.grid.latMax],
        [primaryTile.grid.lonMax, primaryTile.grid.latMin],
        [primaryTile.grid.lonMin, primaryTile.grid.latMin],
      ],
    });
    map.addLayer({
      id: 'global-model-overlay', type: 'raster', source: 'global-model-overlay',
      paint: { 'raster-opacity': 0.88, 'raster-resampling': 'linear' },
    }, beforeId);
    return () => {
      canvasRef.current = null;
      mappingRef.current = null;
    };
  }, [canvasHeight, primaryTile]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const mapping = mappingRef.current;
    const map = mapRef.current;
    if (!canvas || !mapping || !map || !primaryTile) return;
    const context = canvas.getContext('2d');
    const image = context.createImageData(canvas.width, canvas.height);
    const pixels = image.data;
    const pointCount = primaryTile.grid.width * primaryTile.grid.height;
    const frameOffset = frameIndex * pointCount;
    const allReady = MODEL_IDS.every((model) => tiles[model]?.rain?.available);
    for (let index = 0; index < mapping.baseIndex.length; index += 1) {
      const sourceIndex = mapping.baseIndex[index];
      if (sourceIndex < 0) continue;
      const x = index % canvas.width;
      const y = Math.floor(index / canvas.width);
      const model = isCompare ? modelForPixel(compareLayout, x, y, canvas.width, canvas.height, splitPercent, leftModel, rightModel) : activeView;
      const tile = tiles[model];
      if (!tile?.rain?.available) continue;
      const value = sampleGrid(tile.rain.values, frameOffset, sourceIndex, mapping.fractionX[index], mapping.fractionY[index], primaryTile.grid.width);
      const color = value === MISSING_VALUE ? null : colorForEncoded(value);
      if (!color) continue;
      const pixelOffset = index * 4;
      pixels[pixelOffset] = color[0];
      pixels[pixelOffset + 1] = color[1];
      pixels[pixelOffset + 2] = color[2];
      pixels[pixelOffset + 3] = 220;
      if (isCompare && showConsensus && allReady) {
        const agreeing = MODEL_IDS.reduce((count, candidate) => {
          const candidateValue = sampleGrid(tiles[candidate].rain.values, frameOffset, sourceIndex, mapping.fractionX[index], mapping.fractionY[index], primaryTile.grid.width);
          return count + (candidateValue !== MISSING_VALUE && candidateValue >= 100 ? 1 : 0);
        }, 0);
        if (agreeing >= 3) {
          pixels[pixelOffset] = Math.round(pixels[pixelOffset] * 0.58 + 198 * 0.42);
          pixels[pixelOffset + 1] = Math.round(pixels[pixelOffset + 1] * 0.58 + 255 * 0.42);
          pixels[pixelOffset + 2] = Math.round(pixels[pixelOffset + 2] * 0.58 + 240 * 0.42);
          pixels[pixelOffset + 3] = 238;
        }
      }
    }
    context.putImageData(image, 0, 0);
    const source = map.getSource('global-model-overlay');
    source?.play();
    window.requestAnimationFrame(() => { source?.pause(); map.triggerRepaint(); });
  }, [activeView, compareLayout, frameIndex, isCompare, leftModel, primaryTile, rightModel, showConsensus, splitPercent, tiles]);

  useEffect(() => { drawFrame(); }, [drawFrame]);

  useEffect(() => {
    const tile = tiles[contourModel];
    if (!showPressure || contourModel !== 'kim-global' || !tile || tile.pressure?.available || !viewport || !metadata) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchKimPressure({
        bbox: viewport.bbox, step: viewport.step, cycle: metadata.cycle,
        frameIndex, signal: controller.signal,
      }).then((result) => setKimPressure({
        key: `${viewport.key}:${frameIndex}`,
        pressure: result.pressure,
      })).catch(() => {});
    }, isPlaying ? 180 : 30);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [contourModel, frameIndex, isPlaying, metadata, showPressure, tiles, viewport]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource('global-isobars')) return;
    const tile = tiles[contourModel];
    const pressureOverride = kimPressure?.key === `${viewport?.key}:${frameIndex}`
      ? kimPressure.pressure
      : null;
    const features = showPressure && tile ? buildPressureFeatures(tile, frameIndex, pressureOverride) : { contours: EMPTY_FEATURES, centers: EMPTY_FEATURES };
    map.getSource('global-isobars').setData(features.contours);
    map.getSource('global-pressure-centers').setData(features.centers);
    ['global-isobars-line', 'global-isobars-label', 'global-pressure-centers-label'].forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', showPressure ? 'visible' : 'none');
    });
  }, [contourModel, frameIndex, kimPressure, showPressure, tiles, viewport]);

  useEffect(() => {
    markerRef.current?.remove();
    markerRef.current = null;
    if (!selectedPoint || !mapRef.current) return;
    markerRef.current = new maplibregl.Marker({ color: '#f8fafc', scale: 0.72 }).setLngLat([selectedPoint.lon, selectedPoint.lat]).addTo(mapRef.current);
  }, [selectedPoint]);

  useEffect(() => {
    if (!isPlaying || times.length < 2) return undefined;
    const interval = Math.max(60, Math.round((playDurationSec * 1000) / Math.max(1, rangeEnd - rangeStart)));
    const timer = window.setInterval(() => setFrameIndex((current) => {
      if (current >= rangeEnd) { setIsPlaying(false); return rangeEnd; }
      return current + 1;
    }), interval);
    return () => window.clearInterval(timer);
  }, [isPlaying, playDurationSec, rangeEnd, rangeStart, times.length]);

  useEffect(() => {
    if (!isDraggingSplit) return undefined;
    const move = (event) => {
      const bounds = shellRef.current?.getBoundingClientRect();
      if (bounds) setSplitPercent(Math.min(88, Math.max(12, ((event.clientX - bounds.left) / bounds.width) * 100)));
    };
    const stop = () => setIsDraggingSplit(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  }, [isDraggingSplit]);

  const currentTime = times[frameIndex] ?? null;
  const currentModelAvailable = isCompare ? visibleModels.some((model) => tiles[model]?.rain?.available) : tiles[activeView]?.rain?.available;
  const unavailableModels = visibleModels.filter((model) => tiles[model] && !tiles[model].rain?.available);
  const unavailableNotice = unavailableModels.length
    ? unavailableModels.map((model) => {
        const progress = model === 'kim-global' ? kimWarmProgress ?? tiles[model].rain?.cacheProgress : tiles[model].rain?.cacheProgress;
        const suffix = progress ? ` (${progress.count}/${progress.total}프레임)` : '';
        return `${MODEL_META[model].short} 자료 준비 중${suffix}`;
      }).join(' · ')
    : '';
  const title = isCompare ? '전구모델 비교' : `${MODEL_META[activeView]?.label ?? ''} 강수예측`;
  const startPlayback = () => {
    if (!times.length) return;
    if (frameIndex < rangeStart || frameIndex >= rangeEnd) setFrameIndex(rangeStart);
    setIsPlaying(true);
  };

  return (
    <div ref={shellRef} className="absolute inset-0 z-30 overflow-hidden bg-[#172334] text-white">
      <div ref={mapContainerRef} className="h-full w-full" aria-label="전구모델 강수와 해면기압 지도" />

      {workspaceMode === 'record' ? <VideoExportMenu currentTarget={activeView} mapRef={mapRef} defaultStart={times[rangeStart]?.toISOString().slice(0, 16) ?? ''} defaultEnd={times[rangeEnd]?.toISOString().slice(0, 16) ?? ''} onBeforeScreenShare={onBeforeScreenShare} onPreparePlayback={() => { setIsPlaying(false); setFrameIndex(rangeStart); }} onStartPlayback={startPlayback} /> : null}

      <div className="pointer-events-none absolute left-[4.4%] top-[14%] z-20 flex items-center">
        <div className="relative flex h-20 w-[620px] max-w-[72vw] items-center gap-4 overflow-hidden rounded-md bg-gradient-to-r from-[#0a3070]/95 via-[#155bb5]/95 to-[#2f7cd6]/95 px-5 shadow-2xl">
          <div className="flex flex-col leading-none"><span className="text-sm font-black">KBS</span><span className="mt-1 text-[10px] font-bold text-white/75">WEATHER</span></div>
          <span className="whitespace-nowrap text-3xl font-black">{title}</span>
          {currentTime ? <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap border-l border-white/30 pl-4"><span className="text-2xl font-black tabular-nums">{formatTime(currentTime)}</span><span className="text-sm font-bold text-[#bdd6fb]">{formatDate(currentTime)}</span></div> : null}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-[#8ec2ff]" />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-28 left-5 z-20 rounded-md bg-slate-950/60 px-3 py-3 shadow-xl backdrop-blur-sm">
        <div className="flex h-[38vh] min-h-[250px] gap-2"><div className="flex w-3 flex-col-reverse overflow-hidden rounded-sm">{PALETTE.map((entry) => <div key={entry.min} className="flex-1" style={{ backgroundColor: `rgb(${entry.color.join(',')})` }} />)}</div><div className="flex flex-col-reverse justify-between py-0.5 text-[10px] font-bold tabular-nums">{PALETTE.map((entry) => <span key={entry.min}>{entry.min}</span>)}</div></div>
        <div className="mt-1 text-center text-[9px] font-semibold text-white/70">mm/6h</div>
      </div>

      {isCompare && primaryTile ? <>
        {compareLayout === 'split' ? <div className="absolute inset-y-0 z-20 w-11 -translate-x-1/2 cursor-ew-resize touch-none" style={{ left: `${splitPercent}%` }} role="separator" aria-label="모델 비교 경계" aria-valuemin="12" aria-valuemax="88" aria-valuenow={Math.round(splitPercent)} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setIsDraggingSplit(true); }}><div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_8px_rgba(0,0,0,0.7)]" /><div className="absolute left-1/2 top-1/2 flex h-12 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-slate-900/85 shadow-xl"><Columns2 className="h-3.5 w-3.5" /></div></div> : <><div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px bg-white/80" /><div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 h-px bg-white/80" /></>}
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 text-xs font-black">{compareLayout === 'split' ? <><span className="absolute left-[25%] rounded-md bg-slate-950/70 px-3 py-1.5">{MODEL_META[leftModel].label}</span><span className="absolute left-[75%] rounded-md bg-slate-950/70 px-3 py-1.5">{MODEL_META[rightModel].label}</span></> : <><span className="absolute left-[25%] rounded-md bg-slate-950/70 px-3 py-1.5">KIM 전구</span><span className="absolute left-[75%] rounded-md bg-slate-950/70 px-3 py-1.5">ECMWF IFS</span><span className="absolute left-[25%] top-[43vh] rounded-md bg-slate-950/70 px-3 py-1.5">ECMWF AIFS</span><span className="absolute left-[75%] top-[43vh] rounded-md bg-slate-950/70 px-3 py-1.5">NOAA GFS</span></>}</div>
      </> : null}

      {selectedPoint ? <ModelPointChart tiles={tiles} times={times} frameIndex={frameIndex} point={selectedPoint} /> : null}

      {workspaceMode !== 'broadcast' ? <div data-video-hide className="absolute bottom-[8.5rem] right-6 z-40 flex max-w-[72vw] flex-col items-end gap-2">
        {menuSlot}
        {isCompare ? <div className="flex h-10 items-center gap-2 rounded-md border border-white/20 bg-slate-950/90 p-1 shadow-xl backdrop-blur-md">
          <button type="button" onClick={() => setCompareLayout('split')} aria-pressed={compareLayout === 'split'} className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-black ${compareLayout === 'split' ? 'bg-white text-slate-950' : 'text-white/65 hover:bg-white/10'}`}><Columns2 className="h-4 w-4" />2분할</button>
          <button type="button" onClick={() => setCompareLayout('quad')} aria-pressed={compareLayout === 'quad'} className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-black ${compareLayout === 'quad' ? 'bg-white text-slate-950' : 'text-white/65 hover:bg-white/10'}`}><Grid2X2 className="h-4 w-4" />4분할</button>
          {compareLayout === 'split' ? <><select value={leftModel} onChange={(event) => setLeftModel(event.target.value)} className="h-8 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white" aria-label="왼쪽 비교 모델">{MODEL_IDS.map((model) => <option key={model} value={model}>{MODEL_META[model].short}</option>)}</select><select value={rightModel} onChange={(event) => setRightModel(event.target.value)} className="h-8 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white" aria-label="오른쪽 비교 모델">{MODEL_IDS.map((model) => <option key={model} value={model}>{MODEL_META[model].short}</option>)}</select></> : null}
          <button type="button" onClick={() => setShowConsensus((value) => !value)} aria-pressed={showConsensus} className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-black ${showConsensus ? 'bg-emerald-400 text-slate-950' : 'text-white/65 hover:bg-white/10'}`}><Layers3 className="h-4 w-4" />합의영역</button>
        </div> : null}
        <div className="flex h-10 items-center gap-2 rounded-md border border-white/20 bg-slate-950/90 px-3 shadow-xl backdrop-blur-md">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-black"><input type="checkbox" checked={showPressure} onChange={(event) => setShowPressure(event.target.checked)} className="h-4 w-4 accent-cyan-400" /><Gauge className="h-4 w-4 text-cyan-300" />등압선·고저기압</label>
          {isCompare && showPressure ? <><span className="h-5 w-px bg-white/20" /><span className="text-[10px] font-bold text-white/50">기준</span><select value={pressureModel} onChange={(event) => setPressureModel(event.target.value)} className="h-8 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white" aria-label="등압선 기준 모델">{MODEL_IDS.map((model) => <option key={model} value={model}>{MODEL_META[model].short}</option>)}</select></> : null}
        </div>
        <div className="flex items-center gap-2"><select value={playDurationSec} onChange={(event) => setPlayDurationSec(Number(event.target.value))} className="h-10 rounded-full border border-white/25 bg-slate-900/80 px-3 text-xs font-black text-white" aria-label="재생 길이">{PLAY_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds}초</option>)}</select><button type="button" onClick={() => setRangeStart(Math.min(frameIndex, rangeEnd - 1))} className="h-10 rounded-full border border-emerald-300/45 bg-emerald-500/15 px-3 text-xs font-black text-emerald-100">시작으로 지정</button><button type="button" onClick={() => setRangeEnd(Math.max(frameIndex, rangeStart + 1))} className="h-10 rounded-full border border-rose-300/45 bg-rose-500/15 px-3 text-xs font-black text-rose-100">끝으로 지정</button><button type="button" onClick={() => { setStatus('loading'); setRefreshTick((value) => value + 1); }} disabled={status === 'loading' || tileLoading} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-slate-900/80" aria-label="전구모델 새로고침" title="새로고침"><RefreshCw className={`h-4 w-4 ${status === 'loading' || tileLoading ? 'animate-spin' : ''}`} /></button></div>
      </div> : null}

      <div data-video-hide className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-slate-950/80 via-slate-950/45 to-transparent px-[7%] pb-4 pt-12">
        <div className="flex items-center gap-5"><button type="button" onClick={() => isPlaying ? setIsPlaying(false) : startPlayback()} disabled={status !== 'ready' || !currentModelAvailable} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-xl disabled:opacity-40" aria-label={isPlaying ? '일시정지' : '재생'}>{isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5 fill-current" />}</button><div className="min-w-0 flex-1"><div className="relative"><input type="range" min="0" max={Math.max(1, times.length - 1)} step="1" value={frameIndex} onChange={(event) => { setIsPlaying(false); setFrameIndex(Number(event.target.value)); }} className="h-2 w-full cursor-pointer accent-blue-500" aria-label="전구모델 예측 시각" />{times.length ? <><span className="pointer-events-none absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full bg-emerald-300" style={{ left: `${(rangeStart / (times.length - 1)) * 100}%` }} /><span className="pointer-events-none absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full bg-rose-300" style={{ left: `${(rangeEnd / (times.length - 1)) * 100}%` }} /></> : null}</div><div className="relative mt-2 h-4 text-[10px] font-bold tabular-nums text-white/65">{[6, 24, 48, 72, 120, 168, 240].map((hour, index, hours) => <span key={hour} className="absolute whitespace-nowrap" style={{ left: `${((hour - 6) / 234) * 100}%`, transform: index === 0 ? 'none' : index === hours.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>+{hour}h</span>)}</div></div></div>
      </div>

      <div data-video-hide className="pointer-events-none absolute bottom-24 right-5 z-20 flex items-center gap-2 rounded-md bg-slate-950/55 px-2 py-1 text-[10px] font-semibold text-white/65"><Globe2 className="h-3 w-3" />KMA · ECMWF · NOAA · Open-Meteo</div>
      {unavailableNotice ? <div className="pointer-events-none absolute left-1/2 top-28 z-40 flex -translate-x-1/2 items-center gap-2 rounded-md border border-amber-300/35 bg-slate-950/88 px-4 py-2 text-xs font-black text-amber-100 shadow-xl"><AlertTriangle className="h-4 w-4 text-amber-300" />{unavailableNotice}</div> : null}
      {tileLoading && Object.keys(tiles).length ? <div className="pointer-events-none absolute right-5 top-5 z-30 flex items-center gap-2 rounded-md bg-slate-950/75 px-3 py-2 text-xs font-bold"><LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" />확대 영역 자료 갱신 중</div> : null}
      {(status === 'loading' || (tileLoading && !Object.keys(tiles).length)) ? <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]"><div className="flex items-center gap-3 rounded-md bg-slate-950/88 px-5 py-4 text-sm font-black shadow-2xl"><LoaderCircle className="h-5 w-5 animate-spin text-cyan-300" />240시간 전구모델 자료를 불러오는 중입니다</div></div> : null}
      {status === 'error' || (error && !Object.keys(tiles).length) ? <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/40"><div className="max-w-xl rounded-md bg-slate-950/92 px-6 py-5 text-center text-sm font-black shadow-2xl">{error}</div></div> : null}
      {error && Object.keys(tiles).length ? <div data-video-hide className="absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-md border border-amber-300/30 bg-slate-950/85 px-4 py-2 text-xs font-bold text-amber-100">{error}</div> : null}
    </div>
  );
}

export default GlobalModelView;
