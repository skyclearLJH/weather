// 방송모드 위성 영상 뷰 (작업 중 — main.jsx의 ?satellite=1 게이트로만 진입).
//
// 천리안2A(GK2A) IR105 관측을 구면 지도 위에 그리고, 휘도온도에서 유도한
// 의사 운정고도로 구름을 3D 돌출(과장)시켜 표현한다. 데이터는 NOAA 공개
// 버킷의 FD 원본 하나에서 두 해상도로 뽑는다: 전구 22km(FD) 배경 + 한반도
// 주변 6km(KO) 정밀. 과거 12시간을 10분 간격으로 조회할 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  DN_TO_BT_KELVIN,
  FD_GRID,
  KO_GRID,
  buildSatTimeline,
  fdCellToLonLat,
  fetchSatFrame,
  koCellToLonLat,
  probeLatestSatDate,
} from '../api/satApi';
import './SatelliteView.css';

const TIMELINE_HOURS = 12;
const STEP_MINUTES = 10;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const BROADCAST_PLAY_DURATIONS = Array.from({ length: 11 }, (_, index) => index + 5); // 5~15초

// 휘도온도(°C) → 표시 강도/의사 운정고도
const BT_CLEAR_C = 15; // 이보다 따뜻하면 구름 없음 취급
const BT_TOP_C = -75; // 이보다 차가우면 최대 강도
const LAPSE_C_PER_KM = 6.5;
const MAX_CLOUD_KM = 16;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
    // 해안선 = 같은 육지 폴리곤의 외곽선 (별도 해안선 파일과 어긋날 일이 없다)
    {
      id: 'coastline',
      type: 'line',
      source: 'land',
      paint: { 'line-color': '#7f9bb8', 'line-width': 1.3 },
    },
    {
      id: 'sido',
      type: 'line',
      source: 'sido',
      paint: { 'line-color': '#647d97', 'line-width': 1.0 },
    },
  ],
};

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
        uniform float uExag;
        out float vT;
        out float vShade;
        out float vConv;
        void main() {
          vT = aCloud.x;
          vShade = aCloud.z;
          vConv = aCloud.w;
          #ifdef GLOBE
            float elevation = aCloud.y * uExag;
          #else
            float elevation = aCloud.y * aZScale * uExag;
          #endif
          // projectTileWithElevation은 지구 뒷면 클리핑용 z를 쓴다 — 뒷면 구름 숨김
          gl_Position = projectTileWithElevation(aPos, elevation);
        }`;
      const fragmentSource = `#version 300 es
        precision mediump float;
        in float vT;
        in float vShade;
        in float vConv;
        uniform float uConvOn;
        out vec4 fragColor;
        void main() {
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
          fragColor = vec4(color * shade * alpha, alpha);
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
        uExag: gl.getUniformLocation(program, 'uExag'),
        uConvOn: gl.getUniformLocation(program, 'uConvOn'),
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
      const makeBuffer = (target, data, usage) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, data, usage);
        return buffer;
      };
      // 정점 위치(메르카토르)/고도 스케일/인덱스는 고정 — 메쉬별로 한 번만 계산.
      // vertexAt(mi,mj)이 [lon,lat] 또는 null(무효 정점)을 반환하고,
      // quadVisible로 EA 도메인과 겹치는 FD 삼각형을 걸러낸다.
      const buildMesh = (w, h, vertexAt, quadVisible, sample) => {
        const positions = new Float32Array(w * h * 2);
        const zScales = new Float32Array(w * h);
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
          frameData: null,
          dirty: false,
          cloudArray: new Float32Array(w * h * 4),
          heightScratch: new Float32Array(w * h),
          posBuffer: makeBuffer(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW),
          zScaleBuffer: makeBuffer(gl.ARRAY_BUFFER, zScales, gl.STATIC_DRAW),
          cloudBuffer: makeBuffer(gl.ARRAY_BUFFER, new Float32Array(w * h * 4), gl.DYNAMIC_DRAW),
          indexBuffer: makeBuffer(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW),
          indexCount: indexArray.length,
          buildIndices,
          makeBuffer,
        };
      };

      // KO: 한반도 주변 정밀 크롭 (FD와 같은 GEOS 격자, 6km)
      const koMesh = buildMesh(
        KO_GRID.width,
        KO_GRID.height,
        (mi, mj) => koCellToLonLat(mi, mj),
        null,
        (frameData, mi, mj) => frameData[mj * KO_GRID.width + mi],
      );

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
      );

      // KO 프레임이 없을 때는 FD가 크롭 영역까지 채우도록 전체 인덱스 버퍼를 따로 둔다.
      const fdFullIndices = fdMesh.buildIndices(null);
      fdMesh.indexBufferFull = fdMesh.makeBuffer(gl.ELEMENT_ARRAY_BUFFER, fdFullIndices, gl.STATIC_DRAW);
      fdMesh.indexCountFull = fdFullIndices.length;

      // 그리기 순서: FD(배경) → KO(정밀)
      this.meshes = [fdMesh, koMesh];
      this.meshByArea = { ko: koMesh, fd: fdMesh };
    },

    setFrame(area, data) {
      const mesh = this.meshByArea?.[area];
      if (!mesh) return;
      mesh.frameData = data;
      mesh.dirty = true;
      this.map?.triggerRepaint();
    },

    setConvRange(startKm, fullKm) {
      if (this.convStartKm === startKm && this.convFullKm === fullKm) return;
      this.convStartKm = startKm;
      this.convFullKm = fullKm;
      for (const mesh of this.meshes ?? []) mesh.dirty = true;
      this.map?.triggerRepaint();
    },

    // DN → (강도, 고도 m, 음영, 대류) 변환: 메쉬별 셀 중심 샘플
    convertMesh(gl, mesh) {
      const { w, h, cloudArray: cloud, heightScratch: heights, frameData } = mesh;
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
    },

    render(gl, renderArgs) {
      const projectionData = renderArgs?.defaultProjectionData;
      if (!projectionData || !this.meshes) return;

      for (const mesh of this.meshes) {
        if (mesh.dirty && mesh.frameData) this.convertMesh(gl, mesh);
      }

      const shader = this.getShader(gl, renderArgs.shaderData);
      gl.useProgram(shader.program);
      gl.uniformMatrix4fv(shader.uProjMatrix, false, projectionData.mainMatrix);
      gl.uniformMatrix4fv(shader.uFallbackMatrix, false, projectionData.fallbackMatrix);
      gl.uniform4f(shader.uTileMercatorCoords, ...projectionData.tileMercatorCoords);
      gl.uniform4f(shader.uClippingPlane, ...projectionData.clippingPlane);
      gl.uniform1f(shader.uTransition, projectionData.projectionTransition);
      gl.uniform1f(shader.uExag, this.exaggeration);
      gl.uniform1f(shader.uConvOn, this.convHighlight ? 1 : 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const koHasData = !!this.meshByArea.ko.frameData;
      for (const mesh of this.meshes) {
        if (!mesh.frameData) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
        gl.enableVertexAttribArray(shader.aPos);
        gl.vertexAttribPointer(shader.aPos, 2, gl.FLOAT, false, 0, 0);
        if (shader.aZScale >= 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.zScaleBuffer);
          gl.enableVertexAttribArray(shader.aZScale);
          gl.vertexAttribPointer(shader.aZScale, 1, gl.FLOAT, false, 0, 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.cloudBuffer);
        gl.enableVertexAttribArray(shader.aCloud);
        gl.vertexAttribPointer(shader.aCloud, 4, gl.FLOAT, false, 0, 0);
        // KO 데이터가 없으면 FD가 크롭 영역까지 전체를 그린다
        const useFull = mesh.indexBufferFull && !koHasData;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, useFull ? mesh.indexBufferFull : mesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, useFull ? mesh.indexCountFull : mesh.indexCount, gl.UNSIGNED_INT, 0);
      }
    },
  };
  return layer;
};

