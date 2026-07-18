// 방송모드 위성 영상 뷰 (작업 중 — main.jsx의 ?satellite=1 게이트로만 진입).
//
// 천리안2A(GK2A) IR105 동아시아 관측을 지도 위에 그리고, 휘도온도에서 유도한
// 의사 운정고도로 구름을 3D 돌출(과장)시켜 표현한다. 지도를 눕히면(pitch)
// 구름 높이가 입체로 보인다. 과거 12시간을 10분 간격으로 조회할 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  DN_TO_BT_KELVIN,
  SAT_GRID,
  buildSatTimeline,
  fetchSatFrame,
  lccKmToLonLat,
  probeLatestSatDate,
} from '../api/satApi';
import './SatelliteView.css';

// 메쉬는 다운샘플 격자의 2칸 간격(16km) 정점으로 구성 — 12만 정점/24만 삼각형.
const MESH_STEP = 2;
const MESH_W = Math.floor(SAT_GRID.width / MESH_STEP);
const MESH_H = Math.floor(SAT_GRID.height / MESH_STEP);
const TIMELINE_HOURS = 12;
const STEP_MINUTES = 10;
const AUTO_REFRESH_MS = 5 * 60 * 1000;

// 휘도온도(°C) → 표시 강도/의사 운정고도
const BT_CLEAR_C = 15; // 이보다 따뜻하면 구름 없음 취급
const BT_TOP_C = -75; // 이보다 차가우면 최대 강도
const LAPSE_C_PER_KM = 6.5;
const MAX_CLOUD_KM = 16;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const formatKstLabel = (dateUtc) => {
  const kst = new Date(dateUtc.getTime() + KST_OFFSET_MS);
  return {
    date: `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 (${WEEKDAYS[kst.getUTCDay()]})`,
    clock: `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`,
  };
};

const formatTickLabel = (dateUtc) => {
  const kst = new Date(dateUtc.getTime() + KST_OFFSET_MS);
  return `${String(kst.getUTCHours()).padStart(2, '0')}시`;
};

