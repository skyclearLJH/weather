// 방송모드 위성 영상 뷰 (작업 중 — main.jsx의 ?satellite=1 게이트로만 진입).
//
// 천리안2A(GK2A) IR105 관측을 구면 지도 위에 그리고, 휘도온도에서 유도한
// 의사 운정고도로 구름을 3D 돌출(과장)시켜 표현한다. 데이터는 NOAA 공개
// 버킷의 FD 원본 하나에서 두 해상도로 뽑는다: 전구 22km(FD) 배경 + 한반도
// 주변 6km(KO) 정밀. 과거 12시간을 10분 간격으로 조회할 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import HistoricalDateTimeInput from './HistoricalDateTimeInput.jsx';
import VideoExportMenu from './VideoExportMenu.jsx';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  DN_TO_BT_KELVIN,
  FD_GRID,
  KO_GRID,
  LA_GRID,
  buildSatTimeline,
  fdCellToLonLat,
  fetchSatFrame,
  fetchSatFramePair,
  koCellToLonLat,
  laCellToLonLat,
  probeLatestSatDate,
} from '../api/satApi';
import {
  applyPlayCamera,
  captureCamera,
  clearPlayRange,
  readPlayRange,
  resolvePlayRange,
  writePlayRange,
} from '../utils/broadcastPlayRange.js';
import { fetchActiveTyphoons, formatAnnounceLabel, GRADE_LABELS } from '../api/typhoonApi';
import { sweptEnvelopeMesh, sweptEnvelopePolygon } from '../lib/typhoonGeometry';
import './SatelliteView.css';

const PLAY_RANGE_VIEW_ID = 'satellite';

// 6시간(36프레임). 12시간(72프레임)은 프레임당 약 4.3MB라 브라우저가 ~314MB를 들고
// 있어야 해서, 메모리 압박으로 캐시가 밀려나며 스크럽 시 빈 화면이 보였다.
// 6시간이면 ~160MB로 절반이고, 채워야 할 프레임도 절반이라 로딩이 안정적이다.
// 워커(satellite-precompute.js)의 TIMELINE_HOURS와 반드시 같게 유지할 것.
const TIMELINE_HOURS = 6;
const STEP_MINUTES = 10;
const AUTO_REFRESH_MS = 60 * 1000;
const SATELLITE_ARCHIVE_MIN_INPUT = '2023-02-16T15:00';
const BROADCAST_PLAY_DURATIONS = Array.from({ length: 11 }, (_, index) => index + 5); // 5~15초
const LA_PREFETCH_WORKERS = 2;
const PREFETCH_RETRY_BASE_MS = 2500;
const PREFETCH_RETRY_MAX_MS = 30000;

const prefetchRetryDelay = (attempt) =>
  Math.min(PREFETCH_RETRY_MAX_MS, PREFETCH_RETRY_BASE_MS * 2 ** Math.min(attempt, 4));
const waitFor = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ── 태풍 진로도 ──────────────────────────────────────────────────────────────
const TYPHOON_REFRESH_MS = 10 * 60 * 1000;
// 반경 엔벨로프(진로를 따라 이은 반투명 띠) 3종. fill 순서상 큰 것부터 아래에 깔아
// 위의 작은 반경이 보이게 한다. (강풍15 반경 > 폭풍25 반경, 확률원은 별도 원뿔)
// 반경 엔벨로프 3종 — 커스텀 WebGL 레이어가 직접 그린다(색은 0~1 RGB).
// 큰 반경이 아래, 작은 반경이 위로 오도록 이 순서로 그린다.
const TYPHOON_ENVELOPES = [
  { key: 'prob', pick: (p, current) => (p === current ? 0 : p.radProb), fill: [0.886, 0.91, 0.941], fillAlpha: 0.22, line: [0.973, 0.98, 0.988] },
  { key: 'wind15', pick: (p) => p.rad15, fill: [0.98, 0.8, 0.082], fillAlpha: 0.22, line: [0.992, 0.878, 0.278] },
  { key: 'wind25', pick: (p) => p.rad25, fill: [0.937, 0.267, 0.267], fillAlpha: 0.3, line: [0.973, 0.443, 0.443] },
];

// 등급별 중심 마크 색
const GRADE_COLOR = { 0: '#94a3b8', 1: '#38bdf8', 2: '#22c55e', 3: '#eab308', 4: '#f97316', 5: '#ef4444' };

// 태풍(허리케인) 심볼 — 굵은 두 팔 나선 + 큰 중앙 구멍. 구멍 자리에 등급 숫자
// disc가 들어가 팔과 자연스럽게 이어진다. 색은 CSS(currentColor)에서 준다.
// evenodd로 중앙 원(반지름 96)을 뚫어 구멍을 만든다(원본의 중앙 점은 제거).
const TYPHOON_SWIRL_SVG =
  '<svg viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" aria-hidden="true">' +
  '<path d="M0 208C0 104.4 75.7 18.5 174.9 2.6C184 1.2 192 8.6 192 17.9l0 63.3c0 8.4 6.5 15.3 14.7 16.5C307 112.5 384 199 384 303.4c0 103.6-75.7 189.5-174.9 205.4c-9.2 1.5-17.1-5.9-17.1-15.2l0-63.3c0-8.4-6.5-15.3-14.7-16.5C77 398.9 0 312.4 0 208zM288 256A96 96 0 1 0 96 256A96 96 0 1 0 288 256z"/>' +
  '</svg>';

// 중심 마크 DOM 엘리먼트 생성(태풍 심볼 + 등급 숫자). 클릭 팝업용 데이터 포함.
// 크기 조절은 el.transform이 아니라 --mark-scale CSS 변수로 넘긴다. (el.transform은
// MapLibre가 마커 위치 지정에 쓰므로 절대 덮어쓰면 안 됨 — 덮어쓰면 줌 시 위치가
// 틀어지거나 좌상단으로 튄다.) 실제 축소는 내부 래퍼(.typhoon-mark__inner)에 적용.
const buildTyphoonMarkerEl = (props, scale) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `typhoon-mark${props.isCurrent ? ' typhoon-mark--current' : ''}`;
  el.style.setProperty('--g-color', GRADE_COLOR[props.grade] ?? GRADE_COLOR[0]);
  el.style.setProperty('--mark-scale', String(scale ?? 1));
  // 지점 라벨: 현재는 '현재', 예측은 해당 예측시각(KST, 정시)을 날짜/시각 두 줄로.
  // 예측 유효시각은 정확한 값이라 +1h 보정 없이 그대로 쓴다(밴드의 '발표시각'만 +1h).
  let labelHtml = '';
  if (props.isCurrent) {
    labelHtml = '<span class="typhoon-mark__label"><span>현재</span></span>';
  } else if (props.validTime) {
    const k = new Date(new Date(props.validTime).getTime() + 9 * 3600 * 1000);
    const day = `${k.getUTCMonth() + 1}/${k.getUTCDate()}`;
    const hour = `${k.getUTCHours()}시`;
    labelHtml = `<span class="typhoon-mark__label"><span>${day}</span><span>${hour}</span></span>`;
  }
  el.innerHTML =
    '<span class="typhoon-mark__inner">' +
    `<span class="typhoon-mark__swirl">${TYPHOON_SWIRL_SVG}</span>` +
    '<span class="typhoon-mark__disc"></span>' +
    `<span class="typhoon-mark__num">${props.gradeText || ''}</span>` +
    labelHtml +
    '</span>';
  return el;
};

// 줌 레벨 → 중심 마크 배율 (줌인 시 과도하게 커지지 않게 완만히 축소)
const typhoonMarkScale = (zoom) => {
  const z = Math.min(9, Math.max(3, zoom));
  return 1.15 - ((z - 3) / 6) * 0.55; // z3≈1.15, z9≈0.6
};

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

// 현재 위치를 '실제 현재 시각'으로 내삽한다. 발표 시점의 분석 위치(current)와 그
// 다음 첫 예측 위치(forecast[0]) 사이를 시간 비율로 선형 보간해, 발표 후 흐른 시간
// 만큼 태풍이 이동한 위치를 표기한다. (정확한 실시간 위치는 알 수 없으므로 근사)
const interpolatedCurrent = (typhoon, nowMs = Date.now()) => {
  const c = typhoon?.current;
  const f0 = typhoon?.forecast?.[0];
  if (!c || !f0 || !c.validTime || !f0.validTime) return c;
  const t0 = c.validTime.getTime();
  const t1 = f0.validTime.getTime();
  if (!(t1 > t0)) return c;
  const f = Math.min(1, Math.max(0, (nowMs - t0) / (t1 - t0)));
  if (f <= 0) return c;
  // 위치만 이동하고 강도·기압·반경 등 나머지 속성은 발표 시점 값을 유지한다.
  return { ...c, lat: c.lat + (f0.lat - c.lat) * f, lon: c.lon + (f0.lon - c.lon) * f };
};

// current를 내삽 위치로 교체한 태풍 객체(진로선·반경·마커 모두 이 current를 쓴다).
const withInterpolatedCurrent = (typhoon, nowMs) => {
  if (!typhoon) return typhoon;
  const current = interpolatedCurrent(typhoon, nowMs);
  return current === typhoon.current ? typhoon : { ...typhoon, current };
};

// 선택 태풍 + 반경 토글로 각 소스에 넣을 GeoJSON을 만든다.
// 리빌: 현재(가까운 시점)에서 미래로 reveal(0~1)만큼만 이어지는 트랙 지점 배열.
// 마지막 부분 구간은 위치·반경을 보간해 부드럽게 확장시킨다.
const revealTrackPoints = (typhoon, reveal) => {
  const { current, forecast } = typhoon;
  const trackPts = [current, ...forecast];
  if (reveal >= 1) return trackPts;
  const maxTmd = trackPts[trackPts.length - 1]?.tmd || 1;
  const lerp = (a, b, f) => {
    const av = Number.isFinite(a) && a > 0 ? a : 0;
    const bv = Number.isFinite(b) && b > 0 ? b : 0;
    return av + (bv - av) * f;
  };
  const rt = reveal * maxTmd;
  const out = [];
  for (let i = 0; i < trackPts.length; i += 1) {
    const p = trackPts[i];
    if (p.tmd <= rt + 1e-6) {
      out.push(p);
      continue;
    }
    const prev = trackPts[i - 1];
    const span = p.tmd - (prev?.tmd ?? 0);
    const f = span > 0 ? (rt - prev.tmd) / span : 0;
    if (prev && f > 0.02) {
      out.push({
        lat: prev.lat + (p.lat - prev.lat) * f,
        lon: prev.lon + (p.lon - prev.lon) * f,
        tmd: rt,
        radProb: lerp(prev === current ? 0 : prev.radProb, p.radProb, f),
        rad15: lerp(prev.rad15, p.rad15, f),
        rad25: lerp(prev.rad25, p.rad25, f),
      });
    }
    break;
  }
  return out.length >= 1 ? out : [trackPts[0]];
};

