import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Columns2,
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
import krProvinces from '../data/map/krProvinces.json';
import interKoreanSeam from '../data/map/interKoreanSeam.json';
import neighborCoasts from '../data/map/neighborCoasts.json';
import { fetchGlobalModelRain } from '../api/globalModelApi.js';
import VideoExportMenu from './VideoExportMenu.jsx';

const MODEL_IDS = ['kim-global', 'ifs', 'aifs', 'gfs'];
const MODEL_META = {
  'kim-global': { label: 'KIM 전구', short: 'KIM', color: '#22d3ee' },
  ifs: { label: 'ECMWF IFS', short: 'IFS', color: '#facc15' },
  aifs: { label: 'ECMWF AIFS', short: 'AIFS', color: '#f472b6' },
  gfs: { label: 'NOAA GFS', short: 'GFS', color: '#4ade80' },
};
const MAP_BOUNDS = [[121.5, 32.1], [133.5, 39.5]];
const CANVAS_WIDTH = 960;
const MISSING_VALUE = 65535;
const PLAY_DURATIONS = [5, 8, 10, 12, 15, 20, 30];
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

const PROVINCE_LABELS = {
  type: 'FeatureCollection',
  features: [
    ['서울', 126.98, 37.57],
    ['부산', 129.08, 35.18],
    ['대구', 128.6, 35.87],
    ['인천', 126.7, 37.46],
    ['광주', 126.85, 35.16],
    ['대전', 127.38, 36.35],
    ['울산', 129.31, 35.54],
    ['세종', 127.25, 36.49],
    ['경기', 127.35, 37.25],
    ['강원', 128.28, 37.74],
    ['충북', 127.72, 36.82],
    ['충남', 126.8, 36.53],
    ['전북', 127.1, 35.72],
    ['전남', 126.85, 34.85],
    ['경북', 128.75, 36.35],
    ['경남', 128.25, 35.25],
    ['제주', 126.55, 33.38],
  ].map(([name, lon, lat]) => ({
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  })),
};

const MAP_STYLE = {
  version: 8,
  sources: {
    provinces: { type: 'geojson', data: krProvinces },
    provinceLabels: { type: 'geojson', data: PROVINCE_LABELS },
    neighbors: { type: 'geojson', data: neighborCoasts },
    interKoreanSeam: { type: 'geojson', data: interKoreanSeam },
  },
  layers: [
    { id: 'global-sea', type: 'background', paint: { 'background-color': '#46536a' } },
    {
      id: 'global-neighbor-land',
      type: 'fill',
      source: 'neighbors',
      paint: { 'fill-color': '#828c9c' },
    },
    {
      id: 'global-inter-korean-seam',
      type: 'fill',
      source: 'interKoreanSeam',
      paint: { 'fill-color': '#828c9c', 'fill-opacity': 1 },
    },
    {
      id: 'global-neighbor-coast',
      type: 'line',
      source: 'neighbors',
      paint: { 'line-color': '#5d6879', 'line-width': 0.8 },
    },
    {
      id: 'global-land',
      type: 'fill',
      source: 'provinces',
      paint: { 'fill-color': '#eef0f2' },
    },
    {
      id: 'global-province-border',
      type: 'line',
      source: 'provinces',
      paint: { 'line-color': '#4a5568', 'line-width': 1.1 },
    },
    {
      id: 'global-province-label',
      type: 'symbol',
      source: 'provinceLabels',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 4.5, 11, 8, 15],
        'text-font': ['Open Sans Semibold'],
        'text-allow-overlap': false,
        'text-padding': 5,
      },
      paint: {
        'text-color': '#263244',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.5,
      },
    },
  ],
};

const mercatorY = (latitude) =>
  Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
