import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const BROADCAST_CITIES = [
  { name: '서울', lon: 126.978, lat: 37.566 },
  { name: '인천', lon: 126.705, lat: 37.456 },
  { name: '춘천', lon: 127.73, lat: 37.881 },
  { name: '강릉', lon: 128.876, lat: 37.752 },
  { name: '청주', lon: 127.489, lat: 36.642 },
  { name: '대전', lon: 127.385, lat: 36.35 },
  { name: '전주', lon: 127.148, lat: 35.824 },
  { name: '광주', lon: 126.852, lat: 35.16 },
  { name: '목포', lon: 126.392, lat: 34.812 },
  { name: '대구', lon: 128.601, lat: 35.871 },
  { name: '안동', lon: 128.726, lat: 36.568 },
  { name: '포항', lon: 129.343, lat: 36.019 },
  { name: '울산', lon: 129.311, lat: 35.539 },
  { name: '부산', lon: 129.075, lat: 35.18 },
  { name: '창원', lon: 128.681, lat: 35.228 },
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

const RadarMapView = () => {
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
  const [isFrameLoading, setIsFrameLoading] = useState(false);

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
      center: [127.6, 36.2],
      zoom: 5.6,
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
        { id: 'radar-overlay', type: 'raster', source: 'radar-overlay', paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' } },
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

    while (cache.size > FRAME_CACHE_LIMIT) {
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

  // 초기 로딩: 최신 실황·예측 시각을 찾아 타임라인 구성
  useEffect(() => {
    let isActive = true;

    const initialize = async () => {
      try {
        const [radarLatest, qpfLatest] = await Promise.all([
          probeLatestRadarTm(new Date(), OBS_HISTORY_HOURS * 60),
          probeLatestQpfTm().catch(() => null),
        ]);
        if (!isActive) {
          return;
        }

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
        setFrames(timeline);
        setFrameIndex(observationFrames.length - 1);
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
  }, [loadFrameData, rememberFrameBuckets]);

  // 현재 프레임 렌더링
  useEffect(() => {
    const frameDef = frames[frameIndex];
    if (!frameDef || status !== 'ready') {
      return;
    }

    const token = ++renderTokenRef.current;
    if (!frameCacheRef.current.has(frameDef.key)) {
      queueMicrotask(() => {
        if (renderTokenRef.current === token) {
          setIsFrameLoading(true);
        }
      });
    }

    loadFrameData(frameDef)
      .then((buckets) => {
        if (renderTokenRef.current === token) {
          renderFrame({ ...frameDef, buckets });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (renderTokenRef.current === token) {
          setIsFrameLoading(false);
        }
      });
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

  // 재생
  useEffect(() => {
    if (!isPlaying || frames.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setFrameIndex((previous) => (previous + 1) % frames.length);
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isPlaying, frames.length]);

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
    return Array.from({ length: 13 }, (_, index) => {
      const hourOffset = index - 6;
      const position = (index / 12) * 100;
      const isLabeled = hourOffset % 2 === 0;
      let label = '';
      if (isLabeled) {
        label =
          hourOffset === 0
            ? '현재'
            : formatHourMinute(new Date(baseTimeMs + hourOffset * 60 * 60 * 1000));
      }
      return { hourOffset, position, isLabeled, label };
    });
  }, [baseTimeMs]);

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900">레이더 · 초단기예측</h2>
          <div className="mt-1 text-sm text-slate-500">
            기상청 레이더 강수 실황(5분 간격, 과거 6시간)과 초단기 예측강수(10분 간격, 미래 6시간)입니다.
          </div>
        </div>
        {isFrameLoading ? (
          <span className="text-xs font-medium text-slate-400">불러오는 중…</span>
        ) : null}
      </div>

      <div className="relative">
        <div ref={mapContainerRef} className="h-[60vh] min-h-[420px] w-full" />
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
      </div>

      <div className="space-y-3 border-t border-slate-200 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsPlaying((previous) => !previous)}
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
              className="h-2 w-full cursor-pointer appearance-none rounded-full accent-[#0033a0]"
              style={{ background: 'linear-gradient(to right, #64748b 50%, #2563eb 50%)' }}
            />
            <div className="relative mt-1 h-7">
              {timelineTicks.map(({ hourOffset, position, isLabeled, label }) => (
                <div
                  key={hourOffset}
                  className="absolute top-0"
                  style={{ left: `${position}%` }}
                >
                  <div
                    className={`mx-auto w-px -translate-x-1/2 ${
                      isLabeled ? 'h-2 bg-slate-400' : 'h-1.5 bg-slate-300'
                    }`}
                  />
                  {isLabeled ? (
                    <div
                      className={`mt-0.5 whitespace-nowrap text-[10px] font-medium tabular-nums ${
                        hourOffset === 0 ? 'font-bold text-slate-700' : 'text-slate-400'
                      } ${
                        position <= 2
                          ? ''
                          : position >= 98
                            ? '-translate-x-full'
                            : '-translate-x-1/2'
                      }`}
                    >
                      {label}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="pb-3">
          <RadarLegend />
        </div>
      </div>
    </section>
  );
};

export default RadarMapView;