// 중심 마크(DOM 마커)용 좌표·속성. 진로선·반경은 커스텀 WebGL 레이어가 직접 그린다.
const buildTyphoonCenters = (typhoon) => {
  if (!typhoon) return emptyFC();
  const { current, forecast } = typhoon;
  const trackPts = [current, ...forecast];
  const lonLat = (p) => [p.lon, p.lat];
  const maxTmd = trackPts[trackPts.length - 1]?.tmd || 1;
  // frac = 지점의 진행 비율(현재 0 → 마지막 예측 1) → 리빌 임계값으로 사용.
  const centers = {
    type: 'FeatureCollection',
    features: trackPts.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: lonLat(p) },
      properties: {
        grade: p.grade ?? 0,
        gradeText: p.grade ? String(p.grade) : '',
        gradeLabel: p.grade ? GRADE_LABELS[p.grade] : '열대저압부',
        isCurrent: p === current ? 1 : 0,
        pressure: p.pressure ?? -1,
        wind: p.wind ?? -1,
        rad15: p.rad15 ?? -1,
        rad25: p.rad25 ?? -1,
        validTime: p.validTime ? p.validTime.toISOString() : '',
        tmd: p.tmd ?? 0,
        frac: (p.tmd ?? 0) / maxTmd,
      },
    })),
  };

  return centers;
};

const floorToTenMinutesLocal = (date) => {
  const floored = new Date(date);
  floored.setMinutes(Math.floor(floored.getMinutes() / 10) * 10, 0, 0);
  return floored;
};

const formatLocalDateTimeInput = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

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

// 휘도온도(°C) → 표시 강도/의사 운정고도
const BT_CLEAR_C = 15; // 이보다 따뜻하면 구름 없음 취급
const BT_TOP_C = -75; // 이보다 차가우면 최대 강도
const LAPSE_C_PER_KM = 6.5;
const MAX_CLOUD_KM = 16;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// 위성 화면에는 지명(시도·시군구) 라벨을 두지 않는다. 심볼 라벨을 켜면 FD(전구)에
// 깜빡임(렌더 경합)이 재발해, 위성에서는 라벨 소스·레이어·토글을 아예 제거했다.

// 대류운 강조: 의사 운정고도(휘도온도에서 유도) 기준 — 높을수록 강한 대류.
// 권계면 높이가 계절에 따라 달라 같은 강도의 대류라도 겨울엔 운정이 낮다.
// [강조 시작 km, 최대 강조 km] — 여름은 권계면(15~16km) 부근 적란운 기준,
// 겨울은 한기 대류(서해 눈구름 등)가 5km급이면 이미 깊은 대류라 낮게 잡는다.
const SEASON_CONV_KM = {
  summer: [10, 13], // 6~8월
  spring: [8, 11], // 3~5월
  autumn: [8, 11], // 9~11월
  winter: [5, 8], // 12~2월
};

const seasonalConvRange = (dateUtc) => {
  const month = new Date(dateUtc.getTime() + KST_OFFSET_MS).getUTCMonth() + 1;
  if (month >= 6 && month <= 8) return SEASON_CONV_KM.summer;
  if (month >= 3 && month <= 5) return SEASON_CONV_KM.spring;
  if (month >= 9 && month <= 11) return SEASON_CONV_KM.autumn;
  return SEASON_CONV_KM.winter;
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const formatKstLabel = (dateUtc) => {
  const kst = new Date(dateUtc.getTime() + KST_OFFSET_MS);
  return {
    date: `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} (${WEEKDAYS[kst.getUTCDay()]})`,
    clock: `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`,
  };
};

const formatTickLabel = (dateUtc) => {
  const kst = new Date(dateUtc.getTime() + KST_OFFSET_MS);
  return `${String(kst.getUTCHours()).padStart(2, '0')}시`;
};

const MAP_STYLE = {
  version: 8,
  projection: { type: 'globe' },
  // 대기광: 지구 가장자리 산란광 링. 세게 주면 지도 전체가 씻겨 보여서
  // 낮은 블렌드로 림 효과만 남기고, 줌인하면 서서히 사라지게 한다.
  sky: {
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 3.5, 0.28, 4.5, 0.18, 6.5, 0],
  },
  light: { anchor: 'map', position: [1.5, 90, 80] },
  sources: {
    // 전 세계 육지 — FD 전구 디스크가 보여주는 모든 영역(인도·중앙아시아·호주 등)을 덮는다
    land: { type: 'geojson', data: '/data/map/land-50m-world.geojson' },
    sido: { type: 'geojson', data: '/data/map/kr-sido-20260701.geojson' },
  },
  layers: [
    // 배경 = 바다, land 폴리곤 = 육지 — 구름이 덮여도 면 대비로 지형이 읽히게 한다.
    // 팔레트: 한난 대비를 위해 지도는 차가운 슬레이트 계열로 통일 (대류운 강조가 난색).
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a1522' } },
    {
      id: 'land',
      type: 'fill',
      source: 'land',
      paint: { 'fill-color': '#2f3945' },
    },
    // 한국(남한) 육지는 고해상도 시도 폴리곤으로 같은 색으로 다시 채워, 그 위에서
    // 저해상도 50m 세계 육지(land)를 덮는다. 섬까지 선명한 sido 윤곽과 한 겹으로
    // 맞아 '두 겹' 문제가 사라진다. (전구 배경의 나머지 세계는 고해상도 자료가 없어
    // 50m를 그대로 쓰지만, 배경이라 문제되지 않는다. 북한은 남한 시도에 없어 제외.)
    {
      id: 'korea-land',
      type: 'fill',
      source: 'sido',
      paint: { 'fill-color': '#2f3945' },
    },
    // 해안선 선(line)은 50m 저해상도라 고해상도 sido와 어긋나 '두 번째 윤곽'으로
    // 보였다. 제거한다 — 세계 육지는 채움 면의 육지/바다 색 대비로, 한국 해안선은
    // 아래 sido 선(외곽 = 해안선)으로 나타낸다.
    {
      id: 'sido',
      type: 'line',
      source: 'sido',
      paint: { 'line-color': '#647d97', 'line-width': 1.0 },
    },
  ],
};

// KO(동아시아) 3D 높이 메쉬는 데이터 해상도(1809x1066)와 분리해 성기게 만든다.
// STEP=4 → 453x267 정점(약 12만). 구름 '이미지'는 풀해상도 DN 텍스처를 프래그먼트
// 셰이더에서 샘플해 선명하게 그리고, 3D 돌출(높이)만 이 성긴 메쉬가 담당한다.
const KO_MESH_STEP = 4;
const LA_MESH_STEP = 2;

