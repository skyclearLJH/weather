import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  Crosshair,
  LocateFixed,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Navigation2,
  FileText,
  RefreshCw,
  X,
} from 'lucide-react';
import SatelliteView from './SatelliteView.jsx';
import TerrainRainOverlay from './TerrainRainOverlay.jsx';
import GlobalModelView from './GlobalModelView.jsx';
import HistoricalCaseComparison from './HistoricalCaseComparison.jsx';
import HistoricalDateTimeInput from './HistoricalDateTimeInput.jsx';
import VideoExportMenu from './VideoExportMenu.jsx';
import WeatherWorkspaceMenu from './WeatherWorkspaceMenu.jsx';
import { updateWorkspaceModeInUrl } from '../utils/weatherWorkspaceMode.js';
import ArticleDraftPanel from './ArticleDraftPanel.jsx';
import {
  attachNearbyObservations,
  buildForecastFacts,
  buildRadarFacts,
} from '../utils/radarFacts.js';
import {
  findPeakPoint,
  findProvinceAt,
  nearestPlaceName,
  provinceExtent,
  zoomForAreaRatio,
} from '../utils/autoVideoCamera.js';
import {
  applyPlayCamera,
  captureCamera,
  clearPlayRange,
  readPlayRange,
  resolvePlayRange,
  writePlayRange,
} from '../utils/broadcastPlayRange.js';
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
  floorToTenMinutes,
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
import { fetchServerPrecipitationCurrentRankings } from '../api/weatherApi';

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
// 임의 기간 상한. 재생 프레임은 MAX_ACCUM_API_FRAMES로 이미 묶여 있어 기간이 늘어도
// 시간통계 호출은 늘지 않지만, 일자료는 하루당 1회씩 필요하다(과거분은 엣지 7일 캐시).
// 31일이면 일자료 최대 30회로 KMA 호출한도에 여유가 있고, 프레임 간격도 하루 이내다.
const MAX_ACCUM_RANGE_DAYS = 31;
// 일자료를 순차로 받으면 31일에 4초 넘게 걸려 동시에 여러 건씩 받는다.
const ACCUM_DAILY_FETCH_CONCURRENCY = 6;
// 표시 프레임 간격: 기간이 길수록 성기게 잡는다. 실제 API 자료는 어차피
// MAX_ACCUM_API_FRAMES개뿐이라 그보다 촘촘한 프레임은 전부 보간값이고,
// 30일을 1시간 단위로 두면 721프레임이 되어 렌더만 무거워진다.
const ACCUM_DISPLAY_STEP_LADDER_HOURS = [1, 2, 3, 6, 12, 24];
const MAX_ACCUM_DISPLAY_FRAMES = 121;
// 브라우저가 실제로 그릴 수 있는 최소 간격. 이보다 짧아지면 프레임을 건너뛴다.
const ACCUM_MIN_FRAME_INTERVAL_MS = 60;

const getInitialBroadcastView = () => {
  const target = new URLSearchParams(window.location.search).get('videoTarget');
  return [
    'radar',
    'tracking',
    'terrain',
    'history',
    'kim',
    'accum',
    'satellite',
    'kim-global',
    'ifs',
    'gfs',
    'compare',
  ].includes(target) ? target : 'radar';
};

const GLOBAL_MODEL_VIEWS = new Set(['kim-global', 'ifs', 'gfs', 'compare']);

const findTimelineRange = (dates, startInput, endInput) => {
  if (dates.length === 0) return null;
  const startMs = Date.parse(startInput);
  const endMs = Date.parse(endInput);
  const firstMatchingIndex = Number.isFinite(startMs)
    ? dates.findIndex((date) => date.getTime() >= startMs)
    : 0;
  const lastMatchingIndex = Number.isFinite(endMs)
    ? dates.findLastIndex((date) => date.getTime() <= endMs)
    : dates.length - 1;
  if (firstMatchingIndex < 0 || lastMatchingIndex < 0) return null;
  return firstMatchingIndex < lastMatchingIndex
    ? { startIndex: firstMatchingIndex, endIndex: lastMatchingIndex }
    : null;
};

const pickAccumDisplayStepHours = (spanHours) =>
  ACCUM_DISPLAY_STEP_LADDER_HOURS.find(
    (step) => spanHours / step + 1 <= MAX_ACCUM_DISPLAY_FRAMES,
  ) ?? ACCUM_DISPLAY_STEP_LADDER_HOURS.at(-1);
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

const OBS_HISTORY_HOURS = 12;
const OBS_FRAME_INTERVAL_MINUTES = 5;
const OBS_FRAME_COUNT = (OBS_HISTORY_HOURS * 60) / OBS_FRAME_INTERVAL_MINUTES + 1; // 최신 포함 과거 12시간
// 초단기예측은 기상청이 6시간까지 주지만, 방송에서는 신뢰도가 높은 앞부분만
// 쓰므로 2시간까지만 타임라인에 올린다.
const QPF_HORIZON_HOURS = 2;
const RADAR_ARCHIVE_MIN_INPUT = '2016-01-01T06:00';
const FRAME_CACHE_LIMIT = 48;
const INITIAL_OBS_PREFETCH_COUNT = 18;
const INITIAL_QPF_PREFETCH_COUNT = 18;
const NEARBY_PREFETCH_RADIUS = 3;
const PLAY_INTERVAL_MS = 450;

