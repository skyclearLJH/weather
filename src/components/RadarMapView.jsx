import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, MonitorPlay, X } from 'lucide-react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import krProvinces from '../data/map/krProvinces.json';
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

// 표출 캔버스가 덮는 위경도 범위(레이더 격자 전체 영역)
const VIEW_BOUNDS = { lonMin: 120.18, lonMax: 133.56, latMin: 30.1, latMax: 43.34 };
const CANVAS_WIDTH = 1152;
const OVERLAY_ALPHA = 208;

const OBS_HISTORY_HOURS = 6;
const OBS_FRAME_INTERVAL_MINUTES = 5;
const OBS_FRAME_COUNT = (OBS_HISTORY_HOURS * 60) / OBS_FRAME_INTERVAL_MINUTES + 1; // 최신 포함 과거 6시간
const FRAME_CACHE_LIMIT = 48;
const INITIAL_OBS_PREFETCH_COUNT = 18;
const INITIAL_QPF_PREFETCH_COUNT = 18;
const NEARBY_PREFETCH_RADIUS = 3;
const QPF_EF_MINUTES = Array.from({ length: 36 }, (_, index) => (index + 1) * 10);
const PLAY_INTERVAL_MS = 450;

// KBS 총국·을지국 소재 도시 전체
const BROADCAST_CITIES = [
  { name: '서울', lon: 126.978, lat: 37.566 },
  { name: '인천', lon: 126.705, lat: 37.456 },
  { name: '춘천', lon: 127.73, lat: 37.881 },
  { name: '원주', lon: 127.92, lat: 37.342 },
  { name: '강릉', lon: 128.876, lat: 37.752 },
  { name: '청주', lon: 127.489, lat: 36.642 },
  { name: '충주', lon: 127.926, lat: 36.991 },
  { name: '대전', lon: 127.385, lat: 36.35 },
  { name: '전주', lon: 127.148, lat: 35.824 },
  { name: '광주', lon: 126.852, lat: 35.16 },
  { name: '목포', lon: 126.392, lat: 34.812 },
  { name: '순천', lon: 127.487, lat: 34.951 },
  { name: '대구', lon: 128.601, lat: 35.871 },
  { name: '안동', lon: 128.726, lat: 36.568 },
  { name: '포항', lon: 129.343, lat: 36.019 },
  { name: '울산', lon: 129.311, lat: 35.539 },
  { name: '부산', lon: 129.075, lat: 35.18 },
  { name: '창원', lon: 128.681, lat: 35.228 },
  { name: '진주', lon: 128.108, lat: 35.18 },
  { name: '제주', lon: 126.531, lat: 33.499 },
];