const mercatorYToLat = (value) =>
  ((2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180) / Math.PI;

const formatTime = (date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const formatDate = (date) =>
  `${date.getMonth() + 1}/${date.getDate()} (${['일', '월', '화', '수', '목', '금', '토'][date.getDay()]})`;

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
  const indexes = [sourceIndex, sourceIndex + 1, bottomIndex, bottomIndex + 1];
  const samples = indexes.map((index) => values[frameOffset + index]);
  if (samples.some((value) => value === MISSING_VALUE)) return MISSING_VALUE;
  const fx = fxByte / 255;
  const fy = fyByte / 255;
  const top = samples[0] * (1 - fx) + samples[1] * fx;
  const bottom = samples[2] * (1 - fx) + samples[3] * fx;
  return Math.round(top * (1 - fy) + bottom * fy);
};

const nearestGridIndex = (point, grid) => {
  const column = Math.round((point.lon - grid.lonMin) / grid.step);
  const row = Math.round((grid.latMax - point.lat) / grid.step);
  if (column < 0 || column >= grid.width || row < 0 || row >= grid.height) return -1;
  return row * grid.width + column;
};

const modelForPixel = (layout, x, y, width, height, splitPercent, leftModel, rightModel) => {
  if (layout === 'split') return x < (width * splitPercent) / 100 ? leftModel : rightModel;
  if (x < width / 2 && y < height / 2) return 'kim-global';
  if (x >= width / 2 && y < height / 2) return 'ifs';
  if (x < width / 2) return 'aifs';
  return 'gfs';
};

function ModelPointChart({ dataset, frameIndex, point }) {
  const chart = useMemo(() => {
    if (!dataset || !point) return null;
    const gridIndex = nearestGridIndex(point, dataset.grid);
    if (gridIndex < 0) return null;
    const pointCount = dataset.grid.width * dataset.grid.height;
    const series = MODEL_IDS.map((modelId) => ({
      modelId,
      values: dataset.times.map((_, index) => {
        const value = dataset.models[modelId].values[index * pointCount + gridIndex];
        return value === MISSING_VALUE ? null : value / 100;
      }),
    }));
    const maximum = Math.max(
      5,
      ...series.flatMap((entry) => entry.values.filter(Number.isFinite)),
    );
    return { series, maximum };
  }, [dataset, point]);

  if (!chart) return null;
  const width = 430;
  const height = 142;
  const top = 10;
  const bottom = 20;
  const plotHeight = height - top - bottom;
  const xOf = (index) => (index / Math.max(1, dataset.times.length - 1)) * width;
  const yOf = (value) => top + plotHeight - (value / chart.maximum) * plotHeight;

  return (
    <div className="pointer-events-auto absolute bottom-28 left-[8%] z-30 w-[470px] rounded-md border border-white/20 bg-slate-950/88 p-4 text-white shadow-2xl backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-black">
          <MapPin className="h-4 w-4 text-cyan-300" />
          {point.lat.toFixed(2)}°N, {point.lon.toFixed(2)}°E
        </div>
        <span className="text-xs font-bold text-white/55">6시간 누적 강수량</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[142px] w-full" aria-label="모델별 예상 강수량 그래프">
        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2={width}
            y1={top + plotHeight * ratio}
            y2={top + plotHeight * ratio}
            stroke="rgba(255,255,255,0.15)"
            strokeWidth="1"
          />
        ))}
        <line
          x1={xOf(frameIndex)}
          x2={xOf(frameIndex)}
          y1={top}
          y2={top + plotHeight}
          stroke="rgba(255,255,255,0.75)"
          strokeWidth="1"
        />
        {chart.series.map(({ modelId, values }) => {
          const path = values.reduce((result, value, index) => {
            if (!Number.isFinite(value)) return result;
            const command = result ? 'L' : 'M';
            return `${result}${command}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`;
          }, '');
          return path ? (
            <path
              key={modelId}
              d={path}
              fill="none"
              stroke={MODEL_META[modelId].color}
              strokeWidth="2.2"
              strokeLinejoin="round"
            />
          ) : null;
        })}
      </svg>
      <div className="mt-1 grid grid-cols-4 gap-2">
        {chart.series.map(({ modelId, values }) => (
          <div key={modelId} className="min-w-0 border-l-2 pl-2" style={{ borderColor: MODEL_META[modelId].color }}>
            <div className="truncate text-[10px] font-bold text-white/55">{MODEL_META[modelId].short}</div>
            <div className="text-sm font-black tabular-nums">
              {Number.isFinite(values[frameIndex]) ? `${values[frameIndex].toFixed(1)}` : '-'}
              <span className="ml-0.5 text-[9px] text-white/55">mm</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GlobalModelView({
  activeView,
  workspaceMode,
  showPlaceLabels,
  menuSlot,
  onBeforeScreenShare,
}) {
  const mapContainerRef = useRef(null);
  const shellRef = useRef(null);
  const mapRef = useRef(null);
  const canvasRef = useRef(null);
  const mappingRef = useRef(null);
  const markerRef = useRef(null);
  const [dataset, setDataset] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(79);
  const [compareLayout, setCompareLayout] = useState('split');
  const [leftModel, setLeftModel] = useState('kim-global');
  const [rightModel, setRightModel] = useState('ifs');
  const [splitPercent, setSplitPercent] = useState(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [showConsensus, setShowConsensus] = useState(true);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const isCompare = activeView === 'compare';

  useEffect(() => {
    let isActive = true;
    const timer = window.setTimeout(async () => {
      setStatus('loading');
      setError('');
      try {
        const next = await fetchGlobalModelRain({ refresh: refreshTick > 0 });
        if (!isActive) return;
        setDataset(next);
        setFrameIndex(0);
        setRangeStart(0);
        setRangeEnd(next.times.length - 1);
        setStatus('ready');
      } catch (loadError) {
        if (!isActive) return;
        setError(loadError.message);
        setStatus('error');
      }
    }, 0);
    return () => {
      isActive = false;
      window.clearTimeout(timer);
    };
  }, [refreshTick]);

  const canvasHeight = useMemo(() => {
    if (!dataset) return 650;
    const ySpan = mercatorY(dataset.grid.latMax) - mercatorY(dataset.grid.latMin);
    const xSpan = ((dataset.grid.lonMax - dataset.grid.lonMin) * Math.PI) / 180;
    return Math.round((CANVAS_WIDTH * ySpan) / xSpan);
  }, [dataset]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      bounds: MAP_BOUNDS,
      fitBoundsOptions: { padding: 0 },
      minZoom: 4.5,
      maxZoom: 10,
      attributionControl: false,
      localIdeographFontFamily: '"Noto Sans KR", "Malgun Gothic", sans-serif',
      dragRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    map.on('click', ({ lngLat }) => {
      setSelectedPoint({ lon: lngLat.lng, lat: lngLat.lat });
    });
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !dataset) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = canvasHeight;
    canvasRef.current = canvas;
    mappingRef.current = buildCanvasMapping(CANVAS_WIDTH, canvasHeight, dataset.grid);

    const setup = () => {
      if (map.getSource('global-model-overlay')) return;
      map.addSource('global-model-overlay', {
        type: 'canvas',
        canvas,
        animate: false,
        coordinates: [
          [dataset.grid.lonMin, dataset.grid.latMax],
          [dataset.grid.lonMax, dataset.grid.latMax],
          [dataset.grid.lonMax, dataset.grid.latMin],
          [dataset.grid.lonMin, dataset.grid.latMin],
        ],
      });
      map.addLayer(
        {
          id: 'global-model-overlay',
          type: 'raster',
          source: 'global-model-overlay',
          paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' },
        },
        'global-province-border',
      );
    };

    if (map.loaded()) setup();
    else map.once('load', setup);
    return () => {
      canvasRef.current = null;
      mappingRef.current = null;
    };
  }, [canvasHeight, dataset]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const mapping = mappingRef.current;
    const map = mapRef.current;
    if (!canvas || !mapping || !map || !dataset) return;
    const context = canvas.getContext('2d');
    const image = context.createImageData(canvas.width, canvas.height);
    const pixels = image.data;
    const pointCount = dataset.grid.width * dataset.grid.height;
    const frameOffset = frameIndex * pointCount;
    const allModelsReady = MODEL_IDS.every((modelId) => dataset.models[modelId].available);

    for (let index = 0; index < mapping.baseIndex.length; index += 1) {
      const sourceIndex = mapping.baseIndex[index];
      if (sourceIndex < 0) continue;
      const x = index % canvas.width;
      const y = Math.floor(index / canvas.width);
      const modelId = isCompare
        ? modelForPixel(
            compareLayout,
            x,
            y,
            canvas.width,
            canvas.height,
            splitPercent,
            leftModel,
            rightModel,
          )
        : activeView;
      const value = sampleGrid(
        dataset.models[modelId]?.values,
        frameOffset,
        sourceIndex,
        mapping.fractionX[index],
        mapping.fractionY[index],
        dataset.grid.width,
      );
      const color = value === MISSING_VALUE ? null : colorForEncoded(value);
      if (!color) continue;
      const pixelOffset = index * 4;
      pixels[pixelOffset] = color[0];
      pixels[pixelOffset + 1] = color[1];
      pixels[pixelOffset + 2] = color[2];
      pixels[pixelOffset + 3] = 216;

      if (isCompare && showConsensus && allModelsReady) {
        let agreeingModels = 0;
        for (const candidateId of MODEL_IDS) {
          const candidate = sampleGrid(
            dataset.models[candidateId].values,
            frameOffset,
            sourceIndex,
            mapping.fractionX[index],
            mapping.fractionY[index],
            dataset.grid.width,
          );
          if (candidate !== MISSING_VALUE && candidate >= 100) agreeingModels += 1;
        }
        if (agreeingModels >= 3) {
          pixels[pixelOffset] = Math.round(pixels[pixelOffset] * 0.58 + 198 * 0.42);
          pixels[pixelOffset + 1] = Math.round(pixels[pixelOffset + 1] * 0.58 + 255 * 0.42);
          pixels[pixelOffset + 2] = Math.round(pixels[pixelOffset + 2] * 0.58 + 240 * 0.42);
          pixels[pixelOffset + 3] = 236;
        }
      }
    }
    context.putImageData(image, 0, 0);
    const source = map.getSource('global-model-overlay');
    source?.play();
    window.requestAnimationFrame(() => {
      source?.pause();
      map.triggerRepaint();
    });
  }, [activeView, compareLayout, dataset, frameIndex, isCompare, leftModel, rightModel, showConsensus, splitPercent]);

  useEffect(() => {
    if (status !== 'ready') return;
    drawFrame();
  }, [drawFrame, status]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('global-province-label')) return;
    map.setLayoutProperty('global-province-label', 'visibility', showPlaceLabels ? 'visible' : 'none');
  }, [showPlaceLabels, status]);

  useEffect(() => {
    markerRef.current?.remove();
    markerRef.current = null;
    if (!selectedPoint || !mapRef.current) return;
    markerRef.current = new maplibregl.Marker({ color: '#f8fafc', scale: 0.72 })
      .setLngLat([selectedPoint.lon, selectedPoint.lat])
      .addTo(mapRef.current);
  }, [selectedPoint]);

  useEffect(() => {
    if (!isPlaying || !dataset || dataset.times.length < 2) return undefined;
    const interval = Math.max(60, Math.round((playDurationSec * 1000) / Math.max(1, rangeEnd - rangeStart)));
    const timer = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= rangeEnd) {
          setIsPlaying(false);
          return rangeEnd;
        }
        return current + 1;
      });
    }, interval);
    return () => window.clearInterval(timer);
  }, [dataset, isPlaying, playDurationSec, rangeEnd, rangeStart]);

  useEffect(() => {
    if (!isDraggingSplit) return undefined;
    const move = (event) => {
      const bounds = shellRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setSplitPercent(Math.min(88, Math.max(12, ((event.clientX - bounds.left) / bounds.width) * 100)));
    };
    const stop = () => setIsDraggingSplit(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, [isDraggingSplit]);

  const currentTime = dataset?.times[frameIndex] ?? null;
  const allModelsReady = dataset && MODEL_IDS.every((modelId) => dataset.models[modelId].available);
  const currentModelAvailable = activeView === 'compare'
    ? allModelsReady
    : dataset?.models[activeView]?.available;
  const title = activeView === 'compare'
    ? '전구모델 비교'
    : `${MODEL_META[activeView]?.label ?? ''} 강수예측`;

  const startPlayback = () => {
    if (!dataset) return;
    if (frameIndex < rangeStart || frameIndex >= rangeEnd) setFrameIndex(rangeStart);
    setIsPlaying(true);
  };

  return (
    <div ref={shellRef} className="absolute inset-0 z-30 overflow-hidden bg-[#46536a] text-white">
      <div ref={mapContainerRef} className="h-full w-full" aria-label="전구모델 강수 예측 지도" />

      {workspaceMode === 'record' ? (
        <VideoExportMenu
          currentTarget={activeView}
          mapRef={mapRef}
          defaultStart={dataset?.times[rangeStart]?.toISOString().slice(0, 16) ?? ''}
          defaultEnd={dataset?.times[rangeEnd]?.toISOString().slice(0, 16) ?? ''}
          onBeforeScreenShare={onBeforeScreenShare}
          onPreparePlayback={() => {
            setIsPlaying(false);
            setFrameIndex(rangeStart);
          }}
          onStartPlayback={startPlayback}
        />
      ) : null}

      <div
        className="pointer-events-none absolute z-20 flex items-center"
        style={{ left: '4.4%', top: '14%' }}
      >
        <div className="relative flex h-[clamp(58px,7.4vh,96px)] w-[clamp(470px,34vw,760px)] items-center gap-4 overflow-hidden rounded-md bg-gradient-to-r from-[#0a3070]/95 via-[#155bb5]/95 to-[#2f7cd6]/95 px-5 shadow-2xl">
          <div className="flex flex-col leading-none">
            <span className="text-sm font-black">KBS</span>
            <span className="mt-1 text-[10px] font-bold text-white/75">WEATHER</span>
          </div>
          <span className="whitespace-nowrap text-[clamp(25px,2vw,44px)] font-black">{title}</span>
          {currentTime ? (
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap border-l border-white/30 pl-4">
              <span className="text-[clamp(20px,1.5vw,34px)] font-black tabular-nums">{formatTime(currentTime)}</span>
              <span className="text-sm font-bold text-[#bdd6fb]">{formatDate(currentTime)}</span>
            </div>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-[#8ec2ff]" />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-28 left-5 z-20 rounded-md bg-slate-950/55 px-3 py-3 shadow-xl backdrop-blur-sm">
        <div className="flex h-[38vh] min-h-[250px] gap-2">
          <div className="flex w-3 flex-col-reverse overflow-hidden rounded-sm">
            {PALETTE.map((entry) => (
              <div key={entry.min} className="flex-1" style={{ backgroundColor: `rgb(${entry.color.join(',')})` }} />
            ))}
          </div>
          <div className="flex flex-col-reverse justify-between py-0.5 text-[10px] font-bold tabular-nums">
            {PALETTE.map((entry) => <span key={entry.min}>{entry.min}</span>)}
          </div>
        </div>
        <div className="mt-1 text-center text-[9px] font-semibold text-white/70">mm/6h</div>
      </div>

      {isCompare && status === 'ready' ? (
        <>
          {compareLayout === 'split' ? (
            <div
              className="absolute inset-y-0 z-20 w-11 -translate-x-1/2 cursor-ew-resize touch-none"
              style={{ left: `${splitPercent}%` }}
              role="separator"
              aria-label="모델 비교 경계"
              aria-valuemin="12"
              aria-valuemax="88"
              aria-valuenow={Math.round(splitPercent)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsDraggingSplit(true);
              }}
            >
              <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_8px_rgba(0,0,0,0.7)]" />
              <div className="absolute left-1/2 top-1/2 flex h-12 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-slate-900/85 shadow-xl">
                <Columns2 className="h-3.5 w-3.5" />
              </div>
            </div>
          ) : (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px bg-white/80" />
              <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 h-px bg-white/80" />
            </>
          )}

          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-around px-[8%] text-xs font-black">
            {compareLayout === 'split' ? (
              <>
                <span className="rounded-md bg-slate-950/65 px-3 py-1.5">{MODEL_META[leftModel].label}</span>
                <span className="rounded-md bg-slate-950/65 px-3 py-1.5">{MODEL_META[rightModel].label}</span>
              </>
            ) : (
              <>
                <span className="absolute left-[25%] top-0 -translate-x-1/2 rounded-md bg-slate-950/65 px-3 py-1.5">KIM 전구</span>
                <span className="absolute left-[75%] top-0 -translate-x-1/2 rounded-md bg-slate-950/65 px-3 py-1.5">ECMWF IFS</span>
                <span className="absolute left-[25%] top-[43vh] -translate-x-1/2 rounded-md bg-slate-950/65 px-3 py-1.5">ECMWF AIFS</span>
                <span className="absolute left-[75%] top-[43vh] -translate-x-1/2 rounded-md bg-slate-950/65 px-3 py-1.5">NOAA GFS</span>
              </>
            )}
          </div>

          {selectedPoint ? (
            <ModelPointChart dataset={dataset} frameIndex={frameIndex} point={selectedPoint} />
          ) : null}
        </>
      ) : null}

      {workspaceMode !== 'broadcast' ? (
        <div data-video-hide className="absolute bottom-[8.5rem] right-6 z-40 flex flex-col items-end gap-2">
          {menuSlot}
          {isCompare ? (
            <div className="flex h-10 items-center gap-2 rounded-lg border border-white/20 bg-slate-950/90 p-1 shadow-xl backdrop-blur-md">
              <button
                type="button"
                onClick={() => setCompareLayout('split')}
                aria-pressed={compareLayout === 'split'}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-black ${compareLayout === 'split' ? 'bg-white text-slate-950' : 'text-white/65 hover:bg-white/10'}`}
              >
                <Columns2 className="h-4 w-4" /> 2분할
              </button>
              <button
                type="button"
                onClick={() => setCompareLayout('quad')}
                aria-pressed={compareLayout === 'quad'}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-black ${compareLayout === 'quad' ? 'bg-white text-slate-950' : 'text-white/65 hover:bg-white/10'}`}
              >
                <Grid2X2 className="h-4 w-4" /> 4분할
              </button>
              {compareLayout === 'split' ? (
                <>
                  <select
                    value={leftModel}
                    onChange={(event) => setLeftModel(event.target.value)}
                    className="h-8 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white"
                    aria-label="왼쪽 비교 모델"
                  >
                    {MODEL_IDS.map((modelId) => <option key={modelId} value={modelId}>{MODEL_META[modelId].short}</option>)}
                  </select>
                  <select
                    value={rightModel}
                    onChange={(event) => setRightModel(event.target.value)}
                    className="h-8 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-bold text-white"
                    aria-label="오른쪽 비교 모델"
                  >
                    {MODEL_IDS.map((modelId) => <option key={modelId} value={modelId}>{MODEL_META[modelId].short}</option>)}
                  </select>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setShowConsensus((value) => !value)}
                disabled={!allModelsReady}
                aria-pressed={showConsensus && allModelsReady}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-black disabled:opacity-40 ${showConsensus && allModelsReady ? 'bg-emerald-400 text-slate-950' : 'text-white/65 hover:bg-white/10'}`}
              >
                <Layers3 className="h-4 w-4" /> 합의영역
              </button>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <select
              value={playDurationSec}
              onChange={(event) => setPlayDurationSec(Number(event.target.value))}
              className="h-10 rounded-full border border-white/25 bg-slate-900/75 px-3 text-xs font-black text-white shadow-lg"
              aria-label="전구모델 재생 길이"
            >
              {PLAY_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds}초</option>)}
            </select>
            <button
              type="button"
              onClick={() => setRangeStart(Math.min(frameIndex, rangeEnd - 1))}
              className="h-10 rounded-full border border-emerald-300/45 bg-emerald-500/15 px-3 text-xs font-black text-emerald-100"
            >
              시작으로 지정
            </button>
            <button
              type="button"
              onClick={() => setRangeEnd(Math.max(frameIndex, rangeStart + 1))}
              className="h-10 rounded-full border border-rose-300/45 bg-rose-500/15 px-3 text-xs font-black text-rose-100"
            >
              끝으로 지정
            </button>
            <button
              type="button"
              onClick={() => setRefreshTick((value) => value + 1)}
              disabled={status === 'loading'}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-slate-900/75 text-white"
              aria-label="전구모델 새로고침"
              title="새로고침"
            >
              <RefreshCw className={`h-4 w-4 ${status === 'loading' ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      ) : null}

      <div data-video-hide className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-slate-950/75 via-slate-950/45 to-transparent px-[7%] pb-4 pt-12">
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={() => {
              if (isPlaying) setIsPlaying(false);
              else startPlayback();
            }}
            disabled={status !== 'ready' || !currentModelAvailable}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-xl disabled:opacity-40"
            aria-label={isPlaying ? '일시정지' : '재생'}
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5 fill-current" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="relative">
              <input
                type="range"
                min="0"
                max={Math.max(1, (dataset?.times.length ?? 1) - 1)}
                step="1"
                value={frameIndex}
                onChange={(event) => {
                  setIsPlaying(false);
                  setFrameIndex(Number(event.target.value));
                }}
                className="h-2 w-full cursor-pointer accent-blue-500"
                aria-label="전구모델 예측 시각"
              />
              {dataset ? (
                <>
                  <span className="pointer-events-none absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full bg-emerald-300" style={{ left: `${(rangeStart / (dataset.times.length - 1)) * 100}%` }} />
                  <span className="pointer-events-none absolute top-0 h-3 w-1 -translate-x-1/2 rounded-full bg-rose-300" style={{ left: `${(rangeEnd / (dataset.times.length - 1)) * 100}%` }} />
                </>
              ) : null}
            </div>
            <div className="relative mt-2 h-4 text-[10px] font-bold tabular-nums text-white/65">
              {[6, 24, 48, 72, 120, 168, 240].map((hour, index, hours) => (
                <span
                  key={hour}
                  className="absolute whitespace-nowrap"
                  style={{
                    left: `${((hour - 6) / (240 - 6)) * 100}%`,
                    transform: index === 0
                      ? 'none'
                      : index === hours.length - 1
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                  }}
                >
                  +{hour}h
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-24 right-5 z-20 text-[10px] font-semibold text-white/55">
        KMA · ECMWF · NOAA · Open-Meteo
      </div>

      {status === 'loading' ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/35 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-md bg-slate-950/85 px-5 py-4 text-sm font-black shadow-2xl">
            <LoaderCircle className="h-5 w-5 animate-spin text-cyan-300" />
            240시간 전구모델 자료를 불러오는 중입니다
          </div>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/35">
          <div className="rounded-md bg-slate-950/90 px-6 py-5 text-sm font-black shadow-2xl">{error}</div>
        </div>
      ) : null}
      {status === 'ready' && !currentModelAvailable ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="rounded-md border border-amber-200/30 bg-slate-950/88 px-6 py-5 text-center shadow-2xl">
            <div className="text-base font-black text-amber-200">KIM 전구 자료 대기</div>
            <div className="mt-1 text-xs font-semibold text-white/60">해당 유효시각의 모델 자료가 아직 제공되지 않았습니다.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default GlobalModelView;