// --- 커스텀 3D 구름 레이어 ---
const createCloudLayer = () => {
  const layer = {
    id: 'gk2a-clouds',
    type: 'custom',
    renderingMode: '3d',
    exaggeration: 6,
    convStartKm: SEASON_CONV_KM.summer[0],
    convFullKm: SEASON_CONV_KM.summer[1],
    shaderMap: new Map(),

    // 구면(globe)/메르카토르 투영별 셰이더 — MapLibre가 주입하는 projectTile* 프렐류드 사용.
    // globe 변형은 elevation을 미터로 받고(GLOBE_RADIUS로 나눔), 메르카토르 변형은
    // 행렬이 메르카토르 z 단위를 기대하므로 aZScale(위도별 m→merc 변환)을 곱한다.
    // 색(강도)은 uUseTexture일 때 풀해상도 DN 텍스처(uEaTex)를 4탭 이중선형 샘플 →
    // DN→강도 LUT(uLut)로 매핑해 프래그먼트마다 선명하게 계산한다. 고도·음영·대류는
    // 성긴 메쉬의 정점 보간값을 쓴다(3D 릴리프는 성겨도 됨). FD는 uUseTexture=0.
    getShader(gl, shaderDescription) {
      if (this.shaderMap.has(shaderDescription.variantName)) {
        return this.shaderMap.get(shaderDescription.variantName);
      }
      const vertexSource = `#version 300 es
        ${shaderDescription.vertexShaderPrelude}
        ${shaderDescription.define}
        in vec2 aPos;
        in float aZScale;
        in vec4 aCloud; // x: 강도 0..1, y: 고도(m), z: 음영 계수, w: 대류 0..1
        in vec2 aTexCoord;
        uniform float uExag;
        out float vTv;
        out float vShade;
        out float vConv;
        out vec2 vTexCoord;
        void main() {
          vTv = aCloud.x;
          vShade = aCloud.z;
          vConv = aCloud.w;
          vTexCoord = aTexCoord;
          #ifdef GLOBE
            float elevation = aCloud.y * uExag;
          #else
            float elevation = aCloud.y * aZScale * uExag;
          #endif
          // projectTileWithElevation은 지구 뒷면 클리핑용 z를 쓴다 — 뒷면 구름 숨김
          gl_Position = projectTileWithElevation(aPos, elevation);
        }`;
      const fragmentSource = `#version 300 es
        precision highp float;
        in float vTv;
        in float vShade;
        in float vConv;
        in vec2 vTexCoord;
        uniform float uConvOn;
        uniform float uUseTexture;
        uniform float uAlpha; // 프레임 전환(디졸브) 시 전체 불투명도
        uniform highp usampler2D uEaTex; // 풀해상도 DN (R16UI)
        uniform sampler2D uLut;          // DN→강도 LUT (8192x1, R8)
        out vec4 fragColor;
        float lutIntensity(int dn) {
          return texelFetch(uLut, ivec2(clamp(dn, 0, 8191), 0), 0).r;
        }
        void main() {
          float vT;
          if (uUseTexture > 0.5) {
            // 풀해상도 DN을 4탭 이중선형으로 → LUT 강도. 텍셀보다 촘촘히 확대돼도 부드럽다.
            vec2 ts = vec2(textureSize(uEaTex, 0));
            vec2 p = vTexCoord * ts - 0.5;
            vec2 f = fract(p);
            ivec2 b = ivec2(floor(p));
            ivec2 mx = ivec2(ts) - 1;
            int d00 = int(texelFetch(uEaTex, clamp(b, ivec2(0), mx), 0).r);
            int d10 = int(texelFetch(uEaTex, clamp(b + ivec2(1, 0), ivec2(0), mx), 0).r);
            int d01 = int(texelFetch(uEaTex, clamp(b + ivec2(0, 1), ivec2(0), mx), 0).r);
            int d11 = int(texelFetch(uEaTex, clamp(b + ivec2(1, 1), ivec2(0), mx), 0).r);
            float i0 = mix(lutIntensity(d00), lutIntensity(d10), f.x);
            float i1 = mix(lutIntensity(d01), lutIntensity(d11), f.x);
            vT = mix(i0, i1, f.y);
          } else {
            vT = vTv;
          }
          // 반투명: 전운량이어도 지도가 비치도록 최대 알파를 낮게 유지
          float alpha = smoothstep(0.02, 0.30, vT) * mix(0.34, 0.72, vT);
          vec3 low = vec3(0.58, 0.65, 0.76);
          vec3 high = vec3(1.0, 1.0, 1.0);
          vec3 color = mix(low, high, clamp(vT * 1.25, 0.0, 1.0));
          // 대류운 강조: 계절별 운정고도 임계값(노랑 → 적색)
          float conv = vConv * uConvOn;
          float convMixT = smoothstep(0.06, 0.45, conv);
          vec3 warm = mix(vec3(1.0, 0.84, 0.30), vec3(0.93, 0.23, 0.12), smoothstep(0.35, 1.0, conv));
          color = mix(color, warm, convMixT);
          alpha = max(alpha, smoothstep(0.06, 0.6, conv) * 0.9);
          float shade = mix(vShade, 1.0, convMixT);
          fragColor = vec4(color * shade * alpha, alpha) * uAlpha;
        }`;
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error('[satellite] shader compile:', gl.getShaderInfoLog(shader));
        }
        return shader;
      };
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[satellite] program link:', gl.getProgramInfoLog(program));
      }
      const shader = {
        program,
        aPos: gl.getAttribLocation(program, 'aPos'),
        aZScale: gl.getAttribLocation(program, 'aZScale'),
        aCloud: gl.getAttribLocation(program, 'aCloud'),
        aTexCoord: gl.getAttribLocation(program, 'aTexCoord'),
        uExag: gl.getUniformLocation(program, 'uExag'),
        uConvOn: gl.getUniformLocation(program, 'uConvOn'),
        uUseTexture: gl.getUniformLocation(program, 'uUseTexture'),
        uAlpha: gl.getUniformLocation(program, 'uAlpha'),
        uEaTex: gl.getUniformLocation(program, 'uEaTex'),
        uLut: gl.getUniformLocation(program, 'uLut'),
        uProjMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
        uFallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
        uTileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
        uClippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
        uTransition: gl.getUniformLocation(program, 'u_projection_transition'),
      };
      this.shaderMap.set(shaderDescription.variantName, shader);
      return shader;
    },

    onAdd(map, gl) {
      this.map = map;
      // 전용 VAO: MapLibre(WebGL2)는 레이어마다 VAO를 바인딩한다. 커스텀 레이어가
      // 전역 VAO에 attribute를 설정하면, 태풍 진로도의 fill/line(과거의 지명 symbol)
      // 레이어가 추가되는 순간 MapLibre가 남긴 VAO 상태와 뒤섞여 FD(전구) 드로우가
      // 깨졌다(FD가 통째로 사라지거나 일부 프레임만 그려짐). 우리 VAO 안에서만
      // attribute/인덱스를 설정하고 끝나면 해제해 완전히 격리한다.
      this.vao = gl.createVertexArray ? gl.createVertexArray() : null;
      // 버퍼 생성 중 ELEMENT_ARRAY_BUFFER 바인딩은 '현재 VAO'에 기록되므로, 남의
      // VAO(=MapLibre 것)를 건드리지 않도록 우리 VAO 안에서 만든다.
      if (this.vao) gl.bindVertexArray(this.vao);
      const makeBuffer = (target, data, usage) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, data, usage);
        return buffer;
      };

      // DN(0..8191) → 강도(0..1) LUT를 R8 텍스처로 한 번만 만든다. float64 정밀 계산.
      const lutBytes = new Uint8Array(8192);
      for (let dn = 0; dn < 8192; dn++) {
        const btK = DN_TO_BT_KELVIN[dn];
        const btC = Number.isNaN(btK) ? BT_TOP_C - 30 : btK - 273.15;
        const intensity = Math.min(1, Math.max(0, (BT_CLEAR_C - btC) / (BT_CLEAR_C - BT_TOP_C)));
        lutBytes[dn] = Math.round(intensity * 255);
      }
      this.lutTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 8192, 1, 0, gl.RED, gl.UNSIGNED_BYTE, lutBytes);

      // 정점 위치(메르카토르)/고도 스케일/텍스처좌표/인덱스는 고정 — 메쉬별로 한 번만 계산.
      // vertexAt(mi,mj)이 [lon,lat] 또는 null(무효 정점), texCoordAt이 [u,v]를 반환.
      const buildMesh = (w, h, vertexAt, quadVisible, sample, texCoordAt) => {
        const positions = new Float32Array(w * h * 2);
        const zScales = new Float32Array(w * h);
        const texCoords = new Float32Array(w * h * 2);
        const valid = new Uint8Array(w * h);
        let v = 0;
        for (let mj = 0; mj < h; mj++) {
          for (let mi = 0; mi < w; mi++) {
            const lonLat = vertexAt(mi, mj);
            if (lonLat) {
              const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lonLat[0], lat: lonLat[1] }, 0);
              positions[v * 2] = merc.x;
              positions[v * 2 + 1] = merc.y;
              zScales[v] = maplibregl.MercatorCoordinate.fromLngLat({ lng: lonLat[0], lat: lonLat[1] }, 1).z;
              valid[v] = 1;
            }
            const uv = texCoordAt ? texCoordAt(mi, mj) : [0, 0];
            texCoords[v * 2] = uv[0];
            texCoords[v * 2 + 1] = uv[1];
            v++;
          }
        }
        const buildIndices = (visible) => {
          const indices = [];
          for (let mj = 0; mj < h - 1; mj++) {
            for (let mi = 0; mi < w - 1; mi++) {
              const i0 = mj * w + mi;
              if (!valid[i0] || !valid[i0 + 1] || !valid[i0 + w] || !valid[i0 + w + 1]) continue;
              if (visible && !visible(mi, mj)) continue;
              indices.push(i0, i0 + 1, i0 + w, i0 + 1, i0 + w + 1, i0 + w);
            }
          }
          return new Uint32Array(indices);
        };
        const indexArray = buildIndices(quadVisible);
        return {
          w,
          h,
          sample,
          textured: false,
          dataTex: null,
          dataW: 0,
          dataH: 0,
          frameData: null,
          dirty: false,
          cloudArray: new Float32Array(w * h * 4),
          heightScratch: new Float32Array(w * h),
          posBuffer: makeBuffer(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW),
          zScaleBuffer: makeBuffer(gl.ARRAY_BUFFER, zScales, gl.STATIC_DRAW),
          texCoordBuffer: makeBuffer(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW),
          cloudBuffer: makeBuffer(gl.ARRAY_BUFFER, new Float32Array(w * h * 4), gl.DYNAMIC_DRAW),
          // 프레임 디졸브용 이전 프레임 버퍼(구름 값). 텍스처 메쉬는 prevDataTex도 둔다.
          prevCloudBuffer: makeBuffer(gl.ARRAY_BUFFER, new Float32Array(w * h * 4), gl.DYNAMIC_DRAW),
          prevDataTex: null,
          hasPrev: false,
          indexBuffer: makeBuffer(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW),
          indexCount: indexArray.length,
          buildIndices,
          makeBuffer,
        };
      };

      // 텍스처 파라미터를 동일하게 준 DN 텍스처 생성 헬퍼(현재/이전 공용)
      const makeDataTex = () => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
      };

      // KO: 동아시아 정밀. 데이터는 1809x1066(4km)이지만 높이 메쉬는 STEP=4로 성기게.
      // texCoord는 각 성긴 정점을 풀해상도 텍스처의 해당 위치로 매핑한다.
      const KW = KO_GRID.width;
      const KH = KO_GRID.height;
      const koMeshW = Math.floor((KW - 1) / KO_MESH_STEP) + 1;
      const koMeshH = Math.floor((KH - 1) / KO_MESH_STEP) + 1;
      const koDataCol = (mi) => Math.min(mi * KO_MESH_STEP, KW - 1);
      const koDataRow = (mj) => Math.min(mj * KO_MESH_STEP, KH - 1);
      const koMesh = buildMesh(
        koMeshW,
        koMeshH,
        (mi, mj) => koCellToLonLat(koDataCol(mi), koDataRow(mj)),
        null,
        (frameData, mi, mj) => frameData[koDataRow(mj) * KW + koDataCol(mi)],
        (mi, mj) => [(koDataCol(mi) + 0.5) / KW, (koDataRow(mj) + 0.5) / KH],
      );
      koMesh.textured = true;
      koMesh.dataW = KW;
      koMesh.dataH = KH;
      koMesh.dataTex = makeDataTex();
      koMesh.prevDataTex = makeDataTex();

      // LA: NOAA 한반도 국지 관측. 작은 원본으로 첫 화면을 먼저 채우고 FD/KO가
      // 준비되면 제거한다. 격자 수를 줄여 초기 WebGL 메쉬 생성 부담도 낮춘다.
      const LW = LA_GRID.width;
      const LH = LA_GRID.height;
      const laMeshW = Math.floor((LW - 1) / LA_MESH_STEP) + 1;
      const laMeshH = Math.floor((LH - 1) / LA_MESH_STEP) + 1;
      const laDataCol = (mi) => Math.min(mi * LA_MESH_STEP, LW - 1);
      const laDataRow = (mj) => Math.min(mj * LA_MESH_STEP, LH - 1);
      const laMesh = buildMesh(
        laMeshW,
        laMeshH,
        (mi, mj) => laCellToLonLat(laDataCol(mi), laDataRow(mj)),
        null,
        (frameData, mi, mj) => frameData[laDataRow(mj) * LW + laDataCol(mi)],
        (mi, mj) => [(laDataCol(mi) + 0.5) / LW, (laDataRow(mj) + 0.5) / LH],
      );
      laMesh.textured = true;
      laMesh.dataW = LW;
      laMesh.dataH = LH;
      laMesh.dataTex = makeDataTex();
      laMesh.prevDataTex = makeDataTex();

      // FD: 디스크 밖 정점 무효화 + KO 크롭 안쪽은 KO 메쉬에 맡긴다.
      // 둘 다 FD 픽셀 좌표계라 사각형 비교면 충분 (여유 22px ≈ 44km 겹침).
      const koColMin = KO_GRID.col0 + 22;
      const koColMax = KO_GRID.col0 + KO_GRID.width * KO_GRID.factor - 22;
      const koRowMin = KO_GRID.row0 + 22;
      const koRowMax = KO_GRID.row0 + KO_GRID.height * KO_GRID.factor - 22;
      const fdCenter = (FD_GRID.factor - 1) / 2;
      const fdInsideKo = (mi, mj) => {
        const srcCol = mi * FD_GRID.factor + fdCenter;
        const srcRow = mj * FD_GRID.factor + fdCenter;
        return srcCol >= koColMin && srcCol <= koColMax && srcRow >= koRowMin && srcRow <= koRowMax;
      };
      const fdMesh = buildMesh(
        FD_GRID.width,
        FD_GRID.height,
        (mi, mj) => fdCellToLonLat(mi, mj),
        (mi, mj) =>
          !(fdInsideKo(mi, mj) && fdInsideKo(mi + 1, mj) && fdInsideKo(mi, mj + 1) && fdInsideKo(mi + 1, mj + 1)),
        (frameData, mi, mj) => frameData[mj * FD_GRID.width + mi],
        null,
      );

      // KO 프레임이 없을 때는 FD가 크롭 영역까지 채우도록 전체 인덱스 버퍼를 따로 둔다.
      const fdFullIndices = fdMesh.buildIndices(null);
      fdMesh.indexBufferFull = fdMesh.makeBuffer(gl.ELEMENT_ARRAY_BUFFER, fdFullIndices, gl.STATIC_DRAW);
      fdMesh.indexCountFull = fdFullIndices.length;

      // 그리기 순서: FD(배경) → KO(정밀) → LA(빠른 첫 화면)
      this.meshes = [fdMesh, koMesh, laMesh];
      this.meshByArea = { ko: koMesh, fd: fdMesh, la: laMesh };
      if (this.vao) gl.bindVertexArray(null);
    },

    setFrame(area, data) {
      const mesh = this.meshByArea?.[area];
      if (!mesh) return;
      mesh.frameData = data;
      mesh.dirty = Boolean(data);
      this.map?.triggerRepaint();
    },

    setConvRange(startKm, fullKm) {
      if (this.convStartKm === startKm && this.convFullKm === fullKm) return;
      this.convStartKm = startKm;
      this.convFullKm = fullKm;
      for (const mesh of this.meshes ?? []) mesh.dirty = true;
      this.map?.triggerRepaint();
    },

    // DN → (강도, 고도 m, 음영, 대류) 변환: 메쉬별 셀 중심 샘플.
    // 텍스처 메쉬(KO)는 강도(x)를 프래그먼트에서 텍스처로 계산하므로 정점 강도는 안 쓰지만,
    // 고도(y)·음영(z)·대류(w)는 여기서 채운다. 또 풀해상도 DN을 GPU 텍스처로 올린다.
    convertMesh(gl, mesh) {
      const { w, h, cloudArray: cloud, heightScratch: heights, frameData } = mesh;
      if (mesh.textured && mesh.dataTex) {
        gl.bindTexture(gl.TEXTURE_2D, mesh.dataTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.R16UI, mesh.dataW, mesh.dataH, 0,
          gl.RED_INTEGER, gl.UNSIGNED_SHORT, frameData,
        );
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      }
      let v = 0;
      for (let mj = 0; mj < h; mj++) {
        for (let mi = 0; mi < w; mi++) {
          const dn = mesh.sample(frameData, mi, mj);
          const btK = DN_TO_BT_KELVIN[Math.min(dn, 8191)];
          const btC = Number.isNaN(btK) ? BT_TOP_C - 30 : btK - 273.15;
          const intensity = Math.min(1, Math.max(0, (BT_CLEAR_C - btC) / (BT_CLEAR_C - BT_TOP_C)));
          const heightKm = Math.min(MAX_CLOUD_KM, Math.max(0, (BT_CLEAR_C - btC) / LAPSE_C_PER_KM));
          const conv = Math.min(
            1,
            Math.max(0, (heightKm - this.convStartKm) / (this.convFullKm - this.convStartKm)),
          );
          cloud[v * 4] = intensity;
          cloud[v * 4 + 3] = conv;
          heights[v] = heightKm * 1000;
          v++;
        }
      }
      // 고도 3x3 평균(스파이크 완화) + 북서 사면 밝게/남동 사면 어둡게 간이 음영
      for (let mj = 0; mj < h; mj++) {
        for (let mi = 0; mi < w; mi++) {
          let sum = 0;
          let count = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const nj = mj + dj;
            if (nj < 0 || nj >= h) continue;
            for (let di = -1; di <= 1; di++) {
              const ni = mi + di;
              if (ni < 0 || ni >= w) continue;
              sum += heights[nj * w + ni];
              count++;
            }
          }
          cloud[(mj * w + mi) * 4 + 1] = sum / count;
        }
      }
      for (let mj = 0; mj < h; mj++) {
        for (let mi = 0; mi < w; mi++) {
          const idx = mj * w + mi;
          const here = cloud[idx * 4 + 1];
          const nw = cloud[(Math.max(0, mj - 1) * w + Math.max(0, mi - 1)) * 4 + 1];
          const gradient = (here - nw) / 1000; // km per cell
          cloud[idx * 4 + 2] = Math.min(1.12, Math.max(0.72, 1 + gradient * 0.06));
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.cloudBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cloud);
      mesh.dirty = false;
      mesh.converted = true;
    },

    render(gl, renderArgs) {
      const projectionData = renderArgs?.defaultProjectionData;
      if (!projectionData || !this.meshes) return;

      for (const mesh of this.meshes) {
        if (mesh.dirty && mesh.frameData) this.convertMesh(gl, mesh);
      }

      // 우리 VAO 안에서만 attribute/인덱스를 설정한다(MapLibre VAO와 격리).
      if (this.vao) gl.bindVertexArray(this.vao);

      const shader = this.getShader(gl, renderArgs.shaderData);
      gl.useProgram(shader.program);
      gl.uniformMatrix4fv(shader.uProjMatrix, false, projectionData.mainMatrix);
      gl.uniformMatrix4fv(shader.uFallbackMatrix, false, projectionData.fallbackMatrix);
      gl.uniform4f(shader.uTileMercatorCoords, ...projectionData.tileMercatorCoords);
      gl.uniform4f(shader.uClippingPlane, ...projectionData.clippingPlane);
      gl.uniform1f(shader.uTransition, projectionData.projectionTransition);
      gl.uniform1f(shader.uExag, this.exaggeration);
      gl.uniform1f(shader.uConvOn, this.convHighlight ? 1 : 0);

      // LUT는 유닛1, KO/LA 풀해상도 DN 텍스처는 유닛0에 바인딩.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(shader.uLut, 1);
      gl.uniform1i(shader.uEaTex, 0);

      // GL 상태 위생: 태풍 진로도의 fill/line 레이어(예전 지명 라벨과 동일)를 얹으면
      // MapLibre가 레이어마다 서로 다른 gl.depthRange 슬라이스를 배정하고 STENCIL로
      // 타일을 클리핑하는데, 커스텀 구름 레이어가 그 depth/스텐실 상태를 물려받아
      // FD(전구) 구름이 depth·스텐실에 잘려 사라지거나 간헐적으로만 보였다.
      // 구름은 지구 뒷면을 셰이더 클립(projectTileWithElevation)으로 숨기므로 depth
      // 테스트가 필요 없다 → depth·스텐실을 꺼서 다른 레이어의 잔여 상태와 분리한다.
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const koHasData = !!this.meshByArea.ko.frameData;
      // 한 메쉬를 지정한 구름버퍼/텍스처/알파로 그린다.
      const drawMesh = (mesh, cloudBuffer, dataTex, alpha, useFull) => {
        if (mesh.textured) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, dataTex);
        }
        gl.uniform1f(shader.uUseTexture, mesh.textured ? 1 : 0);
        gl.uniform1f(shader.uAlpha, alpha);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
        gl.enableVertexAttribArray(shader.aPos);
        gl.vertexAttribPointer(shader.aPos, 2, gl.FLOAT, false, 0, 0);
        if (shader.aZScale >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.zScaleBuffer);
          gl.enableVertexAttribArray(shader.aZScale);
          gl.vertexAttribPointer(shader.aZScale, 1, gl.FLOAT, false, 0, 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffer);
        gl.enableVertexAttribArray(shader.aCloud);
        gl.vertexAttribPointer(shader.aCloud, 4, gl.FLOAT, false, 0, 0);
        if (shader.aTexCoord >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.texCoordBuffer);
          gl.enableVertexAttribArray(shader.aTexCoord);
          gl.vertexAttribPointer(shader.aTexCoord, 2, gl.FLOAT, false, 0, 0);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, useFull ? mesh.indexBufferFull : mesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, useFull ? mesh.indexCountFull : mesh.indexCount, gl.UNSIGNED_INT, 0);
      };

      for (const mesh of this.meshes) {
        if (!mesh.frameData) continue;
        const useFull = mesh.indexBufferFull && !koHasData;
        drawMesh(mesh, mesh.cloudBuffer, mesh.dataTex, 1, useFull);
      }

      // MapLibre가 이어서 자기 레이어를 그리므로 VAO 바인딩을 해제해 돌려준다.
      if (this.vao) gl.bindVertexArray(null);
    },
  };
  return layer;
};