const MAP_STYLE = {
  version: 8,
  sources: {
    provinces: { type: 'geojson', data: krProvinces },
    neighbors: { type: 'geojson', data: neighborCoasts },
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

const TIMELINE_RANGE_MINUTES = 360; // 관측 -6시간 ~ 예측 +6시간 (현재가 정중앙)
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
const BROADCAST_MAP_BOUNDS = [
  [118.8, 31.6],
  [136.2, 41.3],
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
  },
  broadcast: {
    sea: '#46536a',
    neighborLand: '#828c9c',
    neighborCoast: '#5d6879',
    land: '#eef0f2',
    provinceBorder: '#4a5568',
  },
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

const RadarMapView = ({ refreshToken = 0 }) => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const mappingsRef = useRef(null);
  const imageDataRef = useRef(null);
  const frameCacheRef = useRef(new Map());
  const pendingRef = useRef(new Map());
  const renderTokenRef = useRef(0);

  const [frames, setFrames] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [statusMessage, setStatusMessage] = useState('');
  // 전체화면: 지원 브라우저는 네이티브 API, 미지원(iOS 사파리 등)은 CSS 오버레이로 대체
  const sectionRef = useRef(null);
  const [fullscreenMode, setFullscreenMode] = useState(null); // null | 'native' | 'css'
  const isFullscreen = fullscreenMode !== null;
  // 방송모드: 전체화면 + 방송 그래픽 레이아웃 (PC 전용)
  const [isBroadcast, setIsBroadcast] = useState(false);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [playTarget, setPlayTarget] = useState(null);
  const cacheLimitRef = useRef(FRAME_CACHE_LIMIT);
  // 주기적 자동 갱신(눈금·'현재'가 실제 시간을 따라가도록)
  const [autoRefreshTick, setAutoRefreshTick] = useState(0);
  const lastRefreshTokenRef = useRef(refreshToken);
  const lastBuildSignatureRef = useRef('');
  const framesRef = useRef([]);
  const frameIndexRef = useRef(0);
  const isPlayingRef = useRef(false);

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
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    if (import.meta.env.DEV) {
      window.__radarMap = map;
    }

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = canvasHeight;
    overlayCanvasRef.current = canvas;

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

      BROADCAST_CITIES.forEach(({ name, lon, lat }) => {
        const element = document.createElement('div');
        element.className = 'pointer-events-none select-none text-center';
        element.innerHTML =
          '<div class="mx-auto h-1.5 w-1.5 rounded-full bg-slate-600"></div>' +
          `<div class="mt-0.5 text-[11px] font-semibold leading-none text-slate-700" style="text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">${name}</div>`;
        new maplibregl.Marker({ element, anchor: 'top' }).setLngLat([lon, lat]).addTo(map);
      });
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
      map.remove();
      mapRef.current = null;
    };
  }, [canvasHeight]);

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
      const mappings = mappingsRef.current;
      if (!canvas || !mappings || !frame) {
        return;
      }

      const context = canvas.getContext('2d');
      if (!imageDataRef.current) {
        imageDataRef.current = context.createImageData(canvas.width, canvas.height);
      }
      const imageData = imageDataRef.current;
      const pixels = imageData.data;
      const dataMap = frame.kind === 'obs' ? mappings.radarMap : mappings.qpfMap;
      const { buckets } = frame;

      for (let index = 0; index < dataMap.length; index++) {
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

      context.putImageData(imageData, 0, 0);
      refreshOverlaySource();
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
      ? fetchRadarFrame(frameDef.tm)
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
  }, [rememberFrameBuckets]);

  // 초기 로딩 및 상단 새로고침(refreshToken 변경) 시 타임라인 재구성
  useEffect(() => {
    let isActive = true;

    const initialize = async () => {
      const isManualRefresh = refreshToken !== lastRefreshTokenRef.current;
      lastRefreshTokenRef.current = refreshToken;

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
          probeLatestRadarTm(new Date(), OBS_HISTORY_HOURS * 60, ({ tm, frame }) =>
            rememberFrameBuckets(`obs-${tm}`, frame.buckets),
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

        const forecastFrames = [];
        if (qpfLatest) {
          const anchorTime = parseRadarTm(qpfLatest.tm);
          QPF_EF_MINUTES.forEach((ef) => {
            const validTime = new Date(anchorTime.getTime() + ef * 60 * 1000);
            if (validTime > latestObsTime) {
              forecastFrames.push({
                key: `fct-${qpfLatest.tm}-${ef}`,
                kind: 'fct',
                tm: qpfLatest.tm,
                ef,
                validTime,
              });
            }
          });
        }

        rememberFrameBuckets(`obs-${radarLatest.tm}`, radarLatest.frame.buckets);
        if (qpfLatest) {
          rememberFrameBuckets(`fct-${qpfLatest.tm}-10`, qpfLatest.frame.buckets);
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
  }, [loadFrameData, rememberFrameBuckets, refreshToken, autoRefreshTick]);

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

  // 현재 프레임 렌더링
  useEffect(() => {
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
  }, [frames, frameIndex, status, renderFrame, loadFrameData]);

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

  // 재생. 방송모드에서는 전체 타임라인을 선택한 재생 길이에 맞춰 진행한다.
  useEffect(() => {
    if (!isPlaying || frames.length === 0) {
      return undefined;
    }
    const intervalMs = isBroadcast
      ? Math.max(45, Math.round((playDurationSec * 1000) / frames.length))
      : PLAY_INTERVAL_MS;
    const timer = window.setInterval(() => {
      setFrameIndex((previous) =>
        isBroadcast ? Math.min(previous + 1, frames.length - 1) : (previous + 1) % frames.length,
      );
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [isPlaying, frames.length, isBroadcast, playDurationSec]);

  // 방송모드 재생은 목표 지점(현재 또는 예측 끝)에 도달하면 멈춘다.
  useEffect(() => {
    if (isBroadcast && isPlaying && playTarget !== null && frameIndex >= playTarget) {
      setIsPlaying(false);
    }
  }, [isBroadcast, isPlaying, playTarget, frameIndex]);

  // 재생 버튼: 방송모드에서는 ① 관측 시작→현재 ② 현재→예측 끝 두 단계로 나눠 재생한다.
  const handlePlayButton = () => {
    if (isPlaying) {
      setIsPlaying(false);
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

    if (frameIndex === latestObsIndex && frames.length - 1 > latestObsIndex) {
      setPlayTarget(frames.length - 1);
    } else {
      setFrameIndex(0);
      setPlayTarget(latestObsIndex);
    }
    setIsPlaying(true);
  };

  const currentFrame = frames[frameIndex];

  // 타임라인은 프레임 개수가 아니라 시간에 비례한다. 기준(0분) = 최신 관측
  // 시각이며, 관측 -6시간 ~ 예측 +6시간이라 '현재'가 정확히 가운데에 온다.
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
  const thumbPercent = ((currentOffset + TIMELINE_RANGE_MINUTES) / (TIMELINE_RANGE_MINUTES * 2)) * 100;

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
    setFrameIndex(nearestIndex);
  };

  const timelineTicks = useMemo(() => {
    if (baseTimeMs === null) {
      return [];
    }
    let previousLabeledDate = null;
    return Array.from({ length: 13 }, (_, index) => {
      const hourOffset = index - 6;
      const position = (index / 12) * 100;
      const isLabeled = hourOffset % 2 === 0;
      let label = '';
      let dateLabel = '';
      if (isLabeled) {
        const tickTime = new Date(baseTimeMs + hourOffset * 60 * 60 * 1000);
        label = hourOffset === 0 ? '현재' : formatHourMinute(tickTime);
        // 날짜가 바뀌는 첫 눈금에는 날짜를 함께 표시한다.
        const tickDate = `${tickTime.getMonth() + 1}.${tickTime.getDate()}`;
        if (previousLabeledDate !== null && tickDate !== previousLabeledDate) {
          dateLabel = tickDate;
        }
        previousLabeledDate = tickDate;
      }
      return { hourOffset, position, isLabeled, label, dateLabel };
    });
  }, [baseTimeMs]);

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

  // 전체화면 전환 시 지도 캔버스 크기를 컨테이너에 맞추고,
  // 방송모드 진입·해제 시에는 각 모드의 기본 구도로 화면을 다시 잡는다.
  const previousBroadcastRef = useRef(false);
  useEffect(() => {
    const broadcastChanged = previousBroadcastRef.current !== isBroadcast;
    previousBroadcastRef.current = isBroadcast;

    const timers = [120, 400].map((delay) =>
      window.setTimeout(() => mapRef.current?.resize(), delay),
    );
    if (broadcastChanged) {
      timers.push(
        window.setTimeout(() => {
          const map = mapRef.current;
          if (!map) {
            return;
          }
          if (isBroadcast) {
            map.fitBounds(BROADCAST_MAP_BOUNDS, { padding: 0, duration: 0 });
          } else {
            map.fitBounds(KOREA_MAP_BOUNDS, { padding: 12, duration: 0 });
          }
        }, 450),
      );
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isFullscreen, isBroadcast]);

  const enterBroadcastMode = useCallback(() => {
    setIsBroadcast(true);
    if (!fullscreenMode) {
      toggleFullscreen();
    }
  }, [fullscreenMode, toggleFullscreen]);

  const exitBroadcastMode = useCallback(() => {
    setIsBroadcast(false);
    setIsPlaying(false);
    setPlayTarget(null);
    if (fullscreenMode) {
      toggleFullscreen();
    }
  }, [fullscreenMode, toggleFullscreen]);

  // Esc 등으로 전체화면이 풀리면 방송모드도 함께 종료한다.
  useEffect(() => {
    if (!isFullscreen) {
      setIsBroadcast(false);
    }
  }, [isFullscreen]);

  // 방송모드 지도 배색 전환 (스타일 로딩 전이면 준비되는 대로 적용)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return undefined;
    }
    const theme = isBroadcast ? MAP_COLOR_THEMES.broadcast : MAP_COLOR_THEMES.default;
    const applyTheme = () => {
      try {
        map.setPaintProperty('sea', 'background-color', theme.sea);
        map.setPaintProperty('neighbor-land', 'fill-color', theme.neighborLand);
        map.setPaintProperty('neighbor-coast', 'line-color', theme.neighborCoast);
        map.setPaintProperty('land', 'fill-color', theme.land);
        map.setPaintProperty('province-border', 'line-color', theme.provinceBorder);
        return true;
      } catch {
        return false;
      }
    };

    if (map.isStyleLoaded() && applyTheme()) {
      return undefined;
    }
    const retry = () => {
      if (applyTheme()) {
        map.off('styledata', retry);
      }
    };
    map.on('styledata', retry);
    return () => map.off('styledata', retry);
  }, [isBroadcast]);

  // 방송모드에서는 끊김 없는 재생을 위해 전 구간 프레임을 미리 받아 둔다.
  useEffect(() => {
    if (!isBroadcast || status !== 'ready') {
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
  }, [isBroadcast, status, frames, loadFrameData]);

  // 컨트롤바(재생 버튼 + 슬라이더 + 눈금). 방송모드에서는 어두운 배경 위에 얹는다.
  const renderTimeline = (broadcast) => (
    <div className="flex items-center gap-3">
      {broadcast ? (
        <select
          value={playDurationSec}
          onChange={(event) => setPlayDurationSec(Number(event.target.value))}
          className="h-9 shrink-0 cursor-pointer rounded-full border-0 bg-white/25 px-2.5 text-sm font-semibold text-white outline-none backdrop-blur-sm"
          aria-label="재생 길이"
        >
          {BROADCAST_PLAY_DURATIONS.map((seconds) => (
            <option key={seconds} value={seconds} className="text-slate-900">
              {seconds}초
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        onClick={handlePlayButton}
        disabled={status !== 'ready'}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0033a0] text-white shadow-sm transition hover:bg-blue-800 disabled:opacity-40"
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
        {currentFrame ? (
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
          min={-TIMELINE_RANGE_MINUTES}
          max={TIMELINE_RANGE_MINUTES}
          step={5}
          value={currentOffset}
          onChange={(event) => handleTimelineChange(Number(event.target.value))}
          disabled={status !== 'ready'}
          className={`w-full cursor-pointer appearance-none rounded-full accent-[#0033a0] ${broadcast ? 'h-2.5' : 'h-2'}`}
          style={{ background: 'linear-gradient(to right, #64748b 50%, #2563eb 50%)' }}
        />
        <div className="relative mt-1 h-9">
          {timelineTicks.map(({ hourOffset, position, isLabeled, label, dateLabel }) => (
            <div
              key={hourOffset}
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
                    hourOffset === 0
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

      <div className={`relative ${isFullscreen ? 'min-h-0 flex-1' : ''}`}>
        <div
          ref={mapContainerRef}
          className={
            isFullscreen
              ? 'h-full w-full'
              : // 모바일에서는 카드 전체(헤더+지도+컨트롤바)가 한 화면에 들어오도록
                // 지도 높이를 화면 높이에서 나머지 UI 높이를 뺀 값으로 잡는다.
                'h-[calc(100dvh-31rem)] min-h-[280px] w-full sm:h-[60vh] sm:min-h-[420px]'
          }
        />
        {status === 'loading' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium text-slate-500">
            레이더 자료를 불러오는 중입니다…
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 px-6 text-center text-sm font-medium text-red-500">
            {statusMessage || '레이더 자료를 불러오지 못했습니다.'}
          </div>
        ) : null}

        {isBroadcast ? (
          <>
            {/* 좌상단: 타이틀 밴드(참고 그래픽과 동일 위치·비율) + 현재 프레임 날짜·시각 */}
            <div
              className="pointer-events-none absolute z-20 flex items-center gap-[1vw]"
              style={{ left: '4.4%', top: '14%' }}
            >
              <div
                className="flex items-center rounded-sm bg-gradient-to-r from-[#15449f]/95 via-[#2563c9]/95 to-[#3f83e8]/90 shadow-xl"
                style={{
                  width: 'clamp(430px, 29vw, 700px)',
                  height: 'clamp(58px, 7.4vh, 96px)',
                  paddingLeft: '1.3vw',
                  paddingRight: '1.3vw',
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
                    className="mt-[0.2em] font-bold tracking-[0.1em] text-white/90"
                    style={{ fontSize: 'clamp(9px, 0.72vw, 16px)' }}
                  >
                    WEATHER
                  </span>
                  <svg
                    viewBox="0 0 12 12"
                    className="absolute -right-3 -top-1 h-[0.7vw] min-h-2 w-[0.7vw] min-w-2 fill-white/90"
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
                  레이더 영상
                </span>
                {currentFrame ? (
                  <div className="ml-auto flex items-baseline gap-2 whitespace-nowrap">
                    <span
                      className="font-extrabold leading-none tabular-nums text-white"
                      style={{
                        fontSize: 'clamp(22px, 1.7vw, 38px)',
                        textShadow: '0 2px 5px rgba(0,0,0,0.3)',
                      }}
                    >
                      {formatHourMinute(currentFrame.validTime)}
                    </span>
                    <span
                      className="font-semibold text-white/90"
                      style={{ fontSize: 'clamp(13px, 0.95vw, 20px)' }}
                    >
                      {formatBroadcastDate(currentFrame.validTime)}
                    </span>
                    {currentFrame.kind === 'fct' ? (
                      <span className="rounded bg-white/25 px-1.5 py-0.5 text-xs font-bold text-white">
                        예측
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {/* 종료 버튼 */}
            <button
              type="button"
              onClick={exitBroadcastMode}
              className="absolute right-14 top-4 z-20 inline-flex items-center gap-1.5 rounded-full bg-slate-900/55 px-3 py-2 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-slate-900/75"
              aria-label="방송모드 종료"
            >
              <X size={16} />
              종료
            </button>

            {/* 좌측 세로 강수 스케일 (일반 모드 범례와 동일한 6등분 구성) */}
            <div className="pointer-events-none absolute left-5 top-1/2 z-20 -translate-y-1/2 rounded-lg bg-slate-900/50 px-2 py-2.5 shadow-lg backdrop-blur-sm">
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
              <div className="mt-1.5 text-center text-[9px] font-semibold text-white/80">mm/h</div>
            </div>

            {/* 하단 반투명 컨트롤바 */}
            <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-slate-900/65 via-slate-900/35 to-transparent px-8 pb-4 pt-10">
              {renderTimeline(true)}
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