const MAP_STYLE = {
  version: 8,
  sources: {
    coastline: { type: 'geojson', data: '/data/map/ea-coastline-50m.geojson' },
    sido: { type: 'geojson', data: '/data/map/kr-sido-20260701.geojson' },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#060d16' } },
    {
      id: 'coastline',
      type: 'line',
      source: 'coastline',
      paint: { 'line-color': '#3f5c78', 'line-width': 1.1 },
    },
    {
      id: 'sido',
      type: 'line',
      source: 'sido',
      paint: { 'line-color': '#4d6b88', 'line-width': 0.9 },
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
    frameData: null, // Uint16Array (750x650)
    dirty: false,

    onAdd(map, gl) {
      this.map = map;
      const vertexSource = `
        attribute vec2 aPos;
        attribute float aZScale;
        attribute vec3 aCloud; // x: 강도 0..1, y: 고도(m), z: 음영 계수
        uniform mat4 uMatrix;
        uniform float uExag;
        varying float vT;
        varying float vShade;
        void main() {
          vT = aCloud.x;
          vShade = aCloud.z;
          float z = aCloud.y * aZScale * uExag;
          gl_Position = uMatrix * vec4(aPos, z, 1.0);
        }
      `;
      const fragmentSource = `
        precision mediump float;
        varying float vT;
        varying float vShade;
        void main() {
          float alpha = smoothstep(0.02, 0.30, vT) * 0.96;
          vec3 low = vec3(0.58, 0.65, 0.76);
          vec3 high = vec3(1.0, 1.0, 1.0);
          vec3 color = mix(low, high, clamp(vT * 1.25, 0.0, 1.0));
          gl_FragColor = vec4(color * vShade * alpha, alpha);
        }
      `;
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error('[satellite] shader compile:', gl.getShaderInfoLog(shader));
        }
        return shader;
      };
      this.program = gl.createProgram();
      gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        console.error('[satellite] program link:', gl.getProgramInfoLog(this.program));
      }
      this.aPos = gl.getAttribLocation(this.program, 'aPos');
      this.aZScale = gl.getAttribLocation(this.program, 'aZScale');
      this.aCloud = gl.getAttribLocation(this.program, 'aCloud');
      this.uMatrix = gl.getUniformLocation(this.program, 'uMatrix');
      this.uExag = gl.getUniformLocation(this.program, 'uExag');

      // 정점 위치(메르카토르)와 고도 스케일은 고정 — 한 번만 계산
      const positions = new Float32Array(MESH_W * MESH_H * 2);
      const zScales = new Float32Array(MESH_W * MESH_H);
      let v = 0;
      for (let mj = 0; mj < MESH_H; mj++) {
        const yKm = SAT_GRID.yMaxKm - mj * MESH_STEP * SAT_GRID.cellKm;
        for (let mi = 0; mi < MESH_W; mi++) {
          const xKm = SAT_GRID.xMinKm + mi * MESH_STEP * SAT_GRID.cellKm;
          const [lon, lat] = lccKmToLonLat(xKm, yKm);
          const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
          positions[v * 2] = merc.x;
          positions[v * 2 + 1] = merc.y;
          zScales[v] = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, 1).z;
          v++;
        }
      }

      const indices = new Uint32Array((MESH_W - 1) * (MESH_H - 1) * 6);
      let t = 0;
      for (let mj = 0; mj < MESH_H - 1; mj++) {
        for (let mi = 0; mi < MESH_W - 1; mi++) {
          const i0 = mj * MESH_W + mi;
          indices[t++] = i0;
          indices[t++] = i0 + 1;
          indices[t++] = i0 + MESH_W;
          indices[t++] = i0 + 1;
          indices[t++] = i0 + MESH_W + 1;
          indices[t++] = i0 + MESH_W;
        }
      }
      this.indexCount = indices.length;

      const makeBuffer = (target, data, usage) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, data, usage);
        return buffer;
      };
      this.posBuffer = makeBuffer(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      this.zScaleBuffer = makeBuffer(gl.ARRAY_BUFFER, zScales, gl.STATIC_DRAW);
      this.cloudArray = new Float32Array(MESH_W * MESH_H * 3);
      this.cloudBuffer = makeBuffer(gl.ARRAY_BUFFER, this.cloudArray, gl.DYNAMIC_DRAW);
      this.indexBuffer = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    },

    setFrame(data) {
      this.frameData = data;
      this.dirty = true;
      this.map?.triggerRepaint();
    },

    render(gl, renderArgs) {
      if (!this.program) return;
      // maplibre v5는 두 번째 인자로 행렬 대신 객체를 넘긴다 (globe 지원).
      const matrix =
        renderArgs?.defaultProjectionData?.mainMatrix ??
        renderArgs?.modelViewProjectionMatrix ??
        renderArgs;

      if (this.dirty && this.frameData) {
        // DN → (강도, 고도 m): 셀 중심 샘플
        const cloud = this.cloudArray;
        if (!this.heightScratch) {
          this.heightScratch = new Float32Array(MESH_W * MESH_H);
        }
        const heights = this.heightScratch;
        let v = 0;
        for (let mj = 0; mj < MESH_H; mj++) {
          const row = mj * MESH_STEP * SAT_GRID.width;
          for (let mi = 0; mi < MESH_W; mi++) {
            const dn = this.frameData[row + mi * MESH_STEP];
            const btK = DN_TO_BT_KELVIN[Math.min(dn, 8191)];
            const btC = Number.isNaN(btK) ? BT_TOP_C - 30 : btK - 273.15;
            const intensity = Math.min(1, Math.max(0, (BT_CLEAR_C - btC) / (BT_CLEAR_C - BT_TOP_C)));
            const heightKm = Math.min(MAX_CLOUD_KM, Math.max(0, (BT_CLEAR_C - btC) / LAPSE_C_PER_KM));
            cloud[v * 3] = intensity;
            heights[v] = heightKm * 1000;
            v++;
          }
        }
        // 고도 3x3 평균(스파이크 완화) + 북서 사면 밝게/남동 사면 어둡게 간이 음영
        for (let mj = 0; mj < MESH_H; mj++) {
          for (let mi = 0; mi < MESH_W; mi++) {
            let sum = 0;
            let count = 0;
            for (let dj = -1; dj <= 1; dj++) {
              const nj = mj + dj;
              if (nj < 0 || nj >= MESH_H) continue;
              for (let di = -1; di <= 1; di++) {
                const ni = mi + di;
                if (ni < 0 || ni >= MESH_W) continue;
                sum += heights[nj * MESH_W + ni];
                count++;
              }
            }
            cloud[(mj * MESH_W + mi) * 3 + 1] = sum / count;
          }
        }
        for (let mj = 0; mj < MESH_H; mj++) {
          for (let mi = 0; mi < MESH_W; mi++) {
            const idx = mj * MESH_W + mi;
            const here = cloud[idx * 3 + 1];
            const nw = cloud[(Math.max(0, mj - 1) * MESH_W + Math.max(0, mi - 1)) * 3 + 1];
            const gradient = (here - nw) / 1000; // km per cell
            cloud[idx * 3 + 2] = Math.min(1.12, Math.max(0.72, 1 + gradient * 0.06));
          }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, cloud);
        this.dirty = false;
      }

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uMatrix, false, matrix);
      gl.uniform1f(this.uExag, this.exaggeration);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.zScaleBuffer);
      gl.enableVertexAttribArray(this.aZScale);
      gl.vertexAttribPointer(this.aZScale, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cloudBuffer);
      gl.enableVertexAttribArray(this.aCloud);
      gl.vertexAttribPointer(this.aCloud, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    },
  };
  return layer;
};