// --- 태풍 진로도 커스텀 WebGL 레이어 ---
// MapLibre의 fill/line(GeoJSON) 레이어로 그리면 두 가지 문제가 있었다:
//  (1) 벡터 레이어가 추가되는 순간 커스텀 구름 레이어의 FD(전구)가 깨졌다.
//  (2) setData가 비동기라, 껐다 켤 때 소스에 남은 완성 진로도가 한 프레임 새어나왔다.
// 진로도도 커스텀 레이어로 직접 그리면 둘 다 구조적으로 사라진다. 지오메트리는
// 매 프레임 CPU에서 만들어도 정점 수백 개 수준이라 부담이 없고, 리빌 진행도를
// 렌더 시점에 직접 계산하므로 React 상태 지연으로 완성본이 새어나갈 수 없다.
const createTyphoonLayer = () => ({
  id: 'typhoon-vector',
  type: 'custom',
  renderingMode: '3d',
  typhoon: null,
  options: { prob: false, wind15: false, wind25: false },
  revealStart: 0,
  revealMs: 2000,
  reveal: 0,
  shaderMap: new Map(),

  onAdd(map, gl) {
    this.map = map;
    this.vao = gl.createVertexArray ? gl.createVertexArray() : null;
    if (this.vao) gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer();
    if (this.vao) gl.bindVertexArray(null);
  },

  // typhoon=null이면 아무것도 그리지 않는다. restart=true면 리빌을 처음부터.
  setTyphoon(typhoon, restart) {
    this.typhoon = typhoon ?? null;
    if (restart) {
      this.revealStart = performance.now();
      this.reveal = 0; // 다음 렌더 전에 읽혀도 완성본이 새어나가지 않게 즉시 0
    }
    this.map?.triggerRepaint();
  },

  setOptions(options) {
    this.options = { ...this.options, ...options };
    this.map?.triggerRepaint();
  },

  getShader(gl, shaderDescription) {
    if (this.shaderMap.has(shaderDescription.variantName)) {
      return this.shaderMap.get(shaderDescription.variantName);
    }
    const vertexSource = `#version 300 es
      ${shaderDescription.vertexShaderPrelude}
      ${shaderDescription.define}
      in vec2 aPos;
      void main() {
        gl_Position = projectTileWithElevation(aPos, 0.0);
      }`;
    const fragmentSource = `#version 300 es
      precision highp float;
      uniform vec4 uColor;
      out vec4 fragColor;
      void main() {
        // 프리멀티플라이드 알파 (blendFunc: ONE, ONE_MINUS_SRC_ALPHA)
        fragColor = vec4(uColor.rgb * uColor.a, uColor.a);
      }`;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('[typhoon] shader compile:', gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[typhoon] program link:', gl.getProgramInfoLog(program));
    }
    const shader = {
      program,
      aPos: gl.getAttribLocation(program, 'aPos'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uProjMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      uFallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      uTileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      uClippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      uTransition: gl.getUniformLocation(program, 'u_projection_transition'),
    };
    this.shaderMap.set(shaderDescription.variantName, shader);
    return shader;
  },

  render(gl, renderArgs) {
    const projectionData = renderArgs?.defaultProjectionData;
    if (!projectionData || !this.typhoon) return;

    // 리빌 진행도(렌더 시점 계산 → 상태 지연으로 완성본이 새어나갈 수 없음)
    const p = Math.min(1, (performance.now() - this.revealStart) / this.revealMs);
    const reveal = 1 - (1 - p) * (1 - p); // easeOut
    this.reveal = reveal;

    // 현재 위치를 실제 현재 시각으로 내삽한 트랙(진로선·반경 시작점이 실시간 이동)
    const typhoon = withInterpolatedCurrent(this.typhoon);
    const shown = revealTrackPoints(typhoon, reveal);
    if (shown.length === 0) return;

    const shader = this.getShader(gl, renderArgs.shaderData);
    gl.useProgram(shader.program);
    gl.uniformMatrix4fv(shader.uProjMatrix, false, projectionData.mainMatrix);
    gl.uniformMatrix4fv(shader.uFallbackMatrix, false, projectionData.fallbackMatrix);
    gl.uniform4f(shader.uTileMercatorCoords, ...projectionData.tileMercatorCoords);
    gl.uniform4f(shader.uClippingPlane, ...projectionData.clippingPlane);
    gl.uniform1f(shader.uTransition, projectionData.projectionTransition);

    if (this.vao) gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const toMerc = (coords) => {
      const arr = new Float32Array(coords.length * 2);
      for (let i = 0; i < coords.length; i += 1) {
        const m = maplibregl.MercatorCoordinate.fromLngLat({ lng: coords[i][0], lat: coords[i][1] }, 0);
        arr[i * 2] = m.x;
        arr[i * 2 + 1] = m.y;
      }
      return arr;
    };
    const draw = (coords, mode, color, alpha) => {
      if (!coords || coords.length < 2) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, toMerc(coords), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(shader.aPos);
      gl.vertexAttribPointer(shader.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(shader.uColor, color[0], color[1], color[2], alpha);
      gl.drawArrays(mode, 0, coords.length);
    };
    const drawEnvelope = (points, radii, fill, fillAlpha, line) => {
      const mesh = sweptEnvelopeMesh(points, radii);
      if (mesh) {
        draw(mesh.strip, gl.TRIANGLE_STRIP, fill, fillAlpha);
        mesh.fans.forEach((fan) => draw(fan, gl.TRIANGLE_FAN, fill, fillAlpha));
      }
      if (line) {
        const poly = sweptEnvelopePolygon(points, radii);
        if (poly) draw(poly.coordinates[0], gl.LINE_STRIP, line, 0.7);
      }
    };

    const { current, analysis } = typhoon;
    const geoPts = shown.map((pt) => ({ lat: pt.lat, lon: pt.lon }));

    // 반경 엔벨로프(선택된 것만) — 큰 것부터 아래에 깔린다
    TYPHOON_ENVELOPES.forEach((env) => {
      if (!this.options[env.key]) return;
      drawEnvelope(geoPts, shown.map((pt) => env.pick(pt, current)), env.fill, env.fillAlpha, env.line);
    });

    // 진로선 — 화면 두께가 일정하도록 줌·위도로 반경(km)을 환산해 가는 띠로 그린다.
    const zoom = this.map?.getZoom?.() ?? 4;
    const metersPerPixel =
      (156543.03392 * Math.cos((shown[0].lat * Math.PI) / 180)) / 2 ** zoom;
    const widthKm = (metersPerPixel * 1.6) / 1000;
    if (analysis && analysis.length > 1) {
      // 과거 경로(분석): 얇은 회색
      const pastPts = analysis.map((pt) => ({ lat: pt.lat, lon: pt.lon }));
      drawEnvelope(pastPts, pastPts.map(() => widthKm * 0.55), [0.886, 0.91, 0.941], 0.65, null);
    }
    if (geoPts.length > 1) {
      drawEnvelope(geoPts, geoPts.map(() => widthKm), [0.937, 0.267, 0.267], 0.95, null);
    }

    if (this.vao) gl.bindVertexArray(null);
    if (p < 1) this.map?.triggerRepaint();
  },
});

// menuSlot: 편집·녹화 모드의 공통 작업 메뉴를 우하단 설정 그룹 위에 얹는다.
function SatelliteView({
  menuSlot = null,
  workspaceMode = 'edit',
  onBeforeScreenShare,
}) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const cloudLayerRef = useRef(null);
  const playTimerRef = useRef(null);

  const [timeline, setTimeline] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // 재생이 끝까지 가 멈춘 상태(컨트롤 버튼을 '처음으로'로 바꾸는 용도).
  const [playbackFinished, setPlaybackFinished] = useState(false);
  const [status, setStatus] = useState('최신 위성 자료 탐색 중…');
  const [exaggeration, setExaggeration] = useState(6);
  const [convHighlight, setConvHighlight] = useState(true);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const [videoPlayRange, setVideoPlayRange] = useState(null);
  const [playRangeVersion, setPlayRangeVersion] = useState(0);
  const [historyEnd, setHistoryEnd] = useState(null);
  const [historyInput, setHistoryInput] = useState('');
  const [isHistoryPickerOpen, setIsHistoryPickerOpen] = useState(false);
  const [, setReadyFrameTimes] = useState(() => new Set());
  const pendingFramesRef = useRef({ ko: null, fd: null, la: null });
  const readyFrameTimesRef = useRef(new Set());
  const fullReadyFrameTimesRef = useRef(new Set());
  const pendingConvRangeRef = useRef(SEASON_CONV_KM.summer);
  const exaggerationRef = useRef(6);
  const convHighlightRef = useRef(true);

  // ── 태풍 진로도 상태 ──
  const [typhoonEnabled, setTyphoonEnabled] = useState(false);
  const [typhoons, setTyphoons] = useState([]);
  const [selectedTyphoonId, setSelectedTyphoonId] = useState(null);
  const [showProb, setShowProb] = useState(false);
  const [showWind15, setShowWind15] = useState(false);
  const [showWind25, setShowWind25] = useState(false);
  const [mapZoom, setMapZoom] = useState(4.35);
  const [mapReady, setMapReady] = useState(false);
  const mapReadyRef = useRef(false);
  const typhoonMarkersRef = useRef([]);
  const typhoonPopupRef = useRef(null);
  const typhoonLayerRef = useRef(null);
  const revealRafRef = useRef(0);
  const lastRevealIdRef = useRef(null);

  const selectedTyphoon = useMemo(
    () => typhoons.find((t) => t.id === selectedTyphoonId) ?? null,
    [typhoons, selectedTyphoonId],
  );
  const selectedTyphoonRef = useRef(null);
  selectedTyphoonRef.current = typhoonEnabled ? selectedTyphoon : null;

  const currentDate = timeline[frameIndex] ?? null;
  const convRange = useMemo(
    () => (currentDate ? seasonalConvRange(currentDate) : SEASON_CONV_KM.summer),
    [currentDate],
  );
  const bandTime = useMemo(
    () => (currentDate ? formatKstLabel(currentDate) : null),
    [currentDate],
  );

  const markFrameReady = useCallback((date) => {
    const frameTime = date.getTime();
    if (readyFrameTimesRef.current.has(frameTime)) return;
    readyFrameTimesRef.current.add(frameTime);
    setReadyFrameTimes(new Set(readyFrameTimesRef.current));
  }, []);

  const markFullFrameReady = useCallback(
    (date) => {
      fullReadyFrameTimesRef.current.add(date.getTime());
      markFrameReady(date);
    },
    [markFrameReady],
  );

  // 중심 마크 클릭 시 상세 팝업(중심기압·최대풍속·폭풍/강풍반경). 모든 모드 공통.
  const openTyphoonPopup = useCallback((map, lngLat, props) => {
    typhoonPopupRef.current?.remove();
    const fmt = (v, unit) => (Number(v) >= 0 ? `${v}${unit}` : '-');
    let timeLabel = '';
    if (props.validTime) {
      const kst = new Date(new Date(props.validTime).getTime() + 9 * 3600 * 1000);
      timeLabel = `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${kst.getUTCHours()}시`;
    }
    const scale = 0.9 + ((Math.min(9, Math.max(3, mapRef.current?.getZoom() ?? 4)) - 3) / 6) * 0.35;
    const head = props.isCurrent ? '현재' : `${timeLabel} 예상`;
    const html =
      `<div class="typhoon-popup" style="--popup-scale:${scale}">` +
      `<div class="typhoon-popup__title"><span class="typhoon-popup__dot" style="background:${GRADE_COLOR[props.grade] ?? GRADE_COLOR[0]}"></span>${head}</div>` +
      '<dl class="typhoon-popup__grid">' +
      `<div><dt>중심기압</dt><dd>${fmt(props.pressure, ' hPa')}</dd></div>` +
      `<div><dt>최대풍속</dt><dd>${fmt(props.wind, ' ㎧')}</dd></div>` +
      `<div><dt>폭풍반경</dt><dd>${fmt(props.rad25, ' km')}</dd></div>` +
      `<div><dt>강풍반경</dt><dd>${fmt(props.rad15, ' km')}</dd></div>` +
      '</dl></div>';
    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      offset: 20,
      maxWidth: 'none',
      className: 'typhoon-popup-container',
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(map);
    typhoonPopupRef.current = popup;
  }, []);

  // 지도 초기화
  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [127.8, 36.2],
      zoom: 4.35,
      pitch: 54,
      bearing: 0,
      maxPitch: 72,
      minZoom: 3.2,
      maxZoom: 9,
      preserveDrawingBuffer: true,
      attributionControl: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      window.__satMap = map;
    }
    map.on('error', (event) => {
      // 스타일·소스 로드 실패를 조용히 넘기지 않도록 로그
      console.error('[satellite] map error:', event.error?.message ?? event);
    });

    map.on('load', () => {
      const layer = createCloudLayer();
      layer.exaggeration = exaggerationRef.current;
      layer.convHighlight = convHighlightRef.current;
      cloudLayerRef.current = layer;
      map.addLayer(layer);
      map.addSource('satellite-dokdo', { type: 'geojson', data: DOKDO_GEOJSON });
      map.addLayer({
        id: 'satellite-dokdo-dot',
        type: 'circle',
        source: 'satellite-dokdo',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3.2, 1.1, 6, 1.6, 9, 2],
          'circle-color': '#f8fafc',
          'circle-stroke-color': '#263244',
          'circle-stroke-width': 0.7,
        },
      });
      // ── 태풍 진로도: 커스텀 WebGL 레이어 (중심 마크는 DOM 마커로 별도 관리) ──
      // MapLibre 벡터(fill/line) 레이어를 쓰지 않는다 — 그 레이어가 추가되면 커스텀
      // 구름 레이어의 FD가 깨졌고, setData 비동기 때문에 완성본이 새어나왔다.
      const typhoonLayer = createTyphoonLayer();
      typhoonLayerRef.current = typhoonLayer;
      map.addLayer(typhoonLayer);

      map.on('zoom', () => setMapZoom(map.getZoom()));

      // 레이어 생성 전에 도착한 프레임이 있으면 즉시 반영
      layer.setConvRange(...pendingConvRangeRef.current);
      for (const area of ['ko', 'fd']) {
        if (pendingFramesRef.current[area]) {
          layer.setFrame(area, pendingFramesRef.current[area]);
        }
      }
      mapReadyRef.current = true;
      setMapReady(true);
      setMapZoom(map.getZoom());
    });

    return () => {
      map.remove();
      mapRef.current = null;
      cloudLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    exaggerationRef.current = exaggeration;
    if (cloudLayerRef.current) {
      cloudLayerRef.current.exaggeration = exaggeration;
      mapRef.current?.triggerRepaint();
    }
  }, [exaggeration]);

  useEffect(() => {
    convHighlightRef.current = convHighlight;
    if (cloudLayerRef.current) {
      cloudLayerRef.current.convHighlight = convHighlight;
      mapRef.current?.triggerRepaint();
    }
  }, [convHighlight]);

  const frameIndexRef = useRef(0);
  const timelineRef = useRef([]);
  useEffect(() => {
    frameIndexRef.current = frameIndex;
  }, [frameIndex]);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  // ── 태풍: 활동 태풍 로드(켜졌을 때 + 10분마다) ──
  useEffect(() => {
    if (!typhoonEnabled) return undefined;
    let active = true;
    const load = async () => {
      try {
        const list = await fetchActiveTyphoons();
        if (!active) return;
        setTyphoons(list);
        setSelectedTyphoonId((prev) =>
          prev && list.some((t) => t.id === prev) ? prev : list[0]?.id ?? null,
        );
      } catch {
        // 일시 실패는 조용히 넘기고 다음 주기에 재시도
      }
    };
    load();
    const timer = setInterval(load, TYPHOON_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [typhoonEnabled]);

  // ── 태풍: 반경 옵션(확률·강풍·폭풍)을 커스텀 레이어에 전달 ──
  useEffect(() => {
    const layer = typhoonLayerRef.current;
    if (!layer || !mapReadyRef.current) return;
    layer.setOptions({ prob: showProb, wind15: showWind15, wind25: showWind25 });
  }, [showProb, showWind15, showWind25, mapReady]);

  // ── 태풍: 레이어 데이터 + 중심 마커 + 리빌을 '하나의 시계(layer.reveal)'로 통일 ──
  // 진로·반경(커스텀 레이어)과 마커(DOM)를 같은 layer.reveal로 움직인다. 예전엔 둘이
  // 서로 다른 리빌 시계로 돌아 실행 순서에 따라 무작위로 엇갈렸다(마커만 먼저 뜨거나,
  // 완성본이 중간에 번쩍). 이제 한 효과에서 레이어 세팅→마커 생성→마커 불투명도
  // 갱신을 모두 layer.reveal 기준으로 처리한다.
  useEffect(() => {
    const map = mapRef.current;
    const layer = typhoonLayerRef.current;
    if (!map || !layer || !mapReadyRef.current) return undefined;
    cancelAnimationFrame(revealRafRef.current);
    typhoonMarkersRef.current.forEach((m) => m.remove());
    typhoonMarkersRef.current = [];
    typhoonPopupRef.current?.remove();
    typhoonPopupRef.current = null;

    const typhoon = typhoonEnabled ? selectedTyphoon : null;
    const id = typhoon ? selectedTyphoonId : null;
    // 새 태풍이거나 방금 켰으면 리빌 처음부터, 같은 태풍의 자료 갱신이면 유지.
    const restart = id !== lastRevealIdRef.current;
    lastRevealIdRef.current = id;
    layer.setTyphoon(typhoon, restart);

    if (!typhoon) return undefined;

    const scale = typhoonMarkScale(map.getZoom());
    let currentMarker = null;
    buildTyphoonCenters(withInterpolatedCurrent(typhoon)).features.forEach((f) => {
      const props = f.properties;
      const el = buildTyphoonMarkerEl(props, scale);
      el.dataset.frac = String(props.frac ?? 0);
      el.style.opacity = (props.frac ?? 0) <= (layer.reveal ?? 0) + 0.001 ? '1' : '0';
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        openTyphoonPopup(map, f.geometry.coordinates, props);
      });
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(f.geometry.coordinates)
        .addTo(map);
      if (props.isCurrent) currentMarker = marker;
      typhoonMarkersRef.current.push(marker);
    });

    // 진로·반경과 동일한 layer.reveal을 따라 마커 불투명도를 갱신한다.
    const tick = () => {
      const reveal = layer.reveal ?? 0;
      typhoonMarkersRef.current.forEach((m) => {
        const el = m.getElement();
        el.style.opacity = Number(el.dataset.frac ?? 0) <= reveal + 0.001 ? '1' : '0';
      });
      if (reveal < 1) revealRafRef.current = requestAnimationFrame(tick);
    };
    revealRafRef.current = requestAnimationFrame(tick);

    // 현재 위치는 실제 시각으로 계속 이동한다. 1분마다 현재 마커 위치를 다시 내삽하고
    // 레이어(진로선·반경 시작점)도 리페인트해 실시간으로 따라가게 한다.
    const posTimer = setInterval(() => {
      const c = interpolatedCurrent(typhoon);
      if (currentMarker && c) currentMarker.setLngLat([c.lon, c.lat]);
      layer.map?.triggerRepaint();
    }, 60000);

    return () => {
      cancelAnimationFrame(revealRafRef.current);
      clearInterval(posTimer);
      typhoonMarkersRef.current.forEach((m) => m.remove());
      typhoonMarkersRef.current = [];
      typhoonPopupRef.current?.remove();
      typhoonPopupRef.current = null;
    };
  }, [typhoonEnabled, selectedTyphoon, selectedTyphoonId, openTyphoonPopup, mapReady]);

  // ── 태풍: 줌에 따라 마크·팝업 크기 조절 ──
  useEffect(() => {
    const scale = typhoonMarkScale(mapZoom);
    typhoonMarkersRef.current.forEach((m) => {
      m.getElement().style.setProperty('--mark-scale', String(scale));
    });
    if (typhoonPopupRef.current) {
      const el = typhoonPopupRef.current.getElement();
      const box = el?.querySelector('.typhoon-popup');
      if (box) box.style.setProperty('--popup-scale', String(0.9 + (Math.min(9, Math.max(3, mapZoom)) - 3) / 6 * 0.35));
    }
  }, [mapZoom]);

  // 최신 시각 탐색 → 12시간 타임라인 구성 (5분마다 갱신)
  useEffect(() => {
    let active = true;

    const refresh = async (initial = false) => {
      try {
        const latest = await probeLatestSatDate(historyEnd);
        if (!active) return;
        const previous = timelineRef.current;
        const next = buildSatTimeline(latest, TIMELINE_HOURS, STEP_MINUTES);
        const timelineUnchanged =
          previous.length === next.length &&
          previous.every((date, index) => date.getTime() === next[index]?.getTime());
        if (!initial && timelineUnchanged) return;
        const wasAtEnd =
          initial || previous.length === 0 || frameIndexRef.current >= previous.length - 1;
        let nextIndex = next.length - 1;
        if (!wasAtEnd) {
          // 사용자가 과거를 보고 있으면 같은 시각을 유지
          const held = previous[frameIndexRef.current]?.getTime();
          const heldIndex = next.findIndex((d) => d.getTime() === held);
          if (heldIndex >= 0) nextIndex = heldIndex;
        }
        const nextFrameTimes = new Set(next.map((date) => date.getTime()));
        readyFrameTimesRef.current = new Set(
          [...readyFrameTimesRef.current].filter((time) => nextFrameTimes.has(time)),
        );
        fullReadyFrameTimesRef.current = new Set(
          [...fullReadyFrameTimesRef.current].filter((time) => nextFrameTimes.has(time)),
        );
        setReadyFrameTimes(new Set(readyFrameTimesRef.current));
        setTimeline(next);
        setFrameIndex(nextIndex);
      } catch (error) {
        if (active && initial) setStatus(error.message);
      }
    };

    refresh(true);
    const timer = historyEnd ? null : setInterval(refresh, AUTO_REFRESH_MS);
    return () => {
      active = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [historyEnd]);

  // 현재 프레임 로드 → 3D 레이어 반영
  useEffect(() => {
    if (!currentDate) return;
    let active = true;
    // 실패 시 오류 표시 여부 판단용: 이미 전체 프레임이 하나라도 그려진 적 있으면
    // 실패해도 조용히 직전 프레임을 유지한다(방송 중 오류 오버레이 방지).
    const hadFrameBefore = fullReadyFrameTimesRef.current.size > 0;

    (async () => {
      let pair;
      try {
        // 선택한 한 장은 30분 묶음 전체를 기다리지 않고 먼저 표시한다.
        pair = await fetchSatFramePair(currentDate, true, 'interactive');
      } catch (error) {
        if (!active) return;
        // 전체 프레임(FD/KO)이 실패해도 화면을 지우거나 오류를 띄우지 않고 직전 전체
        // 프레임을 그대로 둔다. 이미 뭔가 그려져 있으면 조용히 유지한다. (예전엔 빠른
        // 첫화면용 LA 보조 레이어를 따로 얹었는데, FD/KO가 실패한 시각엔 그 영역만
        // 새 자료로 남아 이전 프레임 위에서 그 부분만 튀어 보였다 — 방송용으로
        // 부적합해 LA 표시를 제거했다.)
        if (!hadFrameBefore) setStatus(error.message);
        return;
      }
      if (!active) return;
      markFullFrameReady(currentDate);
      const range = seasonalConvRange(currentDate);
      pendingConvRangeRef.current = range;
      cloudLayerRef.current?.setConvRange(...range);
      for (const area of ['ko', 'fd']) {
        const data = pair[area].data;
        pendingFramesRef.current[area] = data;
        cloudLayerRef.current?.setFrame(area, data);
      }
      setStatus(null);
    })();

    // 인접 프레임 프리페치 (재생·스크럽 반응성)
    const nextDate = timeline[frameIndex + 1];
    if (nextDate) {
      fetchSatFramePair(nextDate, true).catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [currentDate, frameIndex, markFrameReady, markFullFrameReady, timeline]);

  // 가벼운 LA 프레임은 전 구간을 먼저 채운다. 실패 시 다른 시각을 계속 받은 뒤
  // 지수 백오프로 재시도해 일시 오류 하나가 전체 준비를 막지 않게 한다.
  useEffect(() => {
    if (timeline.length === 0) return undefined;
    let active = true;
    const inFlight = new Set();
    const attempts = new Map();
    const retryAt = new Map();

    const nearestPendingIndex = () => {
      const center = Math.min(Math.max(frameIndexRef.current, 0), timeline.length - 1);
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < timeline.length; i++) {
        const frameTime = timeline[i].getTime();
        if (
          readyFrameTimesRef.current.has(frameTime) ||
          inFlight.has(i) ||
          (retryAt.get(i) ?? 0) > Date.now()
        ) {
          continue;
        }
        const dist = Math.abs(i - center);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    };

    const worker = async () => {
      while (active) {
        const index = nearestPendingIndex();
        if (index < 0) {
          if (timeline.every((date) => readyFrameTimesRef.current.has(date.getTime()))) return;
          await waitFor(500);
          continue;
        }
        inFlight.add(index);
        try {
          await fetchSatFrame(timeline[index], 'la');
          if (active) markFrameReady(timeline[index]);
          attempts.delete(index);
          retryAt.delete(index);
        } catch {
          const attempt = (attempts.get(index) ?? 0) + 1;
          attempts.set(index, attempt);
          retryAt.set(index, Date.now() + prefetchRetryDelay(attempt));
        } finally {
          inFlight.delete(index);
        }
      }
    };

    Array.from({ length: LA_PREFETCH_WORKERS }, () => worker());

    return () => {
      active = false;
    };
  }, [markFrameReady, timeline]);

  // FD/KO 고해상도 쌍도 가까운 시각부터 전 구간을 한 장씩 보강한다. 직렬 요청으로
  // 서버 메모리 부담을 제한하고, 실패 프레임은 뒤로 돌려 계속 재시도한다.
  useEffect(() => {
    if (timeline.length === 0) return undefined;
    let active = true;
    const attempts = new Map();
    const retryAt = new Map();

    const nearestPendingIndex = () => {
      const center = Math.min(Math.max(frameIndexRef.current, 0), timeline.length - 1);
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < timeline.length; i++) {
        if (
          fullReadyFrameTimesRef.current.has(timeline[i].getTime()) ||
          (retryAt.get(i) ?? 0) > Date.now()
        ) {
          continue;
        }
        const dist = Math.abs(i - center);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    };

    const run = async () => {
      while (active) {
        const index = nearestPendingIndex();
        if (index < 0) {
          if (timeline.every((date) => fullReadyFrameTimesRef.current.has(date.getTime()))) return;
          await waitFor(750);
          continue;
        }
        try {
          await fetchSatFramePair(timeline[index], true, 'background');
          if (active) markFullFrameReady(timeline[index]);
          attempts.delete(index);
          retryAt.delete(index);
          await waitFor(180);
        } catch {
          const attempt = (attempts.get(index) ?? 0) + 1;
          attempts.set(index, attempt);
          retryAt.set(index, Date.now() + prefetchRetryDelay(attempt));
        }
      }
    };

    run();
    return () => {
      active = false;
    };
  }, [markFullFrameReady, timeline]);

  // 재생은 '전 구간 로딩 완료'를 기다리지 않는다. 방송 중 한 프레임(예: 원본이 빠진
  // 시각)이 안 채워졌다고 재생 버튼이 죽거나 '위성 재생 준비 중 N/M'이 뜨면 안 되기
  // 때문이다. 아직 안 온 프레임은 직전 프레임을 유지하고, 재생하며 그 자리에서 채워진다.
  const displayStatus = status ?? null;

  // 태풍 진로도 ON + 태풍 선택 시 좌상단 밴드를 태풍 이름/발표시각으로 교체.
  // 밴드를 레이더 등과 같은 폭으로 유지하려고 '제'는 빼고 'N호 태풍 이름'으로 쓴다.
  // 이름이 3글자 이상이면 더 좁게 '태풍 이름'만 표시한다.
  const typhoonActive = typhoonEnabled && !!selectedTyphoon;
  const typhoonBandTitle = selectedTyphoon
    ? selectedTyphoon.name && selectedTyphoon.name.length >= 3
      ? `태풍 ‘${selectedTyphoon.name}’`
      : `${selectedTyphoon.number}호 태풍${selectedTyphoon.name ? ` ‘${selectedTyphoon.name}’` : ''}`
    : null;
  const typhoonBandTime = selectedTyphoon ? formatAnnounceLabel(selectedTyphoon.announceTime) : null;

  // 준비된 전 구간만 선택한 재생 길이에 맞춰 진행하고 마지막에서 멈춘다.
  useEffect(() => {
    if (!isPlaying || timeline.length === 0) return undefined;
    const start = videoPlayRange?.startIndex ?? 0;
    const last = videoPlayRange?.endIndex ?? timeline.length - 1;
    const transitionCount = Math.max(1, last - start);
    const intervalMs = Math.max(45, Math.round((playDurationSec * 1000) / transitionCount));
    playTimerRef.current = setInterval(() => {
      const next = Math.min(frameIndexRef.current + 1, last);
      setFrameIndex(next);
      if (next >= last) {
        setIsPlaying(false);
        setPlaybackFinished(true); // 끝까지 재생됨 → 버튼을 '처음으로'로
      }
    }, intervalMs);
    return () => clearInterval(playTimerRef.current);
  }, [isPlaying, timeline.length, playDurationSec, videoPlayRange]);

  // 편집모드에서 지정한 재생 구간(시작/끝 프레임). 타임스탬프 키로 저장.
  const persistentPlayRange = useMemo(
    () => resolvePlayRange(PLAY_RANGE_VIEW_ID, timeline, (date) => date.getTime()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, playRangeVersion],
  );

  const markPlayBound = useCallback(
    (which) => {
      const frame = timeline[frameIndex];
      if (!frame) return;
      const existing = readPlayRange(PLAY_RANGE_VIEW_ID);
      const firstKey = timeline[0]?.getTime();
      const lastKey = timeline.at(-1)?.getTime();
      const key = frame.getTime();
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
      writePlayRange(PLAY_RANGE_VIEW_ID, next);
      setPlayRangeVersion((value) => value + 1);
    },
    [timeline, frameIndex],
  );

  const handleClearPlayRange = useCallback(() => {
    clearPlayRange(PLAY_RANGE_VIEW_ID);
    setPlayRangeVersion((value) => value + 1);
  }, []);

  // 컨트롤 버튼 3-상태: 재생 중이면 일시정지, 끝까지 재생돼 멈췄으면 '처음으로'(첫
  // 장면에서 정지), 그 외에는 재생. 방송에서 첫 장면으로 멈춰두는 용도.
  const handlePlayToggle = useCallback(() => {
    if (isPlaying) {
      mapRef.current?.stop(); // 카메라 이동도 함께 멈춘다
      setIsPlaying(false);
      return;
    }
    if (timeline.length === 0) return;
    const startIdx = persistentPlayRange ? persistentPlayRange.startIndex : 0;

    // 끝까지 재생돼 멈춘 상태 → 재생 대신 첫 장면으로 이동해 정지한다.
    if (playbackFinished) {
      mapRef.current?.stop();
      const startCamera = persistentPlayRange?.startCamera;
      if (startCamera) {
        mapRef.current?.jumpTo({
          center: startCamera.center,
          zoom: startCamera.zoom,
          pitch: startCamera.pitch,
          bearing: startCamera.bearing,
        });
      }
      setFrameIndex(startIdx);
      setPlaybackFinished(false);
      setIsPlaying(false);
      return;
    }

    // 재생 시작
    setPlaybackFinished(false);
    if (persistentPlayRange) {
      setVideoPlayRange(persistentPlayRange);
      setFrameIndex(persistentPlayRange.startIndex);
      const transitionCount = Math.max(
        1,
        persistentPlayRange.endIndex - persistentPlayRange.startIndex,
      );
      const durationMs = Math.max(45, Math.round((playDurationSec * 1000) / transitionCount)) * transitionCount;
      applyPlayCamera(mapRef.current, persistentPlayRange, durationMs);
      window.requestAnimationFrame(() => setIsPlaying(true));
      return;
    }
    setVideoPlayRange({ startIndex: frameIndex, endIndex: timeline.length - 1 });
    setIsPlaying(true);
  }, [frameIndex, isPlaying, timeline.length, persistentPlayRange, playDurationSec, playbackFinished]);

  // '처음으로' 상태: 재생이 끝까지 가 멈춘 경우에만(초기 로드로 마지막 프레임에 있는
  // 것과 구분하기 위해 별도 플래그를 쓴다).
  const isAtPlaybackEnd = playbackFinished && !isPlaying;

  const videoDefaultStart = timeline[0] ? formatLocalDateTimeInput(timeline[0]) : '';
  const videoDefaultEnd = timeline.at(-1) ? formatLocalDateTimeInput(timeline.at(-1)) : '';
  const handleVideoPrepare = useCallback(
    async ({ start, end }) => {
      const range = findTimelineRange(timeline, start, end);
      if (!range) {
        throw new Error('선택한 기간에 재생할 위성 프레임이 2개 이상 필요합니다.');
      }
      setIsPlaying(false);
      setPlaybackFinished(false);
      // 녹화 첫 컷이 직전 화면이 아니라 시작 프레임이 되도록 미리 이동해 둔다.
      setFrameIndex(range.startIndex);
    },
    [timeline],
  );
  const handleVideoStart = useCallback(
    ({ start, end, durationSec }) => {
      const range = findTimelineRange(timeline, start, end);
      if (!range) return;
      setPlayDurationSec(durationSec);
      setVideoPlayRange(range);
      setFrameIndex(range.startIndex);
      window.requestAnimationFrame(() => setIsPlaying(true));
    },
    [timeline],
  );
  const handleBeforeSatelliteScreenShare = useCallback(async () => {
    await onBeforeScreenShare?.();
    mapRef.current?.resize();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }, [onBeforeScreenShare]);

  const handleSlider = useCallback((event) => {
    setIsPlaying(false);
    setPlaybackFinished(false); // 수동 스크럽하면 '처음으로' 상태 해제
    setFrameIndex(Number(event.target.value));
  }, []);

  const prepareHistoryInput = useCallback(() => {
    const seed = historyEnd ?? currentDate ?? new Date();
    setHistoryInput(formatLocalDateTimeInput(floorToTenMinutesLocal(seed)));
    setIsHistoryPickerOpen(true);
  }, [currentDate, historyEnd]);

  const handleApplyHistory = useCallback(() => {
    const parsed = new Date(historyInput);
    if (Number.isNaN(parsed.getTime())) return;

    const earliest = new Date(SATELLITE_ARCHIVE_MIN_INPUT);
    const latest = floorToTenMinutesLocal(new Date());
    const clamped = new Date(
      Math.min(latest.getTime(), Math.max(earliest.getTime(), parsed.getTime())),
    );
    setIsPlaying(false);
    setStatus('선택한 과거 위성 자료를 찾는 중입니다.');
    setHistoryEnd(floorToTenMinutesLocal(clamped));
    setIsHistoryPickerOpen(false);
  }, [historyInput]);

  const handleReturnToLatest = useCallback(() => {
    setIsPlaying(false);
    setStatus('최신 위성 자료를 찾는 중입니다.');
    setHistoryEnd(null);
    setIsHistoryPickerOpen(false);
  }, []);

  // 눈금: 매시 정각 위치 + 2시간마다 라벨
  const ticks = useMemo(() => {
    if (timeline.length < 2) return [];
    const first = timeline[0].getTime();
    const span = timeline[timeline.length - 1].getTime() - first;
    return timeline
      .map((date, index) => ({ date, index }))
      .filter(({ date }) => date.getUTCMinutes() === 0)
      .map(({ date, index }) => ({
        left: `${((date.getTime() - first) / span) * 100}%`,
        label: (date.getTime() + KST_OFFSET_MS) % (2 * 60 * 60 * 1000) === 0
          ? formatTickLabel(date)
          : null,
        key: index,
      }));
  }, [timeline]);

  const maxIndex = Math.max(0, timeline.length - 1);
  const progressPercent = maxIndex > 0 ? (frameIndex / maxIndex) * 100 : 0;
  const thumbPercent = Math.min(Math.max(progressPercent, 6), 94);

  return (
    <div className="sat-view">
      <div ref={mapContainerRef} className="sat-map" />
      {workspaceMode === 'record' ? (
        <VideoExportMenu
          currentTarget="satellite"
          mapRef={mapRef}
          defaultStart={videoDefaultStart}
          defaultEnd={videoDefaultEnd}
          onBeforeScreenShare={handleBeforeSatelliteScreenShare}
          onPreparePlayback={handleVideoPrepare}
          onStartPlayback={handleVideoStart}
        />
      ) : null}

      {/* 좌상단: 타이틀 밴드 — 레이더 방송모드와 동일 형태·위치 */}
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
          {/* 타이틀·시각은 현재 상태의 내용만 조건부로 렌더한다(디졸브로 두 내용을
              겹치면 전환 중 잘못된 시각이 번쩍이고, 폭이 남아 시간이 밴드 밖으로
              밀리는 문제가 있어 즉시 전환으로 되돌림). */}
          <span
            className="whitespace-nowrap font-black tracking-tight text-white"
            style={{ fontSize: 'clamp(26px, 2.1vw, 46px)', textShadow: '0 2px 6px rgba(0,0,0,0.35)' }}
          >
            {typhoonActive ? typhoonBandTitle : '위성 영상'}
          </span>
          {typhoonActive ? (
            <div className="ml-auto flex shrink-0 items-center whitespace-nowrap" style={{ gap: '0.5vw', marginRight: '0.4vw' }}>
              <span className="h-[62%] w-px bg-white/30" style={{ marginRight: '0.4vw' }} />
              <span
                className="flex flex-col items-center leading-tight text-[#dbe8fb]"
                style={{ fontSize: 'clamp(12px, 0.82vw, 17px)' }}
              >
                <span className="font-bold">{typhoonBandTime?.day}</span>
                <span className="font-bold">{typhoonBandTime?.time}</span>
              </span>
            </div>
          ) : bandTime ? (
            <div className="ml-auto flex shrink-0 items-center whitespace-nowrap" style={{ gap: '0.6vw' }}>
              <span className="h-[52%] w-px bg-white/30" style={{ marginRight: '0.5vw' }} />
              <span
                className="font-black leading-none tabular-nums text-white"
                style={{ fontSize: 'clamp(22px, 1.7vw, 38px)', textShadow: '0 2px 5px rgba(0,0,0,0.3)' }}
              >
                {bandTime.clock}
              </span>
              <span className="font-semibold text-[#bdd6fb]" style={{ fontSize: 'clamp(13px, 0.95vw, 20px)' }}>
                {bandTime.date}
              </span>
            </div>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-[#3d86e8] to-[#8ec2ff]" />
        </div>
      </div>

      {displayStatus ? <div data-video-hide className="sat-status">{displayStatus}</div> : null}

      {/* 하단 반투명 컨트롤바 — 레이더 방송모드와 동일 형태·위치 */}
      <div data-video-hide className="absolute bottom-0 left-1/2 right-0 z-10 bg-gradient-to-t from-slate-900/65 via-slate-900/35 to-transparent pb-4 pl-0 pr-6 pt-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePlayToggle}
            disabled={timeline.length === 0}
            className="flex h-12 w-12 shrink-0 -translate-x-1/2 items-center justify-center rounded-full bg-[#0033a0] text-white shadow-sm transition hover:bg-blue-800 disabled:cursor-wait disabled:opacity-55"
            aria-label={isPlaying ? '일시정지' : isAtPlaybackEnd ? '처음으로' : '재생'}
            title={isPlaying ? '일시정지' : isAtPlaybackEnd ? '처음으로' : '재생'}
          >
            {isPlaying ? (
              <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden="true">
                <rect x="3" y="2" width="3.5" height="12" rx="1" />
                <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
              </svg>
            ) : isAtPlaybackEnd ? (
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
            {bandTime ? (
              <div
                className="pointer-events-none absolute top-0"
                style={{ left: `${thumbPercent}%` }}
              >
                <span className="inline-block -translate-x-1/2 whitespace-nowrap rounded-full bg-slate-600 px-2.5 py-1 text-[11px] font-bold tabular-nums text-white shadow-sm">
                  {bandTime.clock}
                </span>
              </div>
            ) : null}
            <input
              type="range"
              min={0}
              max={maxIndex}
              value={frameIndex}
              onChange={handleSlider}
              className="broadcast-radar-range relative z-10 h-2.5 w-full cursor-pointer appearance-none rounded-full accent-[#0033a0]"
              style={{
                background: `linear-gradient(to right, #64748b ${progressPercent}%, #2563eb ${progressPercent}%)`,
              }}
            />
            {persistentPlayRange && maxIndex > 0 ? (
              <>
                <span
                  className="pointer-events-none absolute top-[calc(2rem+0.3125rem)] z-20 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-300 shadow"
                  style={{ left: `${(persistentPlayRange.startIndex / maxIndex) * 100}%` }}
                  title="시작 화면"
                />
                <span
                  className="pointer-events-none absolute top-[calc(2rem+0.3125rem)] z-20 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-300 shadow"
                  style={{ left: `${(persistentPlayRange.endIndex / maxIndex) * 100}%` }}
                  title="끝 화면"
                />
              </>
            ) : null}
            {workspaceMode !== 'broadcast' ? (
              <div className="mt-2 flex items-center justify-end gap-2">
                <span className="mr-auto text-xs font-bold text-white/70">
                  {persistentPlayRange ? '재생 구간 지정됨' : '재생 구간 미지정 (전체 재생)'}
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
                {persistentPlayRange ? (
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
            <div className="relative mt-1 h-9">
              {ticks.map((tick) => (
                <div
                  key={tick.key}
                  className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
                  style={{ left: tick.left }}
                >
                  <div className={`w-px ${tick.label ? 'h-2 bg-white/60' : 'h-1.5 bg-white/35'}`} />
                  {tick.label ? (
                    <div className="mt-0.5 whitespace-nowrap text-center text-[10px] font-medium tabular-nums text-white/75">
                      {tick.label}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 태풍 진로도 컨트롤 — 메인 토글은 모든 모드, 세부(태풍 선택·반경)는 편집모드만 */}
      <div data-video-hide className="absolute right-6 top-[13%] z-20 flex flex-col items-end gap-2">
        <label className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-slate-900/65 px-3.5 text-sm font-black text-white shadow-lg backdrop-blur-sm">
          <input
            type="checkbox"
            checked={typhoonEnabled}
            onChange={(event) => setTyphoonEnabled(event.target.checked)}
            className="h-4 w-4 accent-[#f4c542]"
          />
          태풍 진로도
        </label>
        {typhoonEnabled && workspaceMode === 'edit' ? (
          <div className="flex w-52 flex-col gap-2 rounded-2xl border border-white/20 bg-slate-900/70 p-3 shadow-xl backdrop-blur-sm">
            {typhoons.length > 0 ? (
              <select
                value={selectedTyphoonId ?? ''}
                onChange={(event) => setSelectedTyphoonId(event.target.value)}
                className="h-9 w-full cursor-pointer rounded-lg border border-white/25 bg-slate-900/80 px-2 text-sm font-semibold text-white outline-none"
                aria-label="표출 태풍 선택"
              >
                {typhoons.map((t) => (
                  <option key={t.id} value={t.id} className="text-slate-900">
                    {`제${t.number}호${t.name ? ` ${t.name}` : ''}`}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs font-semibold text-white/60">활동 중인 태풍 없음</span>
            )}
            <div className="flex flex-col gap-1.5 border-t border-white/15 pt-2">
              {[
                { label: '확률 반경', value: showProb, setter: setShowProb, color: '#e2e8f0' },
                { label: '강풍 반경', value: showWind15, setter: setShowWind15, color: '#facc15' },
                { label: '폭풍 반경', value: showWind25, setter: setShowWind25, color: '#ef4444' },
              ].map((opt) => (
                <label key={opt.label} className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-white">
                  <input
                    type="checkbox"
                    checked={opt.value}
                    onChange={(event) => opt.setter(event.target.checked)}
                    className="h-4 w-4"
                    style={{ accentColor: opt.color }}
                  />
                  <span className="inline-block h-3 w-3 rounded-full" style={{ background: opt.color, opacity: 0.85 }} />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* 우하단: (방송모드) 뷰 전환 + 표시 옵션 + 재생 길이 — 레이더와 동일 위치 */}
      {workspaceMode !== 'broadcast' ? (
      <div data-video-hide className="absolute bottom-[8.5rem] right-6 z-20 flex flex-col items-end gap-2.5">
        {menuSlot}
        <div className="flex items-center gap-2">
          {isHistoryPickerOpen ? (
            <div className="flex h-10 items-center gap-1.5 rounded-full border border-white/25 bg-slate-900/65 px-2 text-white shadow-lg backdrop-blur-sm">
              <CalendarClock size={16} className="shrink-0" />
              <HistoricalDateTimeInput
                value={historyInput}
                min={SATELLITE_ARCHIVE_MIN_INPUT}
                max={formatLocalDateTimeInput(floorToTenMinutesLocal(new Date()))}
                onChange={setHistoryInput}
                dark
                ariaLabel="위성 과거 조회 시각"
              />
              <button
                type="button"
                onClick={handleApplyHistory}
                disabled={!historyInput}
                className="h-7 rounded-full bg-cyan-400 px-2.5 text-xs font-black text-slate-950 transition hover:bg-cyan-300 disabled:opacity-50"
              >
                이동
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={prepareHistoryInput}
              className="flex h-10 items-center gap-2 rounded-full border border-white/25 bg-slate-900/65 px-3 text-sm font-semibold text-white shadow-lg backdrop-blur-sm transition hover:bg-white/10"
            >
              <CalendarClock size={16} />
              과거 조회
            </button>
          )}
          {historyEnd ? (
            <button
              type="button"
              onClick={handleReturnToLatest}
              className="h-10 rounded-full border border-white/25 bg-slate-900/65 px-3 text-sm font-black text-white shadow-lg backdrop-blur-sm transition hover:bg-white/10"
            >
              최신
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex h-10 items-center gap-2 rounded-full border border-white/25 bg-slate-900/55 px-3.5 text-sm font-semibold text-white backdrop-blur-sm">
            입체 효과
            <input
              type="range"
              min={1}
              max={20}
              value={exaggeration}
              onChange={(event) => setExaggeration(Number(event.target.value))}
              className="w-24 accent-[#f4c542]"
            />
            <span className="w-8 text-right tabular-nums">×{exaggeration}</span>
          </label>
          <label className="flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-slate-900/55 px-3.5 text-sm font-semibold text-white backdrop-blur-sm">
            <input
              type="checkbox"
              checked={convHighlight}
              onChange={(event) => setConvHighlight(event.target.checked)}
              className="h-4 w-4 accent-[#f4c542]"
            />
            대류운 강조
          </label>
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
        </div>
      </div>
      ) : null}

      {/* 대류운 고도 스케일바 — 녹화모드에서는 화면에 남기지 않는다. */}
      {convHighlight && workspaceMode !== 'record' ? (
        <div className="sat-conv-legend">
          <span className="sat-conv-legend-title">강한 대류운 (운정고도)</span>
          <span className="sat-conv-legend-bar" />
          <span className="sat-conv-legend-labels">
            <span>{convRange[0]}km</span>
            <span>{convRange[1]}km</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

export default SatelliteView;