const formatLocalDateTimeInput = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

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
const BROADCAST_PLACE_LABEL_LAYER_IDS = [
  'broadcast-sido-label',
  'broadcast-sgg-label',
  'broadcast-emd-label',
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

const setBroadcastPlaceLabelVisibility = (map, visible) => {
  BROADCAST_PLACE_LABEL_LAYER_IDS.forEach((id) => {
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

const TRACKING_PAST_MINUTES = 180;
const TRACKING_FUTURE_MINUTES = 120;
const TRACKING_DEFAULT_POINT = {
  lon: 126.978,
  lat: 37.5665,
  label: '서울',
};
const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
const TRACKING_LAYER_IDS = [
  'tracking-observed-track',
  'tracking-forecast-track',
  'tracking-core-points',
  'tracking-selected-halo',
  'tracking-selected-point',
  'tracking-selected-label',
];

const lonLatToCanvasPoint = (lon, lat, width, height) => {
  if (
    lon < VIEW_BOUNDS.lonMin || lon > VIEW_BOUNDS.lonMax ||
    lat < VIEW_BOUNDS.latMin || lat > VIEW_BOUNDS.latMax
  ) {
    return null;
  }
  const x = Math.floor(((lon - VIEW_BOUNDS.lonMin) / (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin)) * width);
  const yTop = mercatorY(VIEW_BOUNDS.latMax);
  const yBottom = mercatorY(VIEW_BOUNDS.latMin);
  const y = Math.floor(((yTop - mercatorY(lat)) / (yTop - yBottom)) * height);
  if (x < 0 || x >= width || y < 0 || y >= height) return null;
  return { x, y };
};

const canvasPointToLonLat = (x, y, width, height) => {
  const lon = VIEW_BOUNDS.lonMin + ((x + 0.5) / width) * (VIEW_BOUNDS.lonMax - VIEW_BOUNDS.lonMin);
  const yTop = mercatorY(VIEW_BOUNDS.latMax);
  const yBottom = mercatorY(VIEW_BOUNDS.latMin);
  const lat = mercatorYToLat(yTop - ((y + 0.5) / height) * (yTop - yBottom));
  return [lon, lat];
};

const sampleTrackingBucket = (frame, buckets, point, mappings) => {
  if (!frame || !buckets || !point || !mappings) return 0;
  const canvasPoint = lonLatToCanvasPoint(point.lon, point.lat, CANVAS_WIDTH, mappings.radarMap.length / CANVAS_WIDTH);
  if (!canvasPoint) return 0;
  const dataMap = frame.kind === 'obs' ? mappings.radarMap : mappings.qpfMap;
  const sourceIndex = dataMap[canvasPoint.y * CANVAS_WIDTH + canvasPoint.x];
  return sourceIndex >= 0 ? buckets[sourceIndex] ?? 0 : 0;
};

const bucketLowerValue = (bucket) => (bucket > 0 ? RAIN_PALETTE[bucket - 1]?.min ?? 0 : 0);

const formatBucketRange = (bucket) => {
  if (!bucket) return '강수 없음';
  const lower = bucketLowerValue(bucket);
  const upper = RAIN_PALETTE[bucket]?.min;
  return upper ? `${lower}~${upper} mm/h` : `${lower} mm/h 이상`;
};

const bucketColor = (bucket) => {
  const color = bucket > 0 ? RAIN_PALETTE[bucket - 1]?.color : null;
  return color ? `rgb(${color[0]},${color[1]},${color[2]})` : 'rgba(148,163,184,0.22)';
};

const distanceKm = (first, second) => {
  const toRadians = (value) => (value * Math.PI) / 180;
  const lat1 = toRadians(first.lat);
  const lat2 = toRadians(second.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(second.lon - first.lon);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

const findNearestStation = (point, stations, maxDistanceKm = 25) => {
  let nearest = null;
  let nearestDistance = maxDistanceKm;
  stations.forEach((station) => {
    const distance = distanceKm(point, station);
    if (distance < nearestDistance) {
      nearest = station;
      nearestDistance = distance;
    }
  });
  return nearest ? { station: nearest, distance: nearestDistance } : null;
};

const TRACKING_COMPONENT_RADIUS_PX = 110;
const TRACKING_COMPONENT_STEP_PX = 4;
const TRACKING_COMPONENT_MIN_BUCKET = 3;
const TRACKING_COMPONENT_MIN_CELLS = 3;
const TRACKING_LOCAL_CORE_RADIUS_PX = 52;

const coordinateDistanceKm = (first, second) =>
  distanceKm(
    { lon: first[0], lat: first[1] },
    { lon: second[0], lat: second[1] },
  );

// 한 프레임의 강수 픽셀을 연결 성분으로 분리한다. 이후 프레임에서도 같은
// 로컬 격자를 사용하므로 cellSet의 교집합으로 실제 영역 중첩을 비교할 수 있다.
const buildTrackingComponents = (frame, buckets, point, mappings) => {
  if (!frame || !buckets || !point || !mappings) return [];
  const height = mappings.radarMap.length / CANVAS_WIDTH;
  const center = lonLatToCanvasPoint(point.lon, point.lat, CANVAS_WIDTH, height);
  if (!center) return [];
  const dataMap = frame.kind === 'obs' ? mappings.radarMap : mappings.qpfMap;
  const startX = Math.max(0, center.x - TRACKING_COMPONENT_RADIUS_PX);
  const endX = Math.min(CANVAS_WIDTH - 1, center.x + TRACKING_COMPONENT_RADIUS_PX);
  const startY = Math.max(0, center.y - TRACKING_COMPONENT_RADIUS_PX);
  const endY = Math.min(height - 1, center.y + TRACKING_COMPONENT_RADIUS_PX);
  const columns = Math.floor((endX - startX) / TRACKING_COMPONENT_STEP_PX) + 1;
  const rows = Math.floor((endY - startY) / TRACKING_COMPONENT_STEP_PX) + 1;
  const grid = new Uint8Array(columns * rows);

  for (let row = 0; row < rows; row += 1) {
    const y = startY + row * TRACKING_COMPONENT_STEP_PX;
    for (let column = 0; column < columns; column += 1) {
      const x = startX + column * TRACKING_COMPONENT_STEP_PX;
      if (
        (x - center.x) ** 2 + (y - center.y) ** 2 >
        TRACKING_COMPONENT_RADIUS_PX ** 2
      ) {
        continue;
      }
      const sourceIndex = dataMap[y * CANVAS_WIDTH + x];
      const bucket = sourceIndex >= 0 ? buckets[sourceIndex] ?? 0 : 0;
      if (bucket >= TRACKING_COMPONENT_MIN_BUCKET) grid[row * columns + column] = bucket;
    }
  }

  const visited = new Uint8Array(grid.length);
  const components = [];
  for (let start = 0; start < grid.length; start += 1) {
    if (visited[start] || grid[start] === 0) continue;
    visited[start] = 1;
    const queue = [start];
    const cellSet = new Set();
    const cells = [];
    let cursor = 0;
    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;
    let maxBucket = 0;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;

    while (cursor < queue.length) {
      const index = queue[cursor];
      cursor += 1;
      const row = Math.floor(index / columns);
      const column = index % columns;
      const x = startX + column * TRACKING_COMPONENT_STEP_PX;
      const y = startY + row * TRACKING_COMPONENT_STEP_PX;
      const bucket = grid[index];
      const weight = Math.max(1, bucketLowerValue(bucket)) ** 1.2;
      cellSet.add(index);
      cells.push({ index, x, y, bucket });
      totalWeight += weight;
      weightedX += x * weight;
      weightedY += y * weight;
      maxBucket = Math.max(maxBucket, bucket);
      nearestDistanceSquared = Math.min(
        nearestDistanceSquared,
        (x - center.x) ** 2 + (y - center.y) ** 2,
      );

      for (let deltaRow = -1; deltaRow <= 1; deltaRow += 1) {
        for (let deltaColumn = -1; deltaColumn <= 1; deltaColumn += 1) {
          if (deltaRow === 0 && deltaColumn === 0) continue;
          const nextRow = row + deltaRow;
          const nextColumn = column + deltaColumn;
          if (nextRow < 0 || nextRow >= rows || nextColumn < 0 || nextColumn >= columns) continue;
          const nextIndex = nextRow * columns + nextColumn;
          if (visited[nextIndex] || grid[nextIndex] === 0) continue;
          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }
    }

    if (cellSet.size < TRACKING_COMPONENT_MIN_CELLS || totalWeight === 0) continue;
    components.push({
      cellSet,
      cells,
      area: cellSet.size,
      maxBucket,
      nearestDistancePx: Math.sqrt(nearestDistanceSquared),
      coordinates: canvasPointToLonLat(
        weightedX / totalWeight,
        weightedY / totalWeight,
        CANVAS_WIDTH,
        height,
      ),
      canvasHeight: height,
    });
  }
  return components;
};

const localizeTrackingComponent = (component, anchorCoordinates) => {
  const anchor = lonLatToCanvasPoint(
    anchorCoordinates[0],
    anchorCoordinates[1],
    CANVAS_WIDTH,
    component.canvasHeight,
  );
  if (!anchor) return null;
  const localCells = component.cells.filter(
    (cell) =>
      (cell.x - anchor.x) ** 2 + (cell.y - anchor.y) ** 2 <=
      TRACKING_LOCAL_CORE_RADIUS_PX ** 2,
  );
  if (localCells.length < 2) return null;
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  let maxBucket = 0;
  const cellSet = new Set();
  localCells.forEach((cell) => {
    const weight = Math.max(1, bucketLowerValue(cell.bucket)) ** 1.2;
    cellSet.add(cell.index);
    totalWeight += weight;
    weightedX += cell.x * weight;
    weightedY += cell.y * weight;
    maxBucket = Math.max(maxBucket, cell.bucket);
  });
  return {
    ...component,
    cells: localCells,
    cellSet,
    area: localCells.length,
    maxBucket,
    coordinates: canvasPointToLonLat(
      weightedX / totalWeight,
      weightedY / totalWeight,
      CANVAS_WIDTH,
      component.canvasHeight,
    ),
  };
};

const selectInitialTrackingComponent = (components, point) => {
  const nearby = components.filter(
    (component) => component.nearestDistancePx <= TRACKING_COMPONENT_RADIUS_PX * 0.72,
  );
  if (nearby.length === 0) return null;
  const nearestDistance = Math.min(...nearby.map((component) => component.nearestDistancePx));
  const selected = nearby
    .filter((component) => component.nearestDistancePx <= nearestDistance + 8)
    .sort(
      (first, second) =>
        second.maxBucket - first.maxBucket ||
        second.area - first.area ||
        first.nearestDistancePx - second.nearestDistancePx,
    )[0];
  return localizeTrackingComponent(selected, [point.lon, point.lat]);
};

const getComponentOverlap = (first, second) => {
  const [smaller, larger] =
    first.cellSet.size <= second.cellSet.size
      ? [first.cellSet, second.cellSet]
      : [second.cellSet, first.cellSet];
  let intersection = 0;
  smaller.forEach((cell) => {
    if (larger.has(cell)) intersection += 1;
  });
  return {
    overlap: intersection / Math.max(1, Math.min(first.area, second.area)),
    iou: intersection / Math.max(1, first.area + second.area - intersection),
  };
};

const predictTrackingCoordinate = (reference, previous, targetTime) => {
  if (!previous) return reference.component.coordinates;
  const referenceTime = reference.item.validTime.getTime();
  const previousTime = previous.item.validTime.getTime();
  const interval = referenceTime - previousTime;
  if (interval === 0) return reference.component.coordinates;
  const ratio = (targetTime.getTime() - referenceTime) / interval;
  return [
    reference.component.coordinates[0] +
      (reference.component.coordinates[0] - previous.component.coordinates[0]) * ratio,
    reference.component.coordinates[1] +
      (reference.component.coordinates[1] - previous.component.coordinates[1]) * ratio,
  ];
};

const matchTrackingComponent = (reference, previous, targetItem, candidates) => {
  const elapsedMinutes = Math.max(
    1,
    Math.abs(targetItem.validTime.getTime() - reference.item.validTime.getTime()) / 60000,
  );
  const predicted = predictTrackingCoordinate(reference, previous, targetItem.validTime);
  const maxDistanceKm = Math.min(42, 9 + elapsedMinutes * 2.1);
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  candidates.forEach((candidate) => {
    const localizedCandidate = localizeTrackingComponent(candidate, predicted);
    if (!localizedCandidate) return;
    const distanceFromReference = coordinateDistanceKm(
      reference.component.coordinates,
      localizedCandidate.coordinates,
    );
    const distanceFromPrediction = coordinateDistanceKm(predicted, localizedCandidate.coordinates);
    const { overlap, iou } = getComponentOverlap(reference.component, localizedCandidate);
    const areaContinuity =
      Math.min(reference.component.area, localizedCandidate.area) /
      Math.max(reference.component.area, localizedCandidate.area);
    if (distanceFromReference > maxDistanceKm * 1.55) return;
    if (overlap < 0.04 && distanceFromPrediction > maxDistanceKm) return;
    if (areaContinuity < 0.08 && overlap < 0.25) return;

    const distanceScore = Math.max(0, 1 - distanceFromPrediction / maxDistanceKm);
    const score = overlap * 5 + iou * 3 + distanceScore * 2 + areaContinuity;
    if (score > bestScore) {
      bestScore = score;
      best = localizedCandidate;
    }
  });
  return bestScore >= 1.2 ? best : null;
};

const trackObservedComponents = (items, initialComponent) => {
  if (!initialComponent || items.length === 0) return [];
  const tracked = [{ item: items.at(-1), component: initialComponent }];
  let reference = tracked[0];
  let previous = null;
  for (let index = items.length - 2; index >= 0; index -= 1) {
    const item = items[index];
    const matched = matchTrackingComponent(reference, previous, item, item.components);
    if (!matched) break;
    const next = { item, component: matched };
    tracked.unshift(next);
    previous = reference;
    reference = next;
  }
  return tracked;
};

const trackForecastComponents = (items, observedTrack, point) => {
  if (items.length === 0) return [];
  let reference = observedTrack.at(-1) ?? null;
  let previous = observedTrack.length >= 2 ? observedTrack.at(-2) : null;
  const tracked = [];

  for (const item of items) {
    let matched = reference
      ? matchTrackingComponent(reference, previous, item, item.components)
      : selectInitialTrackingComponent(item.components, point);
    if (!matched) break;
    const next = { item, component: matched };
    tracked.push(next);
    previous = reference;
    reference = next;
  }
  return tracked;
};

const formatTrackingDirection = (points) => {
  if (points.length < 2) return '경로 불충분';
  const first = points[0];
  const last = points.at(-1);
  const meanLat = ((first[1] + last[1]) / 2) * (Math.PI / 180);
  const east = (last[0] - first[0]) * Math.cos(meanLat);
  const north = last[1] - first[1];
  if (Math.hypot(east, north) < 0.08) return '정체';
  const bearing = (Math.atan2(east, north) * 180) / Math.PI;
  const normalized = (bearing + 360) % 360;
  const labels = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  return `${labels[Math.round(normalized / 45) % 8]}쪽`;
};

const ensureTrackingLayers = (map) => {
  if (!map.getSource('tracking-path')) {
    map.addSource('tracking-path', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  }
  if (!map.getSource('tracking-selected')) {
    map.addSource('tracking-selected', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION });
  }
  const layers = [
    {
      id: 'tracking-observed-track',
      type: 'line',
      source: 'tracking-path',
      filter: ['==', ['get', 'phase'], 'observed'],
      paint: { 'line-color': '#22d3ee', 'line-width': 5, 'line-opacity': 0.92 },
    },
    {
      id: 'tracking-forecast-track',
      type: 'line',
      source: 'tracking-path',
      filter: ['==', ['get', 'phase'], 'forecast'],
      paint: { 'line-color': '#facc15', 'line-width': 4, 'line-opacity': 0.9, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'tracking-core-points',
      type: 'circle',
      source: 'tracking-path',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 3, 9, 6],
        'circle-color': ['match', ['get', 'phase'], 'forecast', '#facc15', '#22d3ee'],
        'circle-stroke-color': '#0f172a',
        'circle-stroke-width': 1.2,
      },
    },
    {
      id: 'tracking-selected-halo',
      type: 'circle',
      source: 'tracking-selected',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 10, 9, 17],
        'circle-color': 'rgba(255,255,255,0.15)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'tracking-selected-point',
      type: 'circle',
      source: 'tracking-selected',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4.5, 4, 9, 7],
        'circle-color': '#0f172a',
        'circle-stroke-color': '#f8fafc',
        'circle-stroke-width': 2,
      },
    },
    {
      id: 'tracking-selected-label',
      type: 'symbol',
      source: 'tracking-selected',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Bold'],
        'text-size': 14,
        'text-offset': [0, 1.25],
        'text-anchor': 'top',
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    },
  ];
  layers.forEach((layer) => {
    if (!map.getLayer(layer.id)) map.addLayer({ ...layer, layout: { visibility: 'visible', ...layer.layout } });
  });
};

const setTrackingLayerVisibility = (map, visible) => {
  if (visible) ensureTrackingLayers(map);
  TRACKING_LAYER_IDS.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  });
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
  return {
    baseIndex,
    fractionX,
    fractionY,
    gridWidth: meta.width,
    gridHeight: meta.height,
  };
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

const OBS_TIMELINE_RANGE_MINUTES = OBS_HISTORY_HOURS * 60;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 레이더 발표 주기에 맞춘 자동 갱신

// --- 방송모드 ---
const BROADCAST_PLAY_DURATIONS = Array.from({ length: 11 }, (_, index) => index + 5); // 5~15초
// 전 구간(관측 12시간 + 예측 2시간 ≒ 157프레임) 재생을 위해 모든 프레임을 캐시
const BROADCAST_CACHE_LIMIT = 170;
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

const TrackingAnalysisPanel = ({
  point,
  series,
  currentFrameIndex,
  latestObservationIndex,
  direction,
  isLoading,
  onSelectFrame,
  onReturnToCurrent,
  onResetMap,
  onClose,
}) => {
  const selected = series.find((item) => item.frameIndex === currentFrameIndex) ?? null;
  const latestObserved = series.find((item) => item.frameIndex === latestObservationIndex) ?? null;
  const forecast = series.filter((item) => item.kind === 'fct');
  const arrival = forecast.find((item) => item.bucket > 0) ?? null;
  const peak = forecast.reduce(
    (strongest, item) => (item.bucket > (strongest?.bucket ?? 0) ? item : strongest),
    null,
  );
  const nowMs = latestObserved?.validTime?.getTime?.() ?? null;
  const arrivalMinutes = arrival && nowMs !== null
    ? Math.max(0, Math.round((arrival.validTime.getTime() - nowMs) / 60000))
    : null;
  const arrivalLabel = latestObserved?.bucket > 0
    ? '지나는 중'
    : arrivalMinutes !== null
      ? `${arrivalMinutes}분 후`
      : '2시간 내 없음';
  return (
    <aside
      className="absolute z-20 w-[390px] max-w-[calc(100vw-7rem)] overflow-hidden rounded-md border border-white/15 bg-slate-950/78 text-white shadow-2xl backdrop-blur-md"
      style={{ left: '6.5%', top: '25%' }}
      aria-label="호우 추적 지점 분석"
    >
      <div className="flex items-start gap-3 border-b border-white/10 px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-400 text-slate-950">
          <Crosshair size={19} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold text-cyan-200">분석 지점</div>
          <div className="truncate text-lg font-black">{point?.label ?? '선택 지점'}</div>
        </div>
        <div data-video-hide className="flex gap-1.5">
          <button
            type="button"
            onClick={onReturnToCurrent}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white/8 text-white transition hover:bg-white/15"
            aria-label="현재 시각으로 이동"
            title="현재 시각"
          >
            <LocateFixed size={17} />
          </button>
          <button
            type="button"
            onClick={onResetMap}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white/8 text-white transition hover:bg-white/15"
            aria-label="전국 화면으로 이동"
            title="전국 화면"
          >
            <MapIcon size={17} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white/8 text-white transition hover:bg-white/15"
            aria-label="지점 분석 닫기"
            title="닫기"
          >
            <X size={17} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-white/10">
        {[
          ['선택 강도', selected ? formatBucketRange(selected.bucket) : '-'],
          ['비 도달', isLoading ? '분석 중' : arrivalLabel],
          ['향후 2시간 최고', peak?.bucket ? formatBucketRange(peak.bucket) : '강수 없음'],
          ['주변 강수대 이동', direction],
        ].map(([label, value], index) => (
          <div key={label} className="bg-slate-950/75 px-3.5 py-2.5">
            <div className="text-[10px] font-bold text-white/55">{label}</div>
            <div className={`mt-0.5 truncate text-sm font-black ${index === 1 ? 'text-yellow-300' : 'text-white'}`}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between text-[10px] font-bold">
          <span className="text-cyan-200">관측 3시간</span>
          <span className="text-white/55">레이더 강도 변화</span>
          <span className="text-yellow-200">예측 2시간</span>
        </div>
        <div className="relative flex h-20 items-end gap-[2px] border-b border-white/25">
          {series.map((item) => {
            const value = bucketLowerValue(item.bucket);
            const height = item.bucket
              ? Math.max(3, getLegendLabelPosition(value))
              : 2;
            const isSelected = item.frameIndex === currentFrameIndex;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelectFrame(item.frameIndex)}
                className={`relative min-w-0 flex-1 rounded-t-[2px] transition ${
                  isSelected ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-950' : 'opacity-85 hover:opacity-100'
                }`}
                style={{ height: `${height}%`, backgroundColor: bucketColor(item.bucket) }}
                aria-label={`${formatHourMinute(item.validTime)} ${item.kind === 'obs' ? '관측' : '예측'} ${formatBucketRange(item.bucket)}`}
                title={`${formatHourMinute(item.validTime)} · ${formatBucketRange(item.bucket)}`}
              />
            );
          })}
          {isLoading ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/35 text-xs font-bold text-white/75">
              분석 중
            </div>
          ) : null}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] font-semibold tabular-nums text-white/55">
          <span>{series[0] ? formatHourMinute(series[0].validTime) : '--:--'}</span>
          <span className="flex items-center gap-1 text-white/75">
            <Navigation2 size={11} aria-hidden="true" />
            현재
          </span>
          <span>{series.at(-1) ? formatHourMinute(series.at(-1).validTime) : '--:--'}</span>
        </div>
      </div>
    </aside>
  );
};

const RadarMapView = ({
  refreshToken = 0,
  initialBroadcast = false,
  initialWorkspaceMode = 'edit',
}) => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const videoCaptureTransitionRef = useRef(false);
  const overlayCanvasRef = useRef(null);
  const transitionFromCanvasRef = useRef(null);
  const transitionToCanvasRef = useRef(null);
  const transitionAnimationRef = useRef(null);
  const [articleAnalysis, setArticleAnalysis] = useState(null);
  const [articleBuildStatus, setArticleBuildStatus] = useState('idle');
  const [articleBuildError, setArticleBuildError] = useState('');
  // 원고와 목소리는 패널 밖에 둔다. 패널을 닫아도 손본 원고가 남아야
  // 그대로 영상에 실린다.
  const [narrationScript, setNarrationScript] = useState('');
  const [narrationVoice, setNarrationVoice] = useState('ko-KR-Neural2-B');
  const [narrationRate, setNarrationRate] = useState(1.1);
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
  // 재생이 끝까지 가 멈춘 상태 → 컨트롤 버튼을 '처음으로'로 바꾼다(방송에서 첫 장면
  // 대기용). 버튼을 누르면 첫 장면으로 이동해 정지하고, 다시 누르면 처음부터 재생.
  const [playbackFinished, setPlaybackFinished] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [statusMessage, setStatusMessage] = useState('');
  // 전체화면: 지원 브라우저는 네이티브 API, 미지원(iOS 사파리 등)은 CSS 오버레이로 대체
  const sectionRef = useRef(null);
  const [fullscreenMode, setFullscreenMode] = useState(initialBroadcast ? 'css' : null); // null | 'native' | 'css'
  const isFullscreen = fullscreenMode !== null;
  // 방송모드: 전체화면 + 방송 그래픽 레이아웃 (PC 전용)
  const [isBroadcast, setIsBroadcast] = useState(initialBroadcast);
  const [isBroadcastMapReady, setIsBroadcastMapReady] = useState(initialBroadcast);
  const [workspaceMode, setWorkspaceMode] = useState(initialWorkspaceMode);
  const [showPlaceLabels, setShowPlaceLabels] = useState(true);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [playTarget, setPlayTarget] = useState(null);
  // 이번 playTarget이 타임라인의 진짜 끝인지. 구간 지정 없이 재생하면 '현재'에서
  // 한 번 멈추는데, 이는 관측→예측을 잇는 중간 정거장이라 '처음으로'로 바꾸지
  // 않고 재생 버튼을 유지해 미래로 이어 볼 수 있게 한다.
  const playTargetIsFinalRef = useRef(true);
  const [playIntervalMs, setPlayIntervalMs] = useState(PLAY_INTERVAL_MS);
  const [broadcastView, setBroadcastView] = useState(getInitialBroadcastView);
  const [kimFrames, setKimFrames] = useState([]);
  const [kimIndex, setKimIndex] = useState(0);
  const [kimStatus, setKimStatus] = useState('idle'); // idle | loading | ready | error
  const [kimError, setKimError] = useState('');
  const [kimRefreshTick, setKimRefreshTick] = useState(0);
  const [kimPlayIntervalMs, setKimPlayIntervalMs] = useState(PLAY_INTERVAL_MS);
  const [kimPlayTarget, setKimPlayTarget] = useState(null);
  const [accumDays, setAccumDays] = useState(1);
  const [accumHours, setAccumHours] = useState([]);
  const [accumIndex, setAccumIndex] = useState(0);
  const [accumStatus, setAccumStatus] = useState('idle'); // idle | loading | ready | error
  const [accumError, setAccumError] = useState('');
  const [accumTop5, setAccumTop5] = useState([]);
  const [accumDisplayMode, setAccumDisplayMode] = useState('flat'); // 'flat' | '3d'
  const [accum3dStyle, setAccum3dStyle] = useState('columns'); // 'columns' | 'surface'
  const [accumPlayRange, setAccumPlayRange] = useState(null);
  // 임의 기간: 입력값은 타이핑마다 재조회하지 않도록 '적용'을 눌러야 range에 반영된다.
  const [accumRangeMode, setAccumRangeMode] = useState('preset'); // 'preset' | 'custom'
  const [accumCustomStartInput, setAccumCustomStartInput] = useState('');
  const [accumCustomEndInput, setAccumCustomEndInput] = useState('');
  const [accumCustomRange, setAccumCustomRange] = useState(null); // { startMs, endMs }
  // 시작 시각이 자정이 아니면 그 시점까지의 당일 누적을 빼야 하므로 기준값을 들고 있는다.
  const accumStartBaselineRef = useRef(null);
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
  const isRadarView = isBroadcast && broadcastView === 'radar';
  const isTrackingView = isBroadcast && broadcastView === 'tracking';
  const isTerrainView = isBroadcast && broadcastView === 'terrain';
  const isHistoricalView = isBroadcast && broadcastView === 'history';
  const isGlobalModelView = isBroadcast && GLOBAL_MODEL_VIEWS.has(broadcastView);
  const isRadarDataView = isRadarView || isTrackingView || isTerrainView;
  const [trackingPoint, setTrackingPoint] = useState(TRACKING_DEFAULT_POINT);
  const [trackingStations, setTrackingStations] = useState([]);
  const [trackingSeries, setTrackingSeries] = useState([]);
  const [trackingPathData, setTrackingPathData] = useState(EMPTY_FEATURE_COLLECTION);
  const [trackingDirection, setTrackingDirection] = useState('분석 중');
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingAnalysisTick, setTrackingAnalysisTick] = useState(0);
  const [playRangeVersion, setPlayRangeVersion] = useState(0);
  // 지도 인스턴스가 만들어진 시점을 알리는 신호. 지도를 만지는 효과가 지도 생성
  // 효과보다 먼저 선언돼 있어, 이 값이 바뀔 때 다시 적용될 기회를 준다.
  const [mapInstanceReady, setMapInstanceReady] = useState(false);

  // 지도를 만드는 효과보다 이 효과가 먼저 실행되므로, 처음에는 mapRef가 비어 있다.
  // mapInstanceReady가 없으면 강수량/지형호우로 바로 진입했을 때(방송 URL의
  // videoTarget=accum 등) isAccumView가 처음부터 true라 효과가 다시 돌지 않아
  // 회전이 영영 꺼진 채로 남는다. 지도가 생긴 뒤 한 번 더 적용한다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isAccumView || isTerrainView) {
      map.dragRotate.enable();
      return;
    }
    map.dragRotate.disable();
    map.dragRotate._mousePitch?.enable();
    if (Math.abs(map.getBearing()) > 0.01) {
      map.easeTo({ bearing: 0, duration: 350 });
    }
  }, [isAccumView, isTerrainView, mapInstanceReady]);

  // 레이더 화면 위 '시간당 강수량' 최다 5지점 표 (체크박스로 켜고 끈다).
  // 자료는 일반 페이지 '강수량 > 60분 현재'와 같은 서버 랭킹(precipitation-current)을 쓴다.
  const [showHourlyTop5, setShowHourlyTop5] = useState(false);
  const [showAccumTop5, setShowAccumTop5] = useState(false);
  const [hourlyTop5, setHourlyTop5] = useState([]);
  const [hourlyObservations, setHourlyObservations] = useState([]);

  useEffect(() => {
    if (!isRadarView) {
      return undefined;
    }
    let isActive = true;

    const load = async () => {
      try {
        const data = await fetchServerPrecipitationCurrentRankings();
        if (!isActive) return;
        const rows = (data?.oneHour ?? [])
          .map((item, index) => ({
            id: `${item.rank ?? index}-${item.name ?? ''}`,
            stationId: item.stationId ?? null,
            name: item.name ?? '',
            // 누적 강수량 표와 같은 '광역 시군(지점명)' 표기를 그대로 쓴다
            label: formatStationLabel({ name: item.name, address: item.address }),
            value: Number.parseFloat(String(item.record ?? '')) || 0,
            lon: Number(item.lon),
            lat: Number(item.lat),
            observedAt: data?.observedAt ?? null,
          }));
        setHourlyObservations(rows);
        setHourlyTop5(rows.slice(0, 5).map((row) => ({ ...row, mm: row.value })));
      } catch {
        if (isActive) {
          setHourlyObservations([]);
          setHourlyTop5([]);
        }
      }
    };

    load();
    // 관측이 10분 단위로 갱신되므로 주기적으로 다시 읽는다.
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      isActive = false;
      clearInterval(timer);
    };
  }, [isRadarView, refreshToken]);
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
  const [radarHistoryEnd, setRadarHistoryEnd] = useState(null);
  const [radarHistoryInput, setRadarHistoryInput] = useState('');
  const [isRadarHistoryPickerOpen, setIsRadarHistoryPickerOpen] = useState(false);
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
    setMapInstanceReady(true);
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
      setMapInstanceReady(false);
      accumSurfaceLayerRef.current = null;
      overlayCanvasRef.current = null;
      transitionFromCanvasRef.current = null;
      transitionToCanvasRef.current = null;
      transitionAnimationRef.current = null;
      navControlRef.current = null;
      navControlAddedRef.current = false;
    };
  }, [canvasHeight]);

  useEffect(() => {
    if (!isTrackingView || trackingStations.length > 0) return undefined;
    let isActive = true;
    fetchAwsStationCoords()
      .then((stations) => {
        if (isActive) setTrackingStations(stations);
      })
      .catch(() => {});
    return () => {
      isActive = false;
    };
  }, [isTrackingView, trackingStations.length]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const apply = () => {
      setTrackingLayerVisibility(map, isTrackingView);
      const selectedSource = map.getSource('tracking-selected');
      selectedSource?.setData(
        isTrackingView && trackingPoint
          ? {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  properties: { label: trackingPoint.label },
                  geometry: { type: 'Point', coordinates: [trackingPoint.lon, trackingPoint.lat] },
                },
              ],
            }
          : EMPTY_FEATURE_COLLECTION,
      );
      map.getSource('tracking-path')?.setData(
        isTrackingView ? trackingPathData : EMPTY_FEATURE_COLLECTION,
      );
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
    return () => map.off('load', apply);
  }, [isTrackingView, trackingPathData, trackingPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isTrackingView) return undefined;
    const canvas = map.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    const handleMapClick = (event) => {
      const point = { lon: event.lngLat.lng, lat: event.lngLat.lat };
      const nearest = findNearestStation(point, trackingStations, 18);
      const label = nearest
        ? `${formatStationLabel(nearest.station)} 부근`
        : `${point.lat.toFixed(2)}°N, ${point.lon.toFixed(2)}°E`;
      setIsPlaying(false);
      setTrackingPoint({ ...point, label });
      map.easeTo({ center: [point.lon, point.lat], zoom: Math.max(7.2, map.getZoom()), duration: 650 });
    };
    map.on('click', handleMapClick);
    return () => {
      map.off('click', handleMapClick);
      canvas.style.cursor = previousCursor;
    };
  }, [isTrackingView, trackingStations]);

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
        fitBroadcastFlatView(map, 650);
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

      // 프레임은 전환 효과 없이 바로 교체한다. 두 장을 알파로 겹치는 크로스디졸브는
      // 넓은 색면에서 합성 알파가 원본보다 낮아져 오버레이가 옅어졌다 돌아오는
      // 깜빡임이 생기고, 이전 장을 불투명하게 깔면 새 장의 빈 곳으로 옛 장이 비쳐
      // 잔상이 쌓인다. 실제로 방송 장비에서 재생 중 번쩍임이 났고(슬라이더로 앞뒤
      // 이동은 멀쩡했다 — 그쪽이 이 즉시 교체 경로다), 레이더는 프레임 간격이 촘촘해
      // 전환 효과가 없어도 충분히 부드럽다. 누적 강수량도 같은 이유로 즉시 교체한다.
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(toCanvas, 0, 0);
      hasRenderedFrameRef.current = true;
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
          const mapping = kimMappingRef.current;
          if (
            mapping &&
            (data.width !== mapping.gridWidth || data.height !== mapping.gridHeight)
          ) {
            throw new Error('KIM 강수 격자 버전이 일치하지 않습니다. 새로고침해 주세요.');
          }
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

      if (
        radarHistoryEnd &&
        !isManualRefresh &&
        lastBuildSignatureRef.current.startsWith('history|')
      ) {
        return;
      }

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
        const radarAnchor = radarHistoryEnd ?? new Date();
        const [radarLatest, qpfLatest] = await Promise.all([
          probeLatestRadarTm(
            radarAnchor,
            radarHistoryEnd ? 60 : OBS_HISTORY_HOURS * 60,
            ({ tm, frame }) => rememberFrameBuckets(`obs-${tm}`, frame.buckets),
            { broadcast: isBroadcast },
          ),
          radarHistoryEnd ? Promise.resolve(null) : probeLatestQpfTm().catch(() => null),
        ]);
        if (!isActive) {
          return;
        }

        // 자동 갱신인데 최신 발표가 그대로면 타임라인을 건드리지 않는다.
        const buildSignature =
          `${radarHistoryEnd ? 'history' : 'latest'}|` +
          `${radarLatest.tm}|${qpfLatest?.tm ?? ''}`;
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

        const forecastLimitMs =
          latestObsTime.getTime() + QPF_HORIZON_HOURS * 60 * 60 * 1000;
        const forecastFrames = (qpfLatest?.frames ?? [])
          .filter(
            ({ validTime }) =>
              validTime > latestObsTime && validTime.getTime() <= forecastLimitMs,
          )
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

        // 12시간 전체를 한 번에 받으면 API와 브라우저 메모리에 부담이 커서 최신 주변부터 천천히 받는다.
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
    radarHistoryEnd,
  ]);

  useEffect(() => {
    if (!isTrackingView || status !== 'ready' || frames.length === 0 || !trackingPoint) {
      return undefined;
    }
    const mappings = mappingsRef.current;
    if (!mappings) {
      const timer = window.setTimeout(
        () => setTrackingAnalysisTick((value) => value + 1),
        180,
      );
      return () => window.clearTimeout(timer);
    }

    const latestObservation = frames.filter((frame) => frame.kind === 'obs').at(-1);
    if (!latestObservation) return undefined;
    const baseMs = latestObservation.validTime.getTime();
    const targets = frames
      .map((frame, frameIndexValue) => ({ frame, frameIndex: frameIndexValue }))
      .filter(({ frame }) => {
        const offsetMinutes = (frame.validTime.getTime() - baseMs) / 60000;
        return offsetMinutes >= -TRACKING_PAST_MINUTES && offsetMinutes <= TRACKING_FUTURE_MINUTES;
      });

    let isActive = true;
    setTrackingLoading(true);
    setTrackingSeries([]);
    setTrackingPathData(EMPTY_FEATURE_COLLECTION);
    setTrackingDirection('분석 중');
    const results = new Array(targets.length);
    let cursor = 0;
    const worker = async () => {
      while (isActive && cursor < targets.length) {
        const resultIndex = cursor;
        cursor += 1;
        const { frame, frameIndex: targetFrameIndex } = targets[resultIndex];
        try {
          const buckets = await loadFrameData(frame);
          const offsetMinutes = Math.round((frame.validTime.getTime() - baseMs) / 60000);
          results[resultIndex] = {
            key: frame.key,
            kind: frame.kind,
            validTime: frame.validTime,
            frameIndex: targetFrameIndex,
            bucket: sampleTrackingBucket(frame, buckets, trackingPoint, mappings),
            offsetMinutes,
            buckets: offsetMinutes >= -30 && offsetMinutes <= 60 ? buckets : null,
          };
        } catch {
          results[resultIndex] = null;
        }
      }
    };

    Promise.all([worker(), worker(), worker(), worker()]).then(() => {
      if (!isActive) return;
      const loadedSeries = results.filter(Boolean);
      const componentFrames = loadedSeries
        .filter((item) => item.buckets)
        .map((item) => ({
          ...item,
          components: buildTrackingComponents(item, item.buckets, trackingPoint, mappings),
        }));
      const observedItems = componentFrames.filter((item) => item.kind === 'obs');
      const forecastItems = componentFrames.filter((item) => item.kind === 'fct');
      const initialObservedComponent = observedItems.length > 0
        ? selectInitialTrackingComponent(observedItems.at(-1).components, trackingPoint)
        : null;
      const observedTrack = trackObservedComponents(observedItems, initialObservedComponent);
      const forecastTrack = trackForecastComponents(forecastItems, observedTrack, trackingPoint);
      const observedCore = observedTrack.map(({ component }) => component.coordinates);
      const forecastCore = forecastTrack.map(({ component }) => component.coordinates);
      const features = [];
      if (observedCore.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { phase: 'observed' },
          geometry: { type: 'LineString', coordinates: observedCore },
        });
      }
      const forecastLine = observedCore.length > 0 && forecastCore.length > 0
        ? [observedCore.at(-1), ...forecastCore]
        : forecastCore;
      if (forecastLine.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { phase: 'forecast' },
          geometry: { type: 'LineString', coordinates: forecastLine },
        });
      }
      observedCore.forEach((coordinates, index) => {
        if (index === observedCore.length - 1 || index % 2 === 0) {
          features.push({
            type: 'Feature',
            properties: { phase: 'observed' },
            geometry: { type: 'Point', coordinates },
          });
        }
      });
      forecastCore.forEach((coordinates, index) => {
        if (index % 2 === 1 || index === forecastCore.length - 1) {
          features.push({
            type: 'Feature',
            properties: { phase: 'forecast' },
            geometry: { type: 'Point', coordinates },
          });
        }
      });
      setTrackingSeries(
        loadedSeries.map((item) => ({
          key: item.key,
          kind: item.kind,
          validTime: item.validTime,
          frameIndex: item.frameIndex,
          bucket: item.bucket,
        })),
      );
      setTrackingPathData({ type: 'FeatureCollection', features });
      setTrackingDirection(formatTrackingDirection(observedCore));
      setTrackingLoading(false);
    });

    return () => {
      isActive = false;
    };
  }, [
    frames,
    isTrackingView,
    loadFrameData,
    status,
    trackingAnalysisTick,
    trackingPoint,
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
    if (isAccumView || isKimView || isGlobalModelView) {
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
  }, [frames, frameIndex, status, renderFrame, loadFrameData, isAccumView, isKimView, isGlobalModelView]);

  useEffect(() => {
    if (!isKimView || kimStatus !== 'ready') return undefined;
    const frameDef = kimFrames[kimIndex];
    if (!frameDef) return undefined;
    const token = ++renderTokenRef.current;
    let retryTimer = null;
    const attempt = () => {
      loadKimFrameData(frameDef)
        .then((values) => {
          if (renderTokenRef.current === token) {
            renderFrame({ ...frameDef, values });
          }
        })
        .catch(() => {
          // 모델 갱신 시점엔 특정 예측 프레임(예: +44시간)이 잠깐 503이 될 수 있다.
          // 방송 중 화면을 어둡게 덮거나 오류 문구를 띄우면 안 되므로, 전체 상태를
          // error로 바꾸지 않고 직전 프레임을 그대로 둔 채 조용히 재시도한다.
          // 갱신이 끝나면 자연히 표출되고, 실패 응답은 캐시되지 않아 재요청된다.
          if (renderTokenRef.current === token) {
            retryTimer = window.setTimeout(attempt, 4000);
          }
        });
    };
    attempt();
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [isKimView, kimFrames, kimIndex, kimStatus, loadKimFrameData, renderFrame]);

  // 현재 이후 예측을 먼저 받고, 과거가 된 모델 초반 프레임은 마지막에 채운다.
  useEffect(() => {
    if (!isKimView || kimStatus !== 'ready' || kimFrames.length === 0) return undefined;
    let isCancelled = false;
    const firstFutureIndex = Math.max(
      0,
      kimFrames.findIndex((frame) => frame.validTime?.getTime() >= Date.now()),
    );
    const orderedFrames = [
      ...kimFrames.slice(firstFutureIndex),
      ...kimFrames.slice(0, firstFutureIndex),
    ];
    const hasPrecomputedAvailability = orderedFrames.some(
      (frame) => frame.isPrecomputed !== null,
    );
    const nearbyKeys = new Set(orderedFrames.slice(0, 3).map((frame) => frame.key));
    const queue = orderedFrames.filter(
      (frame) =>
        !kimCacheRef.current.has(frame.key) &&
        (!hasPrecomputedAvailability || frame.isPrecomputed || nearbyKeys.has(frame.key)),
    );
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

  // 슬라이더 이동 시 바로 앞뒤 프레임만 가볍게 미리 받아 과거 12시간 탐색을 부드럽게 한다.
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
    // 프레임 수가 아니라 '경과 시간'으로 위치를 정한다. 한 칸씩 세는 방식은 프레임이
    // 많을 때 최소 간격에 걸리거나(30일이면 5초 설정에도 43초) 렌더가 타이머보다 느려
    // 계속 밀렸다. 경과 비율로 인덱스를 잡으면 렌더가 느린 기기에서도 몇 칸씩 건너뛰며
    // 설정한 재생 길이를 그대로 지킨다.
    const startIndex = accumPlayRange?.startIndex ?? 0;
    const endIndex = accumPlayRange?.endIndex ?? accumHours.length - 1;
    const transitions = Math.max(1, endIndex - startIndex);
    const durationMs = Math.max(1, playDurationSec * 1000);
    const startedAt = performance.now();
    let timer = null;
    const tick = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
      setAccumIndex(Math.min(endIndex, startIndex + Math.round(progress * transitions)));
      if (progress < 1) {
        timer = window.setTimeout(tick, ACCUM_MIN_FRAME_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(tick, ACCUM_MIN_FRAME_INTERVAL_MS);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isAccumView, isPlaying, accumHours.length, playDurationSec, accumPlayRange]);

  useEffect(() => {
    const endIndex = accumPlayRange?.endIndex ?? accumHours.length - 1;
    if (isAccumView && isPlaying && accumIndex >= endIndex) {
      setIsPlaying(false);
      setPlaybackFinished(true);
    }
  }, [isAccumView, isPlaying, accumIndex, accumHours.length, accumPlayRange]);

  useEffect(() => {
    if (!isKimView || !isPlaying || kimFrames.length < 2) return undefined;
    const targetIndex = kimPlayTarget ?? kimFrames.length - 1;
    const timer = window.setInterval(() => {
      setKimIndex((previous) => Math.min(previous + 1, targetIndex));
    }, kimPlayIntervalMs);
    return () => window.clearInterval(timer);
  }, [isKimView, isPlaying, kimFrames.length, kimPlayIntervalMs, kimPlayTarget]);

  useEffect(() => {
    const targetIndex = kimPlayTarget ?? kimFrames.length - 1;
    if (isKimView && isPlaying && kimIndex >= targetIndex) {
      setIsPlaying(false);
      setPlaybackFinished(true);
    }
  }, [isKimView, isPlaying, kimIndex, kimFrames.length, kimPlayTarget]);

  // 방송모드 재생은 목표 지점(현재 또는 예측 끝)에 도달하면 멈춘다.
  // '현재'에서 멈춘 것뿐이라면 버튼을 재생 상태로 남겨 미래 구간을 이어 재생한다.
  useEffect(() => {
    if (!isAccumView && !isKimView && isBroadcast && isPlaying && playTarget !== null && frameIndex >= playTarget) {
      setIsPlaying(false);
      setPlaybackFinished(playTargetIsFinalRef.current);
    }
  }, [isBroadcast, isPlaying, playTarget, frameIndex, isAccumView, isKimView]);

  // 관측 프레임은 선택 지점→현재, 예측 프레임은 선택 지점→예측 끝으로 재생한다.
  // 현재 하위 뷰(레이더/누적/KIM)의 재생 구간 지정 컨텍스트.
  // 위성은 SatelliteView가 자체 처리하므로 여기서는 제외한다.
  const playRangeContext = useMemo(() => {
    if (isAccumView) {
      return {
        viewId: 'radar:accum',
        frames: accumHours,
        keyOf: (frame) => String(frame?.getTime?.() ?? ''),
        current: accumIndex,
      };
    }
    if (isKimView) {
      return {
        viewId: 'radar:kim',
        frames: kimFrames,
        keyOf: (frame) => String(frame?.validTime?.getTime?.() ?? ''),
        current: kimIndex,
      };
    }
    if (isRadarDataView) {
      return {
        viewId: isTrackingView
          ? 'radar:tracking'
          : isTerrainView
            ? 'radar:terrain'
            : 'radar:radar',
        frames,
        keyOf: (frame) => String(frame?.validTime?.getTime?.() ?? ''),
        current: frameIndex,
      };
    }
    return null;
  }, [isAccumView, isKimView, isRadarDataView, isTerrainView, isTrackingView, accumHours, kimFrames, frames, accumIndex, kimIndex, frameIndex]);

  const activePlayRange = useMemo(
    () =>
      playRangeContext
        ? resolvePlayRange(playRangeContext.viewId, playRangeContext.frames, playRangeContext.keyOf)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playRangeContext, playRangeVersion],
  );

  const markPlayBound = useCallback(
    (which) => {
      if (!playRangeContext) return;
      const { viewId, frames: subFrames, keyOf, current } = playRangeContext;
      const frame = subFrames[current];
      if (!frame) return;
      const existing = readPlayRange(viewId);
      const firstKey = keyOf(subFrames[0]);
      const lastKey = keyOf(subFrames[subFrames.length - 1]);
      const key = keyOf(frame);
      const camera = captureCamera(mapRef.current);
      const next =
        which === 'start'
          ? {
              start: key,
              end: existing?.end ?? lastKey,
              startCamera: camera,
              endCamera: existing?.endCamera ?? null,
            }
          : {
              start: existing?.start ?? firstKey,
              end: key,
              startCamera: existing?.startCamera ?? null,
              endCamera: camera,
            };
      writePlayRange(viewId, next);
      setPlayRangeVersion((value) => value + 1);
    },
    [playRangeContext],
  );

  const handleClearPlayRange = useCallback(() => {
    if (!playRangeContext) return;
    clearPlayRange(playRangeContext.viewId);
    setPlayRangeVersion((value) => value + 1);
  }, [playRangeContext]);

  const handlePlayButton = () => {
    if (isPlaying) {
      mapRef.current?.stop(); // 카메라 이동도 함께 멈춘다
      setIsPlaying(false);
      return;
    }
    // 끝까지 재생돼 멈춘 상태 → 재생 대신 첫 장면으로 이동해 정지한다.
    if (playbackFinished) {
      mapRef.current?.stop();
      const startCamera = activePlayRange?.startCamera;
      if (startCamera) {
        mapRef.current?.jumpTo({
          center: startCamera.center,
          zoom: startCamera.zoom,
          pitch: startCamera.pitch,
          bearing: startCamera.bearing,
        });
      }
      if (isAccumView) {
        setAccumIndex(activePlayRange?.startIndex ?? 0);
      } else if (isKimView) {
        setKimIndex(activePlayRange?.startIndex ?? 0);
      } else {
        setFrameIndex(activePlayRange?.startIndex ?? 0);
      }
      setPlaybackFinished(false);
      setIsPlaying(false);
      return;
    }
    setPlaybackFinished(false);
    const cameraDurationMs = playDurationSec * 1000;
    if (isAccumView) {
      if (accumHours.length < 2 || accumStatus !== 'ready') {
        return;
      }
      const startIndex = activePlayRange
        ? activePlayRange.startIndex
        : accumIndex >= accumHours.length - 1
          ? 0
          : accumIndex;
      const endIndex = activePlayRange ? activePlayRange.endIndex : accumHours.length - 1;
      if (endIndex <= startIndex) return;
      setAccumIndex(startIndex);
      setAccumPlayRange({ startIndex, endIndex });
      applyPlayCamera(mapRef.current, activePlayRange, cameraDurationMs);
      setIsPlaying(true);
      return;
    }
    if (isKimView) {
      if (kimFrames.length < 2 || kimStatus !== 'ready') return;
      const startIndex = activePlayRange
        ? activePlayRange.startIndex
        : kimIndex >= kimFrames.length - 1
          ? 0
          : kimIndex;
      const endIndex = activePlayRange ? activePlayRange.endIndex : kimFrames.length - 1;
      if (endIndex <= startIndex) return;
      if (startIndex !== kimIndex) setKimIndex(startIndex);
      const transitionCount = Math.max(1, endIndex - startIndex);
      setKimPlayTarget(endIndex);
      setKimPlayIntervalMs(Math.max(60, Math.round((playDurationSec * 1000) / transitionCount)));
      applyPlayCamera(mapRef.current, activePlayRange, cameraDurationMs);
      setIsPlaying(true);
      return;
    }
    if (!isBroadcast) {
      setIsPlaying(true);
      return;
    }

    if (activePlayRange) {
      const { startIndex, endIndex } = activePlayRange;
      if (endIndex <= startIndex) return;
      setFrameIndex(startIndex);
      const transitionCount = endIndex - startIndex;
      // 사용자가 지정한 끝화면은 그 자체가 재생의 종착점이다.
      playTargetIsFinalRef.current = true;
      setPlayTarget(endIndex);
      setPlayIntervalMs(Math.max(45, Math.round((playDurationSec * 1000) / transitionCount)));
      applyPlayCamera(mapRef.current, activePlayRange, cameraDurationMs);
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
    playTargetIsFinalRef.current = nextTarget >= frames.length - 1;
    setPlayTarget(nextTarget);
    setPlayIntervalMs(Math.max(45, Math.round((playDurationSec * 1000) / transitionCount)));
    setIsPlaying(true);
  };

  const videoTimelineDates = useMemo(() => {
    if (isAccumView) return accumHours;
    if (isKimView) return kimFrames.map((frame) => frame.validTime);
    return frames.map((frame) => frame.validTime);
  }, [accumHours, frames, isAccumView, isKimView, kimFrames]);
  const videoDefaultStart = videoTimelineDates[0]
    ? formatLocalDateTimeInput(videoTimelineDates[0])
    : '';
  const videoDefaultEnd = videoTimelineDates.at(-1)
    ? formatLocalDateTimeInput(videoTimelineDates.at(-1))
    : '';

  const handleVideoPrepare = useCallback(
    async ({ start, end }) => {
      const range = findTimelineRange(videoTimelineDates, start, end);
      if (!range) {
        throw new Error('선택한 기간에 재생할 프레임이 2개 이상 필요합니다.');
      }
      setIsPlaying(false);
      setPlaybackFinished(false);
      // 녹화 첫 컷이 '직전에 머물던 화면'이 아니라 시작 프레임이 되도록,
      // 캡처 전에 표시를 시작 프레임으로 옮겨 둔다.
      if (isAccumView) setAccumIndex(range.startIndex);
      else if (isKimView) setKimIndex(range.startIndex);
      else setFrameIndex(range.startIndex);
    },
    [videoTimelineDates, isAccumView, isKimView],
  );

  const handleVideoStart = useCallback(
    ({ start, end, durationSec }) => {
      const range = findTimelineRange(videoTimelineDates, start, end);
      if (!range) return;
      const transitionCount = Math.max(1, range.endIndex - range.startIndex);
      setPlayDurationSec(durationSec);
      if (isAccumView) {
        setAccumPlayRange(range);
        setAccumIndex(range.startIndex);
      } else if (isKimView) {
        setKimPlayTarget(range.endIndex);
        setKimIndex(range.startIndex);
        setKimPlayIntervalMs(Math.max(60, Math.round((durationSec * 1000) / transitionCount)));
      } else {
        setFrameIndex(range.startIndex);
        setPlayTarget(range.endIndex);
        setPlayIntervalMs(Math.max(45, Math.round((durationSec * 1000) / transitionCount)));
      }
      window.requestAnimationFrame(() => setIsPlaying(true));
    },
    [isAccumView, isKimView, videoTimelineDates],
  );

  const handleBeforeVideoScreenShare = useCallback(async () => {
    const activeView = broadcastView;
    // 이 플래그는 '다음에 오는 전체화면 해제는 사용자가 아니라 화면 공유 때문'이라는
    // 표시다. 크롬은 getDisplayMedia 선택창을 띄우면서 네이티브 전체화면을 강제로
    // 푸는데, 그 fullscreenchange가 실제로 도착할 때까지 켜져 있어야 한다.
    // (예전에는 아래 finally에서 바로 껐다. 그러면 선택창이 뜨는 순간 전체화면이
    //  풀렸을 때 플래그가 이미 꺼져 있어 방송모드가 종료되고 화면이 일반모드
    //  레이더로 되돌아간 채 녹화됐다.)
    videoCaptureTransitionRef.current = true;
    try {
      // 녹화를 방송모드와 같은 크기·해상도로 만들려면 네이티브 전체화면(1920x1080,
      // 16:9)을 그대로 유지해야 한다. 예전엔 여기서 전체화면을 빠져나와 CSS 전체화면
      // (브라우저 툴바만큼 세로가 줄어 16:9가 아님)으로 낮췄기 때문에, 녹화 영상이
      // 방송화면보다 작아지고 위아래 검은 여백이 생겼다. 전체화면이 아닐 때만 CSS
      // 전체화면으로 채운다.
      if (!document.fullscreenElement) {
        setFullscreenMode('css');
      }
      setIsBroadcast(true);
      setBroadcastView(activeView);
      await new Promise((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      });
      mapRef.current?.resize();
    } catch (error) {
      // 준비 단계에서 실패하면 화면 공유로 이어지지 않으므로 표시를 되돌린다.
      videoCaptureTransitionRef.current = false;
      throw error;
    }
  }, [broadcastView]);

  // 음성 영상의 한 사이클은 '관측 재생 → 현재에서 정지 → 예측 재생 → 끝에서 정지'다.
  // 영상 쪽에서 시각을 재며 단계마다 이 함수를 부른다. 여기서는 어느 프레임에서
  // 어디까지를 몇 초에 걸쳐 돌릴지만 정한다.
  const handleVideoCyclePhase = useCallback(
    ({ phase, start, end, seconds }) => {
      const range = findTimelineRange(videoTimelineDates, start, end);
      if (!range) return;
      // 관측과 예측의 경계는 '마지막 관측 프레임'이다. 시계 시각으로 자르면
      // 관측이 몇 분 늦게 들어오는 사이에 만들어진 예측 첫 프레임이 딸려 들어와,
      // '현재'라며 예측 화면을 보여 주게 된다.
      let boundary = frames.findLastIndex((frame) => frame.kind === 'obs');
      if (boundary < range.startIndex) boundary = range.startIndex;
      if (boundary > range.endIndex || boundary < 0) boundary = range.endIndex;

      // 시작 지점에 그대로 멈춰 서는 단계.
      if (phase === 'start') {
        setIsPlaying(false);
        setPlayTarget(null);
        setFrameIndex(range.startIndex);
        return;
      }

      const from = phase === 'forecast' ? boundary : range.startIndex;
      const to = phase === 'forecast' ? range.endIndex : boundary;
      const steps = Math.max(1, to - from);

      setPlayDurationSec(seconds);
      setFrameIndex(from);
      setPlayTarget(to);
      setPlayIntervalMs(Math.max(45, Math.round((seconds * 1000) / steps)));
      window.requestAnimationFrame(() => setIsPlaying(true));
    },
    [videoTimelineDates, frames],
  );

  // 두 번째 사이클에서만 순위표를 띄우기 위해 영상 쪽에서 켜고 끈다.
  // null이 오면 녹화 전에 사용자가 켜 두었던 상태로 되돌린다.
  const rankingBeforeVideoRef = useRef(null);
  const handleVideoRankingTable = useCallback((visible) => {
    if (visible === null) {
      if (rankingBeforeVideoRef.current !== null) {
        setShowHourlyTop5(rankingBeforeVideoRef.current);
        rankingBeforeVideoRef.current = null;
      }
      return;
    }
    setShowHourlyTop5((previous) => {
      if (rankingBeforeVideoRef.current === null) rankingBeforeVideoRef.current = previous;
      return Boolean(visible);
    });
  }, []);

  // 크롬은 화면 공유 선택창을 띄우면서 네이티브 전체화면을 강제로 푼다.
  // '허용'을 누른 뒤 다시 들어가야 방송화면과 같은 1920x1080으로 녹화된다.
  // (그대로 두면 툴바만큼 세로가 줄어든 CSS 전체화면이 찍혀 16:9가 깨진다.)
  const handleAfterVideoScreenShare = useCallback(async () => {
    if (!document.fullscreenElement) {
      const element = sectionRef.current;
      try {
        if (!element?.requestFullscreen) throw new Error('unsupported');
        await element.requestFullscreen();
        setFullscreenMode('native');
      } catch {
        // 브라우저가 막으면 지금까지처럼 CSS 전체화면으로 찍는다.
        setFullscreenMode('css');
      }
    }
    // 전체화면 전환이 화면에 반영된 뒤 지도 크기를 다시 잡는다.
    await new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
    mapRef.current?.resize();
  }, []);

  const currentFrame = frames[frameIndex];

  // 화면에 그려진 레이더 프레임에서 기사용 '관측 사실'을 만든다.
  // 과거 프레임은 이미 캐시에 있으므로 추가 통신 없이 이동·추세까지 계산된다.
  const handleBuildArticleFacts = useCallback(async () => {
    const mappings = mappingsRef.current;
    if (!mappings || frames.length === 0) {
      setArticleBuildError('레이더 자료가 아직 준비되지 않았습니다.');
      return;
    }
    setArticleBuildStatus('loading');
    setArticleBuildError('');
    // 현재까지의 레이더와 앞으로 한 시간 QPF를 함께 준비한다. 프레임 요청은 병렬로
    // 처리하고, RN-60m는 화면 진입 때 이미 별도 요청으로 받아 둔다.
    const observed = frames
      .filter((frame) => frame.kind === 'obs' && frame.validTime <= (currentFrame?.validTime ?? new Date()))
      .slice(-19); // 10분 간격 기준 약 3시간
    const latestObservedAt = observed.at(-1)?.validTime;
    const forecasts = frames.filter((frame) => frame.kind === 'fct'
      && latestObservedAt
      && frame.validTime > latestObservedAt
      && frame.validTime.getTime() <= latestObservedAt.getTime() + 60 * 60 * 1000);

    try {
      await Promise.allSettled([...observed, ...forecasts].map((frame) => loadFrameData(frame)));
      const cache = frameCacheRef.current;
      const withBuckets = observed
        .map((frame) => ({ validTime: frame.validTime, buckets: cache.get(frame.key) }))
        .filter((frame) => frame.buckets);
      if (withBuckets.length === 0) {
        throw new Error('레이더 프레임을 읽지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
      }
      const canvasHeight = mappings.radarMap.length / CANVAS_WIDTH;
      const radarFacts = buildRadarFacts({
        frames: withBuckets,
        mappings: mappings.radarMap,
        canvasWidth: CANVAS_WIDTH,
        canvasHeight,
        toLonLat: (x, y) => canvasPointToLonLat(x, y, CANVAS_WIDTH, canvasHeight),
        bucketToMm: (bucket) => bucketLowerValue(bucket),
      });
      const landCores = attachNearbyObservations(radarFacts?.clusters, hourlyObservations);
      const forecastFacts = buildForecastFacts({
        frames: forecasts.map((frame) => ({
          validTime: frame.validTime,
          sourceAt: parseRadarTm(frame.tm),
          buckets: cache.get(frame.key),
        })),
        mappings: mappings.qpfMap,
        canvasWidth: CANVAS_WIDTH,
        canvasHeight,
        toLonLat: (x, y) => canvasPointToLonLat(x, y, CANVAS_WIDTH, canvasHeight),
        bucketToMm: (bucket) => bucketLowerValue(bucket),
        observedAt: radarFacts?.observedAt,
      });
      const response = await fetch('/api/radar-script-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          radar: { ...radarFacts, clusters: landCores },
          forecast: forecastFacts,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const analysis = await response.json();
      if (!response.ok) throw new Error(analysis?.error || `레이더 분석 실패 (${response.status})`);
      setArticleAnalysis(analysis);
      setArticleBuildStatus('ready');
    } catch (error) {
      setArticleBuildError(error.message || '레이더 분석에 실패했습니다.');
      setArticleBuildStatus('error');
    }
  }, [frames, currentFrame, hourlyObservations, loadFrameData]);

  // '음성 포함'을 켜면 시각과 화면을 알아서 잡아 준다. 매번 손으로 맞추면
  // 방송 직전에 실수하기 쉬운 값들이라 기본값을 대신 채워 주는 것이다.
  const handleAutoVideoSetup = useCallback(() => {
    const map = mapRef.current;
    if (!map) return null;

    // 시각: 지금부터 3시간 전 ~ 1시간 뒤(초단기 예측까지 담기게).
    const toLocalInput = (date) => {
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const now = new Date();
    const result = {
      start: toLocalInput(new Date(now.getTime() - 3 * 3600000)),
      end: toLocalInput(new Date(now.getTime() + 3600000)),
      startCamera: null,
      endCamera: null,
      endLabel: null,
    };

    // 시작 화면: 레이더 기본 화면(방송용 남한 전체).
    const base = map.cameraForBounds(BROADCAST_MAP_BOUNDS, { padding: 0 });
    if (base) {
      result.startCamera = {
        center: [base.center.lng ?? base.center[0], base.center.lat ?? base.center[1]],
        zoom: base.zoom,
        pitch: 0,
        bearing: 0,
      };
    }

    // 종료 화면: 지금 가장 비가 센 곳을 가운데 두고, 그 도가 화면의 10%가 되게.
    const mappings = mappingsRef.current;
    const cache = frameCacheRef.current;
    const observed = frames.filter((frame) => frame.kind === 'obs');
    const latest = observed.at(-1);
    const buckets = latest ? cache.get(latest.key) : null;
    if (mappings && buckets) {
      const canvasHeight = mappings.radarMap.length / CANVAS_WIDTH;
      const peak = findPeakPoint({
        buckets,
        mappings: mappings.radarMap,
        canvasWidth: CANVAS_WIDTH,
        canvasHeight,
        toLonLat: (x, y) => canvasPointToLonLat(x, y, CANVAS_WIDTH, canvasHeight),
      });
      // 원고가 언급할 강수대들. 여러 곳으로 흩어져 있으면 한 곳만 크게 잡을 수 없다.
      const spread = buildRadarFacts({
        frames: [{ validTime: latest.validTime, buckets }],
        mappings: mappings.radarMap,
        canvasWidth: CANVAS_WIDTH,
        canvasHeight,
        toLonLat: (x, y) => canvasPointToLonLat(x, y, CANVAS_WIDTH, canvasHeight),
        bucketToMm: (bucket) => bucketLowerValue(bucket),
      })?.clusters ?? [];

      // 육지에 비가 없으면 줌인하지 않고 전국 화면 그대로 끝낸다.
      if (peak) {
        const province = peak.province ?? findProvinceAt(peak.lon, peak.lat);
        let zoom = 8;
        if (province) {
          const { bounds, fillRatio } = provinceExtent(province);
          const fit = map.cameraForBounds(bounds, { padding: 0 });
          if (fit) zoom = zoomForAreaRatio(fit.zoom, fillRatio, 0.1);
        }
        let center = [peak.lon, peak.lat];
        let label = null;

        // 강수대가 두 곳 이상이면 그 전부가 화면에 들어오도록 덜 들어간다.
        // 한 곳만 크게 잡으면 나머지 지역이 화면 밖으로 밀려난다.
        const points = spread
          .map((cluster) => cluster.centroid)
          .filter((point) => Number.isFinite(point?.lon) && Number.isFinite(point?.lat));
        if (points.length >= 2) {
          const lons = points.map((point) => point.lon);
          const lats = points.map((point) => point.lat);
          // 가장자리에 딱 붙지 않게 여유를 둔다.
          const margin = 0.25;
          const spreadBounds = [
            [Math.min(...lons) - margin, Math.min(...lats) - margin],
            [Math.max(...lons) + margin, Math.max(...lats) + margin],
          ];
          const fitAll = map.cameraForBounds(spreadBounds, { padding: 40 });
          if (fitAll) {
            // 둘 중 더 멀리 물러난 쪽을 쓴다.
            zoom = Math.min(zoom, fitAll.zoom);
            center = [
              fitAll.center.lng ?? fitAll.center[0],
              fitAll.center.lat ?? fitAll.center[1],
            ];
          }
          const names = spread
            .map((cluster) => cluster.places?.[0])
            .filter(Boolean)
            .slice(0, 3);
          if (names.length) label = `${names.join(' · ')} 일대가 함께 보이게`;
        }

        result.endCamera = {
          center,
          // 지도 자체의 한계를 넘지 않게 가둔다.
          zoom: Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom)),
          pitch: 0,
          bearing: 0,
        };
        if (!label) {
          const place = nearestPlaceName(peak.lon, peak.lat);
          label = [province?.properties?.name, place && `${place} 일대`]
            .filter(Boolean)
            .join(' · ');
        }
        result.endLabel = label;
      } else {
        result.endCamera = result.startCamera;
        result.endLabel = '육지에 강한 비가 없어 전국 화면 그대로';
      }
    }
    return result;
  }, [frames]);

  const latestObservationIndex = useMemo(
    () => frames.findLastIndex((frame) => frame.kind === 'obs'),
    [frames],
  );
  const handleTrackingReturnToCurrent = useCallback(() => {
    if (latestObservationIndex < 0) return;
    setIsPlaying(false);
    setPlayTarget(null);
    setPlaybackFinished(false);
    setFrameIndex(latestObservationIndex);
  }, [latestObservationIndex]);
  const handleTrackingResetMap = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    fitBroadcastFlatView(map, 650);
  }, []);
  const handleTrackingFrameSelect = useCallback((nextFrameIndex) => {
    setIsPlaying(false);
    setPlayTarget(null);
    setPlaybackFinished(false);
    setFrameIndex(nextFrameIndex);
  }, []);

  // 타임라인은 프레임 개수가 아니라 시간에 비례한다. 왼쪽은 관측 12시간,
  // 오른쪽은 기상청이 실제 제공한 마지막 예측시각(최대 2시간)까지만 표시한다.
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

  // 지정 구간 시작/끝 마커의 슬라이더상 위치(%). 뷰마다 슬라이더 척도가 달라
  // (레이더=분 오프셋, 누적/KIM=인덱스) 각각 계산한다.
  const playRangePercents = useMemo(() => {
    if (!activePlayRange || !playRangeContext) return null;
    const { startIndex, endIndex } = activePlayRange;
    if (isRadarDataView) {
      const span = timelineSpan || 1;
      return {
        start: ((frameOffsets[startIndex] - timelineMinOffset) / span) * 100,
        end: ((frameOffsets[endIndex] - timelineMinOffset) / span) * 100,
      };
    }
    const max = Math.max(1, playRangeContext.frames.length - 1);
    return { start: (startIndex / max) * 100, end: (endIndex / max) * 100 };
  }, [activePlayRange, playRangeContext, isRadarDataView, frameOffsets, timelineMinOffset, timelineSpan]);

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

  const prepareRadarHistoryInput = useCallback(() => {
    const latestObservation = frames.filter((frame) => frame.kind === 'obs').at(-1)?.validTime;
    const seed = radarHistoryEnd ?? latestObservation ?? new Date();
    setRadarHistoryInput(formatLocalDateTimeInput(floorToTenMinutes(seed)));
    setIsRadarHistoryPickerOpen(true);
  }, [frames, radarHistoryEnd]);

  const handleApplyRadarHistory = useCallback(() => {
    const parsed = new Date(radarHistoryInput);
    if (Number.isNaN(parsed.getTime())) return;

    const earliest = new Date(RADAR_ARCHIVE_MIN_INPUT);
    const latest = floorToTenMinutes(new Date());
    const clamped = new Date(
      Math.min(latest.getTime(), Math.max(earliest.getTime(), parsed.getTime())),
    );
    setIsPlaying(false);
    setPlayTarget(null);
    setRadarHistoryEnd(floorToTenMinutes(clamped));
    setIsRadarHistoryPickerOpen(false);
    setManualRefreshTick((tick) => tick + 1);
  }, [radarHistoryInput]);

  const handleReturnToLatestRadar = useCallback(() => {
    setIsPlaying(false);
    setPlayTarget(null);
    setRadarHistoryEnd(null);
    setIsRadarHistoryPickerOpen(false);
    setManualRefreshTick((tick) => tick + 1);
  }, []);

  // 임의 기간으로 전환할 때 현재 프리셋 구간을 입력창 초기값으로 채워 준다.
  const prepareAccumCustomInputs = useCallback(() => {
    const toLocalInput = (date) => {
      const pad = (value) => String(value).padStart(2, '0');
      return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:00`
      );
    };
    const end = accumHours.at(-1) ?? new Date();
    const startSeed = accumHours[0] ?? new Date(end.getTime() - 86400000);
    setAccumCustomStartInput((previous) => previous || toLocalInput(startSeed));
    setAccumCustomEndInput((previous) => previous || toLocalInput(end));
    setAccumRangeMode('custom');
  }, [accumHours]);

  const handleApplyAccumCustomRange = useCallback(() => {
    const startMs = new Date(accumCustomStartInput).getTime();
    const endMs = new Date(accumCustomEndInput).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return;
    }
    setIsPlaying(false);
    setAccumRangeMode('custom');
    setAccumCustomRange({ startMs, endMs });
  }, [accumCustomStartInput, accumCustomEndInput]);

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
      // 연안 바다는 그리지는 않지만, 해안가 육지 노드가 이웃을 넉넉히 찾도록
      // 보간 반경은 육지와 같게 유지한다(해안선 근처 값이 끊기지 않게).
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
          // 기온 지도와 같은 방식: 육지(시도 폴리곤) 안에서만 칠하고 바다는 비운다.
          // 예전에는 바다로 번지게 해 연안 공백을 메웠지만, 그 대가로 해안선이
          // 뭉개지고 섬 주변에 둥근 얼룩이 남았다. 바다 강수량은 보여줄 이유가
          // 없으므로 폴리곤에서 잘라 해안선과 섬 모양을 그대로 살린다.
          // 연안 보간(useLandFill)은 그대로 두어 해안가 육지 값이 끊기지 않게 한다.
          nodeAlpha[node] = isLand ? OVERLAY_ALPHA : 0;
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
        // 시작 시각이 자정이 아닌 임의 기간이면, 시작 시점까지의 당일 누적을 빼야
        // '기간 내에 내린 양'이 된다. 프리셋(자정 시작)은 기준값이 없어 0이다.
        const offset = accumStartBaselineRef.current?.get(stationId) ?? 0;
        if (anchor.getHours() === 0) {
          return Math.max(0, (base ? (base.get(stationId) ?? 0) : 0) - offset);
        }
        const hourly = accumHourlyCacheRef.current.get(formatAccumHourTm(anchor));
        const hourlyValue = hourly?.get(stationId);
        return hourlyValue === undefined
          ? undefined
          : Math.max(0, hourlyValue + (base ? (base.get(stationId) ?? 0) : 0) - offset);
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
            // nodeAlpha가 육지 폴리곤으로 잘려 있어 기둥도 육지 위에만 선다.
            if (nodeAlpha[node] === 0) continue;
            // 외딴 섬은 아래에서 관측점 위치에 단일 기둥으로 따로 세운다. 여기서
            // 걸러내지 않으면 같은 자리에 표면 기둥까지 겹쳐 두 개로 보인다.
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
      // 디졸브 없이 바로 그린다. 누적 재생은 경과 시간에 맞춰 60ms마다(때로는 여러 칸씩)
      // 넘어가는데, 디졸브는 45~140ms라 매번 완료 전에 취소돼 두 장이 반투명하게 겹친
      // 중간 상태로 남았다. 그 상태는 알파가 원본보다 낮아 화면이 깜빡이는 것처럼 보였다.
      // 누적장은 프레임 간 변화가 완만해 바로 교체해도 충분히 부드럽다.
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(toCanvas, 0, 0);
      hasRenderedFrameRef.current = true;
      refreshOverlaySource();
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

        // 기간 결정: 프리셋은 '최신 시각에서 N일', 임의는 사용자가 고른 구간.
        // 임의 구간의 끝은 관측이 있는 최신 정시를 넘지 못한다.
        let start;
        let rangeEnd;
        if (accumRangeMode === 'custom' && accumCustomRange) {
          start = new Date(accumCustomRange.startMs);
          start.setMinutes(0, 0, 0);
          rangeEnd = new Date(Math.min(accumCustomRange.endMs, latest.date.getTime()));
          rangeEnd.setMinutes(0, 0, 0);
          if (start.getTime() >= rangeEnd.getTime()) {
            throw new Error('종료 시각은 시작 시각보다 뒤여야 합니다.');
          }
          if (rangeEnd.getTime() - start.getTime() > MAX_ACCUM_RANGE_DAYS * 86400000) {
            throw new Error(`기간은 최대 ${MAX_ACCUM_RANGE_DAYS}일까지 설정할 수 있습니다.`);
          }
        } else {
          rangeEnd = latest.date;
          start = new Date(latest.date);
          start.setHours(0, 0, 0, 0);
          start.setDate(start.getDate() - (accumDays - 1));
        }

        // 기간 끝 시각의 시간통계 (프리셋이면 이미 받아 둔 최신 자료)
        let endData = latest.data;
        if (rangeEnd.getTime() !== latest.date.getTime()) {
          const endTm = formatAccumHourTm(rangeEnd);
          endData =
            accumHourlyCacheRef.current.get(endTm) ??
            (rangeEnd.getHours() === 0 ? new Map() : await fetchHourlyRnDay(rangeEnd));
          if (!isActive) {
            return;
          }
          accumHourlyCacheRef.current.set(endTm, endData);
        }

        // 시작 시각이 자정이 아니면 그 시점까지의 당일 누적을 빼야 기간 합계가 맞는다.
        const startBaseline =
          start.getHours() === 0 ? null : await fetchHourlyRnDay(start).catch(() => null);
        if (!isActive) {
          return;
        }
        accumStartBaselineRef.current = startBaseline;

        // 완결된 과거 일들의 일합계 → 일 인덱스별 누적 베이스.
        // 하루씩 순차로 받으면 긴 기간에서 느려서 몇 건씩 동시에 받는다.
        const startMidnight = new Date(start).setHours(0, 0, 0, 0);
        const endMidnight = new Date(rangeEnd).setHours(0, 0, 0, 0);
        const dayCount = Math.round((endMidnight - startMidnight) / 86400000) + 1;
        const dailyTotals = [];
        for (let index = 0; index < dayCount - 1; index += ACCUM_DAILY_FETCH_CONCURRENCY) {
          const batch = [];
          for (
            let offset = index;
            offset < Math.min(index + ACCUM_DAILY_FETCH_CONCURRENCY, dayCount - 1);
            offset++
          ) {
            batch.push(fetchDailyRnTotal(new Date(startMidnight + offset * 86400000)));
          }
          const settled = await Promise.all(batch);
          if (!isActive) {
            return;
          }
          dailyTotals.push(...settled);
        }
        const bases = [new Map()];
        dailyTotals.forEach((daily, dayOffset) => {
          const previous = bases[dayOffset];
          const next = new Map(previous);
          daily.forEach((value, stationId) => {
            next.set(stationId, (previous.get(stationId) ?? 0) + value);
          });
          bases.push(next);
        });
        accumBasesRef.current = bases;

        const spanHours = Math.max(0, (rangeEnd.getTime() - start.getTime()) / 3600000);

        // 표시 간격은 기간에 맞춰 넓힌다(1일 → 1시간, 30일 → 6시간).
        const displayStepMs = pickAccumDisplayStepHours(spanHours) * 3600000;
        const hours = [];
        for (let t = start.getTime(); t <= rangeEnd.getTime(); t += displayStepMs) {
          hours.push(new Date(t));
        }
        if (hours.at(-1)?.getTime() !== rangeEnd.getTime()) {
          hours.push(new Date(rangeEnd));
        }

        const frameStepHours = Math.max(
          1,
          Math.ceil(spanHours / (MAX_ACCUM_API_FRAMES - 1)),
        );
        const frameStepMs = frameStepHours * 3600000;
        const anchorHours = [];
        for (let t = start.getTime(); t <= rangeEnd.getTime(); t += frameStepMs) {
          anchorHours.push(new Date(t));
        }
        if (anchorHours.at(-1)?.getTime() !== rangeEnd.getTime()) {
          anchorHours.push(new Date(rangeEnd));
        }
        accumAnchorHoursRef.current = anchorHours;
        setAccumHours(hours);
        setAccumIndex(hours.length - 1);
        setAccumStatus('ready');

        // 기간 전체(끝 시각 기준) 최다 강수 5개 지점.
        // 끝 시각이 자정이면 RN_DAY가 전날 누적이므로 일합계 베이스만 쓴다.
        const latestBase = bases[dayCount - 1] ?? new Map();
        const latestIsMidnight = rangeEnd.getHours() === 0;
        const ranked = [];
        accumStationsRef.current.forEach((station) => {
          const hourValue = endData.get(station.id);
          if (!latestIsMidnight && hourValue === undefined) {
            return;
          }
          const total =
            (latestIsMidnight ? 0 : hourValue) +
            (latestBase.get(station.id) ?? 0) -
            (startBaseline?.get(station.id) ?? 0);
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
  }, [
    isAccumView,
    accumDays,
    accumRangeMode,
    accumCustomRange,
    buildAccumIdw,
    loadAccumAnchor,
  ]);

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

  // Esc 등으로 네이티브 전체화면이 해제되면 상태를 따라간다. 단, 화면 공유가
  // 강제로 푼 것이라면 방송모드를 유지해야 하므로 CSS 전체화면으로 내려앉는다.
  useEffect(() => {
    const handleChange = () => {
      if (!document.fullscreenElement) {
        // 표시는 한 번만 쓰고 끈다. 이후의 해제는 다시 사용자의 Esc로 취급한다.
        const isCaptureTransition = videoCaptureTransitionRef.current;
        videoCaptureTransitionRef.current = false;
        setFullscreenMode((mode) =>
          mode === 'native' ? (isCaptureTransition ? 'css' : null) : mode,
        );
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
      setBroadcastPlaceLabelVisibility(map, showPlaceLabels);
      if (map.getZoom() >= 9.4) {
        ensureBroadcastEmdLayers(map);
        setBroadcastPlaceLabelVisibility(map, showPlaceLabels);
      }
    };

    const handleAdminZoom = () => {
      if (map.getZoom() >= 9.4) {
        ensureBroadcastEmdLayers(map);
        setBroadcastPlaceLabelVisibility(map, showPlaceLabels);
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
  }, [isBroadcast, showPlaceLabels]);

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
    setWorkspaceMode('edit');
    updateWorkspaceModeInUrl('edit');
    if (!fullscreenMode) {
      toggleFullscreen();
    }
  }, [fullscreenMode, toggleFullscreen]);

  const handleWorkspaceModeChange = useCallback((nextMode) => {
    setWorkspaceMode(nextMode);
    updateWorkspaceModeInUrl(nextMode);
  }, []);

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

  // 깔끔한 방송 화면에서는 Esc로 설정을 유지한 채 편집 메뉴를 다시 연다.
  useEffect(() => {
    if (!isBroadcast || workspaceMode !== 'broadcast') {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        handleWorkspaceModeChange('edit');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleWorkspaceModeChange, isBroadcast, workspaceMode]);

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
    // 회전 정책과 같은 이유로 mapInstanceReady가 필요하다. 방송 URL로 바로 들어오면
    // isBroadcast가 처음부터 true라 이 효과가 다시 돌지 않아 확대 버튼이 남는다.
  }, [isBroadcast, mapInstanceReady]);

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
    if (!isBroadcast || !isRadarDataView || status !== 'ready') {
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
  }, [broadcastView, isBroadcast, isRadarDataView, status, frames, loadFrameData]);

  // 컨트롤바(재생 버튼 + 슬라이더 + 눈금). 방송모드에서는 어두운 배경 위에 얹는다.
  const renderTimeline = (broadcast) => (
    <div className="flex flex-col gap-2">
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handlePlayButton}
        disabled={isAccumView ? accumStatus !== 'ready' : isKimView ? kimStatus !== 'ready' : status !== 'ready'}
        className={`flex shrink-0 items-center justify-center rounded-full bg-[#0033a0] text-white shadow-sm transition hover:bg-blue-800 disabled:opacity-40 ${
          broadcast ? 'h-12 w-12 -translate-x-1/2' : 'h-10 w-10'
        }`}
        aria-label={isPlaying ? '일시정지' : playbackFinished ? '처음으로' : '재생'}
        title={isPlaying ? '일시정지' : playbackFinished ? '처음으로' : '재생'}
      >
        {isPlaying ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
            <rect x="3" y="2" width="3.5" height="12" rx="1" />
            <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
          </svg>
        ) : playbackFinished ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
            <rect x="3" y="2.5" width="2.4" height="11" rx="1" />
            <path d="M13.2 3.1a1 1 0 0 0-1.55-.84l-5.6 4.9a1 1 0 0 0 0 1.68l5.6 4.9a1 1 0 0 0 1.55-.84V3.1Z" />
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
            setPlaybackFinished(false); // 수동 스크럽하면 '처음으로' 상태 해제
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
        {playRangePercents ? (
          <>
            <span
              className="pointer-events-none absolute top-1/2 z-20 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-300 shadow"
              style={{ left: `${Math.min(Math.max(playRangePercents.start, 0), 100)}%` }}
              title="시작 화면"
            />
            <span
              className="pointer-events-none absolute top-1/2 z-20 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-300 shadow"
              style={{ left: `${Math.min(Math.max(playRangePercents.end, 0), 100)}%` }}
              title="끝 화면"
            />
          </>
        ) : null}
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
    {broadcast && workspaceMode !== 'broadcast' && playRangeContext ? (
      <div className="flex items-center justify-end gap-2 pl-14">
        <span className="mr-auto text-xs font-bold text-white/70">
          {activePlayRange ? '재생 구간 지정됨' : '재생 구간 미지정 (전체 재생)'}
        </span>
        <button
          type="button"
          onClick={() => markPlayBound('start')}
          className="h-9 rounded-full border border-emerald-300/50 bg-emerald-500/15 px-3 text-xs font-black text-emerald-200 transition hover:bg-emerald-500/25"
        >
          시작으로 지정
        </button>
        <button
          type="button"
          onClick={() => markPlayBound('end')}
          className="h-9 rounded-full border border-rose-300/50 bg-rose-500/15 px-3 text-xs font-black text-rose-200 transition hover:bg-rose-500/25"
        >
          끝으로 지정
        </button>
        {activePlayRange ? (
          <button
            type="button"
            onClick={handleClearPlayRange}
            className="h-9 rounded-full border border-white/25 bg-slate-900/70 px-3 text-xs font-black text-white/80 transition hover:bg-slate-800"
          >
            구간 해제
          </button>
        ) : null}
      </div>
    ) : null}
    </div>
  );

  const renderRadarHistoryControls = (broadcast = false) => {
    const shellClass = broadcast
      ? 'border-white/25 bg-slate-900/65 text-white backdrop-blur-sm'
      : 'border-slate-200 bg-white text-slate-700';
    const buttonClass = broadcast
      ? 'hover:bg-white/10'
      : 'hover:bg-slate-100';

    return (
      <div className="flex items-center gap-2">
        {isRadarHistoryPickerOpen ? (
          <div className={`flex h-10 items-center gap-1.5 rounded-full border px-2 shadow-lg ${shellClass}`}>
            <CalendarClock size={16} className="shrink-0" />
            <HistoricalDateTimeInput
              value={radarHistoryInput}
              min={RADAR_ARCHIVE_MIN_INPUT}
              max={formatLocalDateTimeInput(floorToTenMinutes(new Date()))}
              onChange={setRadarHistoryInput}
              dark={broadcast}
              ariaLabel="레이더 과거 조회 시각"
            />
            <button
              type="button"
              onClick={handleApplyRadarHistory}
              disabled={!radarHistoryInput}
              className={`h-7 rounded-full px-2.5 text-xs font-black transition disabled:opacity-50 ${
                broadcast
                  ? 'bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              이동
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={prepareRadarHistoryInput}
            className={`flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-semibold shadow-lg transition ${shellClass} ${buttonClass}`}
          >
            <CalendarClock size={16} />
            과거 조회
          </button>
        )}
        {radarHistoryEnd ? (
          <button
            type="button"
            onClick={handleReturnToLatestRadar}
            className={`h-10 rounded-full border px-3 text-sm font-black shadow-lg transition ${shellClass} ${buttonClass}`}
          >
            최신
          </button>
        ) : null}
      </div>
    );
  };

  const handleWorkspaceSectionChange = (nextSection) => {
    if (nextSection === 'heat') {
      window.location.href = `/?view=heatwave&mode=${workspaceMode}&temperatureMode=heat`;
      return;
    }
    const nextView = nextSection === 'forecast'
      ? 'ifs'
      : nextSection === 'analysis'
        ? 'tracking'
        : 'radar';
    handleWorkspaceViewChange(nextView);
  };

  const handleWorkspaceViewChange = (nextView) => {
    if (nextView === broadcastView) return;
    setIsPlaying(false);
    setBroadcastView(nextView);
    const url = new URL(window.location.href);
    url.searchParams.set('videoTarget', nextView);
    window.history.replaceState({}, '', url);
  };

  const workspaceMenu = workspaceMode === 'broadcast' ? null : (
    <WeatherWorkspaceMenu
      workspaceMode={workspaceMode}
      onWorkspaceModeChange={handleWorkspaceModeChange}
      section={
        isGlobalModelView
          ? 'forecast'
          : isTrackingView || isTerrainView || isHistoricalView
            ? 'analysis'
            : 'rain'
      }
      onSectionChange={handleWorkspaceSectionChange}
      activeView={broadcastView}
      onViewChange={handleWorkspaceViewChange}
      showPlaceLabels={showPlaceLabels}
      onShowPlaceLabelsChange={setShowPlaceLabels}
      onExit={exitBroadcastMode}
    />
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
            기상청 레이더 강수 실황(5분 간격, 과거 12시간)과 초단기 예측강수(10분 간격, 미래 2시간)입니다.
          </div>
          <div className="mt-3">{renderRadarHistoryControls(false)}</div>
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
        {!isAccumView && !isKimView && !isSatelliteView && !isGlobalModelView && !isHistoricalView && status === 'loading' && frames.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium text-slate-500">
            레이더 자료를 불러오는 중입니다…
          </div>
        ) : null}
        {!isAccumView && !isKimView && !isSatelliteView && !isGlobalModelView && !isHistoricalView && status === 'error' ? (
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
        {isSatelliteView ? (
          <SatelliteView
            menuSlot={workspaceMenu}
            workspaceMode={workspaceMode}
            onBeforeScreenShare={handleBeforeVideoScreenShare}
          />
        ) : null}

        {isGlobalModelView ? (
          <GlobalModelView
            activeView={broadcastView}
            workspaceMode={workspaceMode}
            showPlaceLabels={showPlaceLabels}
            menuSlot={workspaceMenu}
            onBeforeScreenShare={handleBeforeVideoScreenShare}
          />
        ) : null}

        {isHistoricalView ? (
          <HistoricalCaseComparison
            workspaceMode={workspaceMode}
            showPlaceLabels={showPlaceLabels}
            menuSlot={workspaceMenu}
            onBeforeScreenShare={handleBeforeVideoScreenShare}
          />
        ) : null}

        {isBroadcast && !isSatelliteView && !isGlobalModelView && !isHistoricalView ? (
          <>
            {workspaceMode === 'record' ? (
              <VideoExportMenu
                currentTarget={
                  isAccumView
                    ? 'accum'
                    : isKimView
                      ? 'kim'
                      : isTrackingView
                        ? 'tracking'
                        : isTerrainView
                          ? 'terrain'
                          : 'radar'
                }
                mapRef={mapRef}
                defaultStart={videoDefaultStart}
                defaultEnd={videoDefaultEnd}
                onBeforeScreenShare={handleBeforeVideoScreenShare}
                onAfterScreenShare={handleAfterVideoScreenShare}
                onPreparePlayback={handleVideoPrepare}
                onStartPlayback={handleVideoStart}
                onCyclePhase={handleVideoCyclePhase}
                onRankingTable={handleVideoRankingTable}
                narrationScript={narrationScript}
                narrationVoice={narrationVoice}
                narrationRate={narrationRate}
                onAutoSetup={handleAutoVideoSetup}
              />
            ) : null}

            {/* 녹화모드: 지금 화면의 레이더에서 방송 원고 초안을 만든다.
                레이더 화면(누적·예상도·추적 제외)에서만 의미가 있어 그때만 띄운다. */}
            {workspaceMode === 'record' && isRadarView ? (
              <button
                type="button"
                data-video-hide
                onClick={handleBuildArticleFacts}
                disabled={articleBuildStatus === 'loading'}
                className="absolute bottom-24 left-6 z-40 flex h-10 items-center gap-2 rounded-full border border-cyan-300/50 bg-slate-950/85 px-4 text-xs font-black text-cyan-100 shadow-xl backdrop-blur-md transition hover:bg-slate-900"
              >
                {articleBuildStatus === 'loading'
                  ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <FileText className="h-4 w-4" aria-hidden="true" />}
                {articleBuildStatus === 'loading' ? '자료 분석 중' : '기사 생성'}
              </button>
            ) : null}

            {articleBuildError ? (
              <div
                data-video-hide
                className="absolute bottom-36 left-6 z-40 max-w-sm rounded-lg border border-red-300/40 bg-slate-950/90 px-3 py-2 text-xs font-bold text-red-100 shadow-xl"
              >
                {articleBuildError}
              </div>
            ) : null}

            {articleAnalysis ? (
              <ArticleDraftPanel
                analysis={articleAnalysis}
                durationSeconds={62.5}
                script={narrationScript}
                onScriptChange={setNarrationScript}
                voice={narrationVoice}
                onVoiceChange={setNarrationVoice}
                speakingRate={narrationRate}
                onRateChange={setNarrationRate}
                onClose={() => setArticleAnalysis(null)}
              />
            ) : null}
            {/* 좌상단: 타이틀 밴드(참고 그래픽과 동일 위치·비율) + 현재 프레임 날짜·시각 */}
            <div className="pointer-events-none absolute left-[4.4%] top-[14%] z-20 flex items-center">
              <div className="relative flex h-20 w-[620px] max-w-[72vw] items-center gap-4 overflow-hidden rounded-md bg-gradient-to-r from-[#0a3070]/95 via-[#155bb5]/95 to-[#2f7cd6]/95 px-5 text-white shadow-2xl">
                <div className="flex flex-col leading-none"><span className="text-sm font-black">KBS</span><span className="mt-1 text-[10px] font-bold text-white/75">WEATHER</span></div>
                <span className="whitespace-nowrap text-3xl font-black">
                  {isAccumView
                    ? '누적 강수량'
                    : isKimView
                      ? '강수 예상도'
                      : isTrackingView
                        ? '호우 추적'
                        : isTerrainView
                          ? '지형 호우'
                          : '레이더 영상'}
                </span>
                {/* 컨트롤바를 현재 시각 뒤로 넘기면 초단기 예측이 보인다.
                    관측과 헷갈리지 않게 밴드에서 색을 달리해 알린다. */}
                {!isAccumView && !isKimView && currentFrame?.kind === 'fct' ? (
                  <span className="whitespace-nowrap text-2xl font-black text-[#ffd400]">
                    예측
                  </span>
                ) : null}
                {(isAccumView ? currentAccumHour : isKimView ? currentKimFrame : currentFrame) ? (
                  <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap border-l border-white/30 pl-4">
                    <span className="text-2xl font-black tabular-nums">
                      {formatHourMinute(
                        isAccumView
                          ? currentAccumHour
                          : isKimView
                            ? currentKimFrame.validTime
                            : currentFrame.validTime,
                      )}
                    </span>
                    <span className="text-sm font-bold text-[#bdd6fb]">
                      {formatBroadcastDate(
                        isAccumView
                          ? currentAccumHour
                          : isKimView
                            ? currentKimFrame.validTime
                            : currentFrame.validTime,
                      )}
                    </span>
                  </div>
                ) : null}
                <div className="absolute inset-x-0 bottom-0 h-[3px] bg-[#8ec2ff]" />
              </div>
            </div>

            <TerrainRainOverlay
              active={isTerrainView}
              currentTime={currentFrame?.validTime ?? null}
              latestObservationTime={frames[latestObservationIndex]?.validTime ?? null}
              mapRef={mapRef}
              workspaceMode={workspaceMode}
            />

            {isTrackingView && trackingPoint ? (
              <TrackingAnalysisPanel
                point={trackingPoint}
                series={trackingSeries}
                currentFrameIndex={frameIndex}
                latestObservationIndex={latestObservationIndex}
                direction={trackingDirection}
                isLoading={trackingLoading}
                onSelectFrame={handleTrackingFrameSelect}
                onReturnToCurrent={handleTrackingReturnToCurrent}
                onResetMap={handleTrackingResetMap}
                onClose={() => setTrackingPoint(null)}
              />
            ) : null}

            {/* 누적 강수량: 기간 최다 강수 5개 지점 */}
            {isAccumView ? (
              <div
                data-video-hide
                className={`pointer-events-none absolute z-20 flex justify-center transition-opacity duration-500 ease-in-out ${
                  showAccumTop5 && accumTop5.length > 0 ? 'opacity-100' : 'opacity-0'
                }`}
                style={{
                  left: '4.4%',
                  // 창이 작으면 화면 중앙 기준 계산이 밴드(top 14% + 높이 80px) 위로
                  // 올라와 겹쳤다. 밴드 아래(여백 12px)를 하한으로 둔다.
                  top: 'max(calc(14% + 92px), calc(50% - max(23vh, 140px) - 18.5px))',
                  width: 'min(620px, 72vw)',
                }}
              >
                <div
                  className="overflow-hidden rounded-md bg-slate-900/60 shadow-xl backdrop-blur-sm"
                  style={{ width: 'clamp(368px, 25vw, 575px)' }}
                >
                  <div className="divide-y divide-white/10">
                    {accumTop5.map((row, index) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-3 px-6 py-[1.05vh]"
                        style={{ fontSize: 'clamp(18px, 1.44vw, 30px)' }}
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

            {/* 레이더: 시간당 강수량 최다 5지점 (체크박스로 표시) — 누적 표와 같은 위치·형태.
                이 표는 방송 그래픽이라 녹화에도 찍혀야 한다. data-video-hide를 달면
                녹화가 시작되는 순간 display:none이 되어 영상에서 사라진다. */}
            {isRadarView ? (
              <div
                className={`pointer-events-none absolute z-20 flex justify-center transition-opacity duration-500 ease-in-out ${
                  showHourlyTop5 && hourlyTop5.length > 0 ? 'opacity-100' : 'opacity-0'
                }`}
                style={{
                  left: '4.4%',
                  // 창이 작으면 화면 중앙 기준 계산이 밴드(top 14% + 높이 80px) 위로
                  // 올라와 겹쳤다. 밴드 아래(여백 12px)를 하한으로 둔다.
                  top: 'max(calc(14% + 92px), calc(50% - max(23vh, 140px) - 18.5px))',
                  width: 'min(620px, 72vw)',
                }}
              >
                <div
                  className="overflow-hidden rounded-md bg-slate-900/60 shadow-xl backdrop-blur-sm"
                  style={{ width: 'clamp(368px, 25vw, 575px)' }}
                >
                  <div className="border-b border-white/15 px-6 py-2.5 text-base font-black text-white/80">
                    시간당 강수량
                  </div>
                  <div className="divide-y divide-white/10">
                    {hourlyTop5.map((row, index) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-3 px-6 py-[1.05vh]"
                        style={{ fontSize: 'clamp(18px, 1.44vw, 30px)' }}
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

            {/* 좌측 세로 스케일: 레이더(mm/h) 또는 누적 강수량(mm). 방송·녹화에서도 표시한다. */}
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
            <div data-video-hide className="absolute bottom-0 left-1/2 right-0 z-10 bg-gradient-to-t from-slate-900/65 via-slate-900/35 to-transparent pb-4 pl-0 pr-6 pt-10">
              {renderTimeline(true)}
            </div>

            <div data-video-hide className="absolute bottom-[8.5rem] right-6 z-20 flex flex-col items-end gap-2.5">
              {workspaceMenu}
              {workspaceMode !== 'broadcast' ? (
                <>
                  {isRadarDataView ? renderRadarHistoryControls(true) : null}
                  <div className="flex items-center gap-2">
                {isAccumView ? (
                  <>
                    {accumRangeMode === 'custom' ? (
                      <div className="flex h-10 items-center gap-1.5 rounded-full border border-white/25 bg-slate-900/55 px-3 text-sm font-semibold text-white backdrop-blur-sm">
                        <input
                          type="datetime-local"
                          value={accumCustomStartInput}
                          max={accumCustomEndInput || undefined}
                          onChange={(event) => setAccumCustomStartInput(event.target.value)}
                          className="h-7 rounded bg-slate-800/80 px-1.5 text-xs text-white outline-none [color-scheme:dark]"
                          aria-label="누적 시작 시각"
                        />
                        <span className="text-white/60">~</span>
                        <input
                          type="datetime-local"
                          value={accumCustomEndInput}
                          min={accumCustomStartInput || undefined}
                          onChange={(event) => setAccumCustomEndInput(event.target.value)}
                          className="h-7 rounded bg-slate-800/80 px-1.5 text-xs text-white outline-none [color-scheme:dark]"
                          aria-label="누적 종료 시각"
                        />
                        <button
                          type="button"
                          onClick={handleApplyAccumCustomRange}
                          disabled={!accumCustomStartInput || !accumCustomEndInput}
                          className="h-7 rounded-full bg-white px-2.5 text-xs font-black text-slate-900 transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          적용
                        </button>
                      </div>
                    ) : null}
                    <select
                      value={accumRangeMode === 'custom' ? 'custom' : String(accumDays)}
                      onChange={(event) => {
                        setIsPlaying(false);
                        const { value } = event.target;
                        if (value === 'custom') {
                          prepareAccumCustomInputs();
                          return;
                        }
                        setAccumRangeMode('preset');
                        setAccumCustomRange(null);
                        setAccumDays(Number(value));
                      }}
                      className="h-10 cursor-pointer rounded-full border border-white/25 bg-slate-900/55 px-3 text-sm font-semibold text-white outline-none backdrop-blur-sm"
                      aria-label="누적 기간"
                    >
                      <option value="custom" className="text-slate-900">
                        임의
                      </option>
                      {[1, 2, 3, 4, 5].map((days) => (
                        <option key={days} value={String(days)} className="text-slate-900">
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
                {isRadarView ? (
                  <label className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-slate-900/55 px-3.5 text-sm font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-900/75">
                    <input
                      type="checkbox"
                      checked={showHourlyTop5}
                      onChange={(event) => setShowHourlyTop5(event.target.checked)}
                      className="h-4 w-4 cursor-pointer accent-[#3d86e8]"
                    />
                    시간당 강수량
                  </label>
                ) : null}
                {isAccumView ? (
                  <label className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-slate-900/55 px-3.5 text-sm font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-slate-900/75">
                    <input
                      type="checkbox"
                      checked={showAccumTop5}
                      onChange={(event) => setShowAccumTop5(event.target.checked)}
                      className="h-4 w-4 cursor-pointer accent-[#f4c542]"
                    />
                    누적강수량 5위
                  </label>
                ) : null}
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
                </>
              ) : isRadarView || isAccumView ? (
                <label className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-slate-950/75 px-3.5 text-sm font-black text-white shadow-xl backdrop-blur-sm">
                  <input
                    type="checkbox"
                    checked={isRadarView ? showHourlyTop5 : showAccumTop5}
                    onChange={(event) => {
                      if (isRadarView) setShowHourlyTop5(event.target.checked);
                      else setShowAccumTop5(event.target.checked);
                    }}
                    className="h-4 w-4 cursor-pointer accent-[#f4c542]"
                  />
                  {isRadarView ? '시간당 강수량 5위' : '누적강수량 5위'}
                </label>
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