function SatelliteView() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const cloudLayerRef = useRef(null);
  const playTimerRef = useRef(null);

  const [timeline, setTimeline] = useState([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('최신 위성 자료 탐색 중…');
  const [exaggeration, setExaggeration] = useState(6);
  const pendingFrameRef = useRef(null);
  const exaggerationRef = useRef(6);

  const currentDate = timeline[frameIndex] ?? null;
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
      cloudLayerRef.current = layer;
      map.addLayer(layer);
      // 레이어 생성 전에 도착한 프레임이 있으면 즉시 반영
      if (pendingFrameRef.current) {
        layer.setFrame(pendingFrameRef.current);
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
      try {
        const frame = await fetchSatFrame(currentDate);
        if (!active) return;
        setStatus(null);
        pendingFrameRef.current = frame.data;
        cloudLayerRef.current?.setFrame(frame.data);
      } catch (error) {
        if (active) setStatus(error.message);
      }
    })();

    // 인접 프레임 프리페치 (재생·스크럽 반응성)
    const nextDate = timeline[frameIndex + 1];
    if (nextDate) fetchSatFrame(nextDate).catch(() => {});

    return () => {
      active = false;
    };
  }, [currentDate, frameIndex, timeline]);

  // 재생
  useEffect(() => {
    if (!isPlaying || timeline.length === 0) return undefined;
    playTimerRef.current = setInterval(() => {
      setFrameIndex((previous) => (previous + 1) % timeline.length);
    }, 450);
    return () => clearInterval(playTimerRef.current);
  }, [isPlaying, timeline.length]);

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

  return (
    <div className="sat-view">
      <div ref={mapContainerRef} className="sat-map" />

      <div className="sat-band">
        <div className="sat-band-title">위성 영상</div>
        {bandTime ? (
          <div className="sat-band-time">
            <span className="sat-band-date">{bandTime.date}</span>
            <span className="sat-band-clock">{bandTime.clock}</span>
          </div>
        ) : null}
        <div className="sat-band-note">천리안2A 적외 · 동아시아</div>
      </div>

      {status ? <div className="sat-status">{status}</div> : null}

      <div className="sat-controls">
        <button
          type="button"
          className="sat-play-button"
          onClick={() => setIsPlaying((previous) => !previous)}
          aria-label={isPlaying ? '일시정지' : '재생'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <div className="sat-slider-wrap">
          <input
            type="range"
            className="sat-slider"
            min={0}
            max={Math.max(0, timeline.length - 1)}
            value={frameIndex}
            onChange={handleSlider}
          />
          <div className="sat-ticks">
            {ticks.map((tick) => (
              <span key={tick.key}>
                <span className="sat-tick" style={{ left: tick.left }} />
                {tick.label ? (
                  <span className="sat-tick-label" style={{ left: tick.left }}>
                    {tick.label}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
        <label className="sat-exag">
          입체 과장
          <input
            type="range"
            min={1}
            max={20}
            value={exaggeration}
            onChange={(event) => setExaggeration(Number(event.target.value))}
          />
          ×{exaggeration}
        </label>
      </div>
    </div>
  );
}

export default SatelliteView;
