import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, MonitorPlay, RefreshCw } from 'lucide-react';
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
} from '../api/accumApi';

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

const RadarMapView = ({ refreshToken = 0, initialBroadcast = false }) => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const transitionFromCanvasRef = useRef(null);
  const transitionToCanvasRef = useRef(null);
  const transitionAnimationRef = useRef(null);
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
  const [fullscreenMode, setFullscreenMode] = useState(initialBroadcast ? 'css' : null); // null | 'native' | 'css'
  const isFullscreen = fullscreenMode !== null;
  // 방송모드: 전체화면 + 방송 그래픽 레이아웃 (PC 전용)
  const [isBroadcast, setIsBroadcast] = useState(initialBroadcast);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [playTarget, setPlayTarget] = useState(null);
  const [playIntervalMs, setPlayIntervalMs] = useState(PLAY_INTERVAL_MS);
  // 누적 강수량 뷰 (방송 운영 보호를 위해 URL에 ?accum=1이 있을 때만 버튼 노출)
  const showAccumFeature = useMemo(
    () => new URLSearchParams(window.location.search).has('accum'),
    [],
  );
  const [broadcastView, setBroadcastView] = useState('radar'); // 'radar' | 'accum'
  const [accumDays, setAccumDays] = useState(1);
  const [accumHours, setAccumHours] = useState([]);
  const [accumIndex, setAccumIndex] = useState(0);
  const [accumStatus, setAccumStatus] = useState('idle'); // idle | loading | ready | error
  const [accumError, setAccumError] = useState('');
  const [accumTop5, setAccumTop5] = useState([]);
  const accumHourlyCacheRef = useRef(new Map()); // 정시 tm → Map<지점, RN_DAY>
  const accumBasesRef = useRef([]); // 기간 내 일 인덱스별 지점 누적 베이스 Map
  const accumStationsRef = useRef(null);
  const accumIdwRef = useRef(null);
  const accumCanvasRef = useRef(null);
  const accumRenderTokenRef = useRef(0);
  const isAccumView = isBroadcast && broadcastView === 'accum' && showAccumFeature;
  const cacheLimitRef = useRef(FRAME_CACHE_LIMIT);
  const navControlRef = useRef(null);
  const navControlAddedRef = useRef(false);
  // 주기적 자동 갱신(눈금·'현재'가 실제 시간을 따라가도록)
  const [autoRefreshTick, setAutoRefreshTick] = useState(0);
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const lastRefreshTokenRef = useRef(refreshToken);
  const lastManualRefreshTickRef = useRef(0);
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
      overlayCanvasRef.current = null;
      transitionFromCanvasRef.current = null;
      transitionToCanvasRef.current = null;
      transitionAnimationRef.current = null;
      navControlRef.current = null;
      navControlAddedRef.current = false;
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
  }, [loadFrameData, rememberFrameBuckets, refreshToken, autoRefreshTick, manualRefreshTick]);

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

  // 현재 프레임 렌더링 (누적 강수량 뷰에서는 레이더 렌더를 중단)
  useEffect(() => {
    if (isAccumView) {
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
  }, [frames, frameIndex, status, renderFrame, loadFrameData, isAccumView]);

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
    playIntervalRef.current = isBroadcast ? playIntervalMs : PLAY_INTERVAL_MS;
  }, [isBroadcast, playIntervalMs]);

  // 방송모드는 선택 지점부터 목표 지점까지를 설정한 재생 길이에 맞춰 진행한다.
  useEffect(() => {
    if (isAccumView) {
      return undefined; // 누적 뷰 재생은 별도 효과에서
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
  }, [isPlaying, frames.length, isBroadcast, playIntervalMs, isAccumView]);

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

  // 방송모드 재생은 목표 지점(현재 또는 예측 끝)에 도달하면 멈춘다.
  useEffect(() => {
    if (!isAccumView && isBroadcast && isPlaying && playTarget !== null && frameIndex >= playTarget) {
      setIsPlaying(false);
    }
  }, [isBroadcast, isPlaying, playTarget, frameIndex, isAccumView]);

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

  // ---------- 누적 강수량 뷰 ----------
  // 관측소 점 자료를 IDW(역거리가중)로 색면 보간해 오버레이 캔버스에 그린다.
  const buildAccumIdw = useCallback(
    (stations) => {
      const STEP = 3;
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

      const NEIGHBORS = 6;
      const CUTOFF_LAND_PX = 60; // 육지: 관측 공백을 보간으로 메움 (1px ≈ 1km)
      const CUTOFF_SEA_PX = 13; // 바다: 섬 관측점 주변만
      const FADE_START_PX = 9;
      const neighborIdx = new Int16Array(latticeW * latticeH * NEIGHBORS).fill(-1);
      const neighborW = new Float32Array(latticeW * latticeH * NEIGHBORS);
      const nodeAlpha = new Uint8Array(latticeW * latticeH);

      for (let ly = 0; ly < latticeH; ly++) {
        const py = ly * STEP + STEP / 2;
        for (let lx = 0; lx < latticeW; lx++) {
          const node = ly * latticeW + lx;
          const isLand = maskData[node * 4 + 3] > 0;
          const cutoff = isLand ? CUTOFF_LAND_PX : CUTOFF_SEA_PX;
          const px = lx * STEP + STEP / 2;
          const candidates = [];
          const cx = Math.floor(px / CELL);
          const cy = Math.floor(py / CELL);
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
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
            const nearest = Math.sqrt(candidates[0][0]);
            const fade =
              nearest <= FADE_START_PX
                ? 1
                : Math.max(
                    0,
                    1 - (nearest - FADE_START_PX) / (CUTOFF_SEA_PX - FADE_START_PX),
                  );
            nodeAlpha[node] = Math.round(OVERLAY_ALPHA * fade);
          }
        }
      }

      return { latticeW, latticeH, NEIGHBORS, neighborIdx, neighborW, nodeAlpha };
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
      const isMidnight = hour.getHours() === 0;
      const hourly = isMidnight ? null : accumHourlyCacheRef.current.get(formatAccumHourTm(hour));
      if (!isMidnight && !hourly) {
        return;
      }

      // 기간 시작일부터 해당 시각의 날 전까지의 일합계 베이스 + 그 시각 RN_DAY
      const periodStart = accumHours[0];
      const dayIndex = Math.round(
        (new Date(hour).setHours(0, 0, 0, 0) - new Date(periodStart).setHours(0, 0, 0, 0)) /
          86400000,
      );
      const base = accumBasesRef.current[dayIndex] ?? null;

      const values = new Float32Array(stations.length).fill(-1);
      stations.forEach((station, index) => {
        if (isMidnight) {
          values[index] = base ? (base.get(station.id) ?? 0) : 0;
          return;
        }
        const hourValue = hourly.get(station.id);
        if (hourValue === undefined) {
          return;
        }
        values[index] = hourValue + (base ? (base.get(station.id) ?? 0) : 0);
      });

      const { latticeW, latticeH, NEIGHBORS, neighborIdx, neighborW, nodeAlpha } = idw;
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
        if (weightSum <= 0) {
          continue;
        }
        const bucket = accumBucket(valueSum / weightSum);
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

      if (transitionAnimationRef.current !== null) {
        cancelAnimationFrame(transitionAnimationRef.current);
        transitionAnimationRef.current = null;
      }
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(latticeCanvas, 0, 0, canvas.width, canvas.height);
      refreshOverlaySource();
    },
    [accumHours, refreshOverlaySource],
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
          ranked.slice(0, 5).map(({ station, total }) => ({
            id: station.id,
            label: formatStationLabel(station),
            mm: Math.round(total * 10) / 10,
          })),
        );

        // 나머지 정시 프레임을 앞에서부터 순차 프리페치
        let cursor = 0;
        const pump = () => {
          if (!isActive || cursor >= hours.length) {
            return;
          }
          const hour = hours[cursor];
          cursor += 1;
          const tm = formatAccumHourTm(hour);
          // 자정 프레임은 시간통계를 쓰지 않으므로 프리페치도 건너뛴다.
          if (hour.getHours() === 0 || accumHourlyCacheRef.current.has(tm)) {
            window.setTimeout(pump, 0);
            return;
          }
          fetchHourlyRnDay(hour)
            .then((data) => {
              if (isActive) {
                accumHourlyCacheRef.current.set(tm, data);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (isActive) {
                window.setTimeout(pump, 120);
              }
            });
        };
        pump();
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
  }, [isAccumView, accumDays, buildAccumIdw]);

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
    const tm = formatAccumHourTm(hour);
    // 자정 프레임은 시간통계가 필요 없다(완결 일합계만 사용).
    if (hour.getHours() === 0 || accumHourlyCacheRef.current.has(tm)) {
      renderAccumFrame(accumIndex);
      return;
    }
    fetchHourlyRnDay(hour)
      .then((data) => {
        accumHourlyCacheRef.current.set(tm, data);
        if (accumRenderTokenRef.current === token) {
          renderAccumFrame(accumIndex);
        }
      })
      .catch(() => {});
  }, [isAccumView, accumStatus, accumHours, accumIndex, renderAccumFrame]);

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
    refreshOverlaySource();
    setIsPlaying(false);
  }, [isAccumView, refreshOverlaySource]);

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
    const timers = [120, 500].map((delay) =>
      window.setTimeout(() => {
        const map = mapRef.current;
        if (!map) {
          return;
        }

        map.resize();
        if (isBroadcast || !window.matchMedia('(max-width: 767px)').matches) {
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

  // 방송모드 진입·해제 시 각 모드의 기본 구도로 화면을 다시 잡는다.
  // 전체화면 상태 갱신과 렌더가 겹쳐도 취소되지 않도록 isBroadcast에만 반응하고,
  // 전환 완료 시점이 브라우저마다 달라 두 번(멱등) 적용해 최종 크기에서 확정한다.
  const previousBroadcastRef = useRef(false);
  useEffect(() => {
    if (previousBroadcastRef.current === isBroadcast) {
      return undefined;
    }
    previousBroadcastRef.current = isBroadcast;

    const timers = [500, 1300].map((delay) =>
      window.setTimeout(() => {
        const map = mapRef.current;
        if (!map) {
          return;
        }
        map.resize();
        if (isBroadcast) {
          map.fitBounds(BROADCAST_MAP_BOUNDS, { padding: 0, duration: 0 });
        } else {
          map.fitBounds(KOREA_MAP_BOUNDS, { padding: 12, duration: 0 });
        }
      }, delay),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isBroadcast]);

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
        map.setPaintProperty('inter-korean-seam', 'fill-color', theme.neighborLand);
        map.setPaintProperty(
          'inter-korean-seam',
          'fill-opacity',
          theme.interKoreanSeamOpacity,
        );
        map.setPaintProperty('neighbor-coast', 'line-color', theme.neighborCoast);
        map.setPaintProperty('land', 'fill-color', theme.land);
        map.setPaintProperty('province-border', 'line-color', theme.provinceBorder);
        map.setPaintProperty('province-border', 'line-opacity', 0);
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
      <button
        type="button"
        onClick={handlePlayButton}
        disabled={status !== 'ready'}
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
        {!isAccumView && currentFrame ? (
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
          min={isAccumView ? 0 : timelineMinOffset}
          max={isAccumView ? Math.max(accumHours.length - 1, 1) : timelineMaxOffset}
          step={isAccumView ? 1 : 5}
          value={isAccumView ? accumIndex : currentOffset}
          onChange={(event) => {
            if (isAccumView) {
              setIsPlaying(false);
              setAccumIndex(Number(event.target.value));
            } else {
              handleTimelineChange(Number(event.target.value));
            }
          }}
          disabled={isAccumView ? accumStatus !== 'ready' : status !== 'ready'}
          className={`relative z-10 w-full cursor-pointer appearance-none rounded-full accent-[#0033a0] ${
            broadcast ? 'broadcast-radar-range h-2.5' : 'h-2'
          }`}
          style={{
            background: isAccumView
              ? '#3b71b8'
              : `linear-gradient(to right, #64748b ${currentPercent}%, #2563eb ${currentPercent}%)`,
          }}
        />
        <div className="relative mt-1 h-9">
          {(isAccumView ? accumTicks : timelineTicks).map(
            ({ offsetMinutes, key, position, isLabeled, label, dateLabel }) => (
            <div
              key={isAccumView ? key : offsetMinutes}
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
        {status === 'loading' && frames.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium text-slate-500">
            레이더 자료를 불러오는 중입니다…
          </div>
        ) : null}
        {status === 'error' ? (
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

        {isBroadcast ? (
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
                  {isAccumView ? '누적 강수량' : '레이더 영상'}
                </span>
                {(isAccumView ? currentAccumHour : currentFrame) ? (
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
                      {formatHourMinute(isAccumView ? currentAccumHour : currentFrame.validTime)}
                    </span>
                    <span
                      className="font-semibold text-[#bdd6fb]"
                      style={{ fontSize: 'clamp(13px, 0.95vw, 20px)' }}
                    >
                      {formatBroadcastDate(isAccumView ? currentAccumHour : currentFrame.validTime)}
                    </span>
                    {!isAccumView && currentFrame?.kind === 'fct' ? (
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
                className="pointer-events-none absolute z-20"
                style={{
                  left: '4.4%',
                  top: 'calc(14% + clamp(58px, 7.4vh, 96px) + 14px)',
                  width: 'clamp(270px, 18vw, 400px)',
                }}
              >
                <div className="overflow-hidden rounded-md bg-slate-900/60 shadow-xl backdrop-blur-sm">
                  <div className="divide-y divide-white/10">
                    {accumTop5.map((row, index) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-2 px-4 py-[0.45vh]"
                        style={{ fontSize: 'clamp(13px, 0.95vw, 20px)' }}
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
            <div className="pointer-events-none absolute left-5 top-1/2 z-20 -translate-y-1/2 rounded-lg bg-slate-900/50 px-2 py-2.5 shadow-lg backdrop-blur-sm">
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

            <div className="absolute bottom-[8.5rem] right-6 z-20 flex items-center gap-2">
              {showAccumFeature ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsPlaying(false);
                    setBroadcastView((view) => (view === 'radar' ? 'accum' : 'radar'));
                  }}
                  className="flex h-10 items-center rounded-full border border-white/25 bg-slate-900/55 px-3 text-sm font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-900/75"
                  aria-label={broadcastView === 'radar' ? '누적 강수량 보기' : '레이더 영상 보기'}
                >
                  {broadcastView === 'radar' ? '누적 강수량' : '레이더 영상'}
                </button>
              ) : null}
              {isAccumView ? (
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
                  onClick={handleRadarRefresh}
                  disabled={status === 'loading'}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-white/25 bg-slate-900/55 text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-900/75 disabled:cursor-wait disabled:opacity-60"
                  aria-label="레이더 영상 새로고침"
                  title="레이더 영상 새로고침"
                >
                  <RefreshCw size={18} className={status === 'loading' ? 'animate-spin' : ''} />
                </button>
              ) : null}
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