// menuSlot: 방송모드에서 뷰 전환 버튼(레이더/강수량/위성)을 우하단 그룹 위에 얹는다
function SatelliteView({ menuSlot = null }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const cloudLayerRef = useRef(null);
  const playTimerRef = useRef(null);

  const [timeline, setTimeline] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('최신 위성 자료 탐색 중…');
  const [exaggeration, setExaggeration] = useState(6);
  const [convHighlight, setConvHighlight] = useState(true);
  const [playDurationSec, setPlayDurationSec] = useState(10);
  const pendingFramesRef = useRef({ ko: null, fd: null });
  const pendingConvRangeRef = useRef(SEASON_CONV_KM.summer);
  const exaggerationRef = useRef(6);
  const convHighlightRef = useRef(true);

  const currentDate = timeline[frameIndex] ?? null;
  const convRange = useMemo(
    () => (currentDate ? seasonalConvRange(currentDate) : SEASON_CONV_KM.summer),
    [currentDate],
  );
  const bandTime = useMemo(
    () => (currentDate ? formatKstLabel(currentDate) : null),
    [currentDate],
  );

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
      // 레이어 생성 전에 도착한 프레임이 있으면 즉시 반영
      layer.setConvRange(...pendingConvRangeRef.current);
      for (const area of ['ko', 'fd']) {
        if (pendingFramesRef.current[area]) {
          layer.setFrame(area, pendingFramesRef.current[area]);
        }
      }
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

  // 최신 시각 탐색 → 12시간 타임라인 구성 (5분마다 갱신)
  useEffect(() => {
    let active = true;

    const refresh = async (initial = false) => {
      try {
        const latest = await probeLatestSatDate();
        if (!active) return;
        const previous = timelineRef.current;
        const next = buildSatTimeline(latest, TIMELINE_HOURS, STEP_MINUTES);
        const wasAtEnd =
          initial || previous.length === 0 || frameIndexRef.current >= previous.length - 1;
        let nextIndex = next.length - 1;
        if (!wasAtEnd) {
          // 사용자가 과거를 보고 있으면 같은 시각을 유지
          const held = previous[frameIndexRef.current]?.getTime();
          const heldIndex = next.findIndex((d) => d.getTime() === held);
          if (heldIndex >= 0) nextIndex = heldIndex;
        }
        setTimeline(next);
        setFrameIndex(nextIndex);
        if (initial) setStatus(null);
      } catch (error) {
        if (active && initial) setStatus(error.message);
      }
    };

    refresh(true);
    const timer = setInterval(refresh, AUTO_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // 현재 프레임 로드 → 3D 레이어 반영
  useEffect(() => {
    if (!currentDate) return;
    let active = true;

    (async () => {
      // KO(정밀)와 FD(전구 배경)를 병렬 로드 — 한쪽이 실패해도 나머지는 표시
      const [ko, fd] = await Promise.allSettled([
        fetchSatFrame(currentDate, 'ko'),
        fetchSatFrame(currentDate, 'fd'),
      ]);
      if (!active) return;
      const range = seasonalConvRange(currentDate);
      pendingConvRangeRef.current = range;
      cloudLayerRef.current?.setConvRange(...range);
      for (const [area, result] of [['ko', ko], ['fd', fd]]) {
        const data = result.status === 'fulfilled' ? result.value.data : null;
        pendingFramesRef.current[area] = data;
        cloudLayerRef.current?.setFrame(area, data);
      }
      if (ko.status === 'rejected' && fd.status === 'rejected') {
        setStatus(ko.reason?.message ?? fd.reason?.message);
      } else {
        setStatus(null);
      }
    })();

    // 인접 프레임 프리페치 (재생·스크럽 반응성)
    const nextDate = timeline[frameIndex + 1];
    if (nextDate) {
      fetchSatFrame(nextDate, 'ko').catch(() => {});
      fetchSatFrame(nextDate, 'fd').catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [currentDate, frameIndex, timeline]);

  // 타임라인 전 구간을 백그라운드에서 순차 프리페치 — 첫 재생부터 빈 프레임이
  // 없도록 한다. 프레임당 ko+fd를 함께 요청하고(서버가 원본 1회 다운로드로
  // 두 출력을 만들어 캐시), 한 프레임씩 순서대로 진행해 서버를 압박하지 않는다.
  //
  // 순서는 '현재 보고 있는 프레임에서 가까운 것부터'다. 서버는 미캐시 프레임을
  // 한 아이솔레이트에서 직렬 처리(processChain)하므로, 항상 최신→과거 고정
  // 순서로 프리페치하면 사용자가 과거 구간(예: 10~12시)으로 이동해도 그 프레임이
  // 프리페치 대기열 맨 뒤에 걸려 수십 초씩 지연·타임아웃된다. 매 반복마다
  // 현재 인덱스에 가장 가까운 미요청 프레임을 골라 요청하면, 사용자가 어디로
  // 스크럽하든 그 주변부터 데워져 체감 지연이 사라진다.
  useEffect(() => {
    if (timeline.length === 0) return undefined;
    let active = true;
    const requested = new Set();

    const nearestUnfetchedIndex = () => {
      const center = Math.min(Math.max(frameIndexRef.current, 0), timeline.length - 1);
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < timeline.length; i++) {
        if (requested.has(i)) continue;
        const dist = Math.abs(i - center);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    };

    (async () => {
      while (active) {
        const index = nearestUnfetchedIndex();
        if (index < 0) return; // 전 구간 프리페치 완료
        requested.add(index);
        await Promise.allSettled([
          fetchSatFrame(timeline[index], 'ko'),
          fetchSatFrame(timeline[index], 'fd'),
        ]);
      }
    })();

    return () => {
      active = false;
    };
  }, [timeline]);

  // 재생: 전 구간(12시간)을 선택한 재생 길이에 맞춰 진행하고 마지막에서 멈춘다
  useEffect(() => {
    if (!isPlaying || timeline.length === 0) return undefined;
    const last = timeline.length - 1;
    const intervalMs = Math.max(45, Math.round((playDurationSec * 1000) / timeline.length));
    playTimerRef.current = setInterval(() => {
      const next = Math.min(frameIndexRef.current + 1, last);
      setFrameIndex(next);
      if (next >= last) {
        setIsPlaying(false);
      }
    }, intervalMs);
    return () => clearInterval(playTimerRef.current);
  }, [isPlaying, timeline.length, playDurationSec]);

  // 끝에서 다시 재생을 누르면 처음부터
  const handlePlayToggle = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (timeline.length > 0 && frameIndex >= timeline.length - 1) {
      setFrameIndex(0);
    }
    setIsPlaying(true);
  }, [frameIndex, isPlaying, timeline.length]);

  const handleSlider = useCallback((event) => {
    setIsPlaying(false);
    setFrameIndex(Number(event.target.value));
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
          <span
            className="whitespace-nowrap font-black tracking-tight text-white"
            style={{
              fontSize: 'clamp(26px, 2.1vw, 46px)',
              textShadow: '0 2px 6px rgba(0,0,0,0.35)',
            }}
          >
            위성 영상
          </span>
          {bandTime ? (
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
                {bandTime.clock}
              </span>
              <span
                className="font-semibold text-[#bdd6fb]"
                style={{ fontSize: 'clamp(13px, 0.95vw, 20px)' }}
              >
                {bandTime.date}
              </span>
            </div>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-[#3d86e8] to-[#8ec2ff]" />
        </div>
      </div>

      {status ? <div className="sat-status">{status}</div> : null}

      {/* 하단 반투명 컨트롤바 — 레이더 방송모드와 동일 형태·위치 */}
      <div className="absolute bottom-0 left-1/2 right-0 z-10 bg-gradient-to-t from-slate-900/65 via-slate-900/35 to-transparent pb-4 pl-0 pr-6 pt-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePlayToggle}
            className="flex h-12 w-12 shrink-0 -translate-x-1/2 items-center justify-center rounded-full bg-[#0033a0] text-white shadow-sm transition hover:bg-blue-800"
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

      {/* 우하단: (방송모드) 뷰 전환 + 표시 옵션 + 재생 길이 — 레이더와 동일 위치 */}
      <div className="absolute bottom-[8.5rem] right-6 z-20 flex flex-col items-end gap-2.5">
        {menuSlot}
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

      {convHighlight ? (
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
