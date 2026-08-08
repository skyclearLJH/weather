import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Layers3,
  LoaderCircle,
  Mountain,
  RefreshCw,
  Waves,
  Wind,
} from 'lucide-react';
import { fetchTerrainWindForecast } from '../api/terrainRainApi.js';
import {
  fetchAwsStationCoords,
  fetchHourlyRnDay,
  formatStationLabel,
} from '../api/accumApi.js';
import WindParticleOverlay from './WindParticleOverlay.jsx';

const TERRAIN_SOURCE_ID = 'terrain-dem';
const TERRAIN_HILLSHADE_LAYER_ID = 'terrain-hillshade';
const BASIN_SOURCE_ID = 'terrain-basins';
const BASIN_LABEL_SOURCE_ID = 'terrain-basin-label-points';
const BASIN_SELECTED_SOURCE_ID = 'terrain-basin-selected';
const RIVER_SOURCE_ID = 'terrain-national-rivers';
const BASIN_LAYER_IDS = [
  'terrain-basin-fill',
  'terrain-basin-line',
  'terrain-basin-label',
  'terrain-basin-selected-fill',
  'terrain-basin-selected-line',
];
const RIVER_LAYER_IDS = ['terrain-river-fill', 'terrain-river-line', 'terrain-river-label'];
const BASIN_DATA_URL = '/data/map/kr-basin-middle-202504.geojson';
const RIVER_DATA_URL = '/data/map/kr-national-rivers-2025.geojson';
const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
const HOUR_MS = 60 * 60 * 1000;

const formatTime = (date) =>
  date instanceof Date && Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : '--:--';

const setLayerVisibility = (map, layerIds, visible) => {
  layerIds.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  });
};

const pointInRing = ([x, y], ring) => {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

const pointInPolygon = (point, coordinates) => {
  if (!coordinates?.[0] || !pointInRing(point, coordinates[0])) return false;
  return !coordinates.slice(1).some((hole) => pointInRing(point, hole));
};

const pointInFeature = (point, feature) => {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
};

const ringArea = (ring) => {
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea / 2);
};

const ringCentroid = (ring) => {
  let twiceArea = 0;
  let xTotal = 0;
  let yTotal = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    xTotal += (x1 + x2) * cross;
    yTotal += (y1 + y2) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) return null;
  return [xTotal / (3 * twiceArea), yTotal / (3 * twiceArea)];
};

const findPolygonLabelPoint = (polygon) => {
  const outerRing = polygon?.[0];
  if (!outerRing?.length) return null;

  const xs = outerRing.map(([x]) => x);
  const ys = outerRing.map(([, y]) => y);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const center = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const centroid = ringCentroid(outerRing);

  if (centroid && pointInPolygon(centroid, polygon)) return centroid;
  if (pointInPolygon(center, polygon)) return center;

  const target = centroid ?? center;
  let bestPoint = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const gridSize = 16;
  for (let row = 1; row < gridSize; row += 1) {
    for (let column = 1; column < gridSize; column += 1) {
      const point = [
        bounds[0] + ((bounds[2] - bounds[0]) * column) / gridSize,
        bounds[1] + ((bounds[3] - bounds[1]) * row) / gridSize,
      ];
      if (!pointInPolygon(point, polygon)) continue;
      const distance = (point[0] - target[0]) ** 2 + (point[1] - target[1]) ** 2;
      if (distance < bestDistance) {
        bestPoint = point;
        bestDistance = distance;
      }
    }
  }
  return bestPoint ?? outerRing[0];
};

const buildBasinLabelPoints = (basins) => {
  const seenCodes = new Set();
  const features = (basins?.features ?? []).flatMap((feature) => {
    const code = feature?.properties?.mbsncd;
    if (code != null && seenCodes.has(String(code))) return [];

    const geometry = feature?.geometry;
    const polygons = geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
    if (polygons.length === 0) return [];

    const mainPolygon = polygons.reduce((largest, polygon) => (
      ringArea(polygon?.[0] ?? []) > ringArea(largest?.[0] ?? []) ? polygon : largest
    ));
    const point = findPolygonLabelPoint(mainPolygon);
    if (!point) return [];
    if (code != null) seenCodes.add(String(code));

    return [{
      type: 'Feature',
      properties: { ...feature.properties },
      geometry: { type: 'Point', coordinates: point },
    }];
  });

  return { type: 'FeatureCollection', features };
};

const summarizeStations = (rows) => {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + row.mm, 0);
  const maximum = rows.reduce((highest, row) => (row.mm > highest.mm ? row : highest), rows[0]);
  return { average: total / rows.length, maximum, count: rows.length };
};

const addTerrainLayers = (map, basins, rivers) => {
  const basinLabelPoints = buildBasinLabelPoints(basins);
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 15,
      bounds: [123.5, 31.5, 132.5, 40.5],
      attribution: 'Terrain Tiles © Mapzen / AWS Open Data',
    });
  }
  if (!map.getSource(BASIN_SOURCE_ID)) {
    map.addSource(BASIN_SOURCE_ID, { type: 'geojson', data: basins });
  }
  if (!map.getSource(BASIN_LABEL_SOURCE_ID)) {
    map.addSource(BASIN_LABEL_SOURCE_ID, { type: 'geojson', data: basinLabelPoints });
  }
  if (!map.getSource(BASIN_SELECTED_SOURCE_ID)) {
    map.addSource(BASIN_SELECTED_SOURCE_ID, {
      type: 'geojson',
      data: EMPTY_FEATURE_COLLECTION,
    });
  }
  if (!map.getSource(RIVER_SOURCE_ID)) {
    map.addSource(RIVER_SOURCE_ID, { type: 'geojson', data: rivers });
  }

  const beforeRadar = map.getLayer('radar-overlay') ? 'radar-overlay' : 'province-border';
  if (!map.getLayer(TERRAIN_HILLSHADE_LAYER_ID)) {
    map.addLayer(
      {
        id: TERRAIN_HILLSHADE_LAYER_ID,
        type: 'hillshade',
        source: TERRAIN_SOURCE_ID,
        layout: { visibility: 'none' },
        paint: {
          'hillshade-exaggeration': 0.48,
          'hillshade-shadow-color': '#334155',
          'hillshade-highlight-color': '#f8fafc',
          'hillshade-accent-color': '#64748b',
          'hillshade-illumination-anchor': 'map',
        },
      },
      beforeRadar,
    );
  }
  if (!map.getLayer('terrain-basin-fill')) {
    map.addLayer(
      {
        id: 'terrain-basin-fill',
        type: 'fill',
        source: BASIN_SOURCE_ID,
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.035 },
      },
      beforeRadar,
    );
  }
  if (!map.getLayer('terrain-basin-line')) {
    map.addLayer(
      {
        id: 'terrain-basin-line',
        type: 'line',
        source: BASIN_SOURCE_ID,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 9, 1.8],
          'line-opacity': 0.8,
        },
      },
      beforeRadar,
    );
  }
  if (!map.getLayer('terrain-basin-selected-fill')) {
    map.addLayer({
      id: 'terrain-basin-selected-fill',
      type: 'fill',
      source: BASIN_SELECTED_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: { 'fill-color': '#facc15', 'fill-opacity': 0.16 },
    });
  }
  if (!map.getLayer('terrain-basin-selected-line')) {
    map.addLayer({
      id: 'terrain-basin-selected-line',
      type: 'line',
      source: BASIN_SELECTED_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: { 'line-color': '#fef08a', 'line-width': 3, 'line-opacity': 1 },
    });
  }
  if (!map.getLayer('terrain-river-fill')) {
    map.addLayer(
      {
        id: 'terrain-river-fill',
        type: 'fill',
        source: RIVER_SOURCE_ID,
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.88 },
      },
      'province-border',
    );
  }
  if (!map.getLayer('terrain-river-line')) {
    map.addLayer(
      {
        id: 'terrain-river-line',
        type: 'line',
        source: RIVER_SOURCE_ID,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#e0f2fe',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 10, 1.2],
          'line-opacity': 0.9,
        },
      },
      'province-border',
    );
  }
  if (!map.getLayer('terrain-basin-label')) {
    map.addLayer({
      id: 'terrain-basin-label',
      type: 'symbol',
      source: BASIN_LABEL_SOURCE_ID,
      minzoom: 7.2,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'mbsnnm'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 7.2, 10, 11, 14],
        'text-font': ['Open Sans Semibold'],
        'text-allow-overlap': false,
        'text-padding': 4,
      },
      paint: {
        'text-color': '#e0f2fe',
        'text-halo-color': 'rgba(15,23,42,0.82)',
        'text-halo-width': 1.4,
      },
    });
  }
  if (!map.getLayer('terrain-river-label')) {
    map.addLayer({
      id: 'terrain-river-label',
      type: 'symbol',
      source: RIVER_SOURCE_ID,
      minzoom: 7.4,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'rivnm_2'],
        'text-size': 11,
        'text-font': ['Open Sans Semibold'],
        'text-allow-overlap': false,
        'text-padding': 5,
      },
      paint: {
        'text-color': '#bae6fd',
        'text-halo-color': 'rgba(15,23,42,0.9)',
        'text-halo-width': 1.25,
      },
    });
  }
};

function LayerToggle({ active, icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-black transition ${
        active
          ? 'border-cyan-200/60 bg-cyan-300 text-slate-950'
          : 'border-white/15 bg-slate-950/70 text-white/65 hover:bg-slate-800 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function BasinMetric({ label, summary, accent }) {
  return (
    <div className="border-t border-white/10 px-5 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-bold text-white/70">{label}</span>
        <span className="text-2xl font-black tabular-nums" style={{ color: accent }}>
          {summary ? summary.average.toFixed(1) : '-'}
          <span className="ml-1 text-xs font-bold text-white/60">mm</span>
        </span>
      </div>
      {summary ? (
        <div className="mt-1 flex justify-between gap-3 text-xs text-white/55">
          <span>{summary.count}개 지점 평균</span>
          <span className="truncate text-right">
            최대 {formatStationLabel(summary.maximum.station)} {summary.maximum.mm.toFixed(1)}mm
          </span>
        </div>
      ) : null}
    </div>
  );
}

function TerrainRainOverlay({
  active,
  currentTime,
  latestObservationTime,
  mapRef,
  workspaceMode,
}) {
  const basinDataRef = useRef(null);
  const rainDataRef = useRef(null);
  const [windVisible, setWindVisible] = useState(true);
  const [basinVisible, setBasinVisible] = useState(true);
  const [riverVisible, setRiverVisible] = useState(true);
  const [terrainExaggeration, setTerrainExaggeration] = useState(1.2);
  const [terrainStatus, setTerrainStatus] = useState('idle');
  const [windData, setWindData] = useState({ status: 'idle', points: [], validTime: null, error: '' });
  const [selectedBasin, setSelectedBasin] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState('idle');

  const ensureRainData = useCallback(async () => {
    const observedAt =
      latestObservationTime instanceof Date && Number.isFinite(latestObservationTime.getTime())
        ? latestObservationTime
        : new Date();
    const hour = new Date(Math.floor(observedAt.getTime() / HOUR_MS) * HOUR_MS);
    const key = String(hour.getTime());
    if (rainDataRef.current?.key === key) return rainDataRef.current;
    const stations = await fetchAwsStationCoords();
    let values;
    let resolvedHour = hour;
    try {
      values = await fetchHourlyRnDay(hour);
    } catch {
      resolvedHour = new Date(hour.getTime() - HOUR_MS);
      values = await fetchHourlyRnDay(resolvedHour);
    }
    rainDataRef.current = { key, stations, values, observedAt: resolvedHour };
    return rainDataRef.current;
  }, [latestObservationTime]);

  const analyzeBasin = useCallback(
    async (feature) => {
      setAnalysisStatus('loading');
      setAnalysis(null);
      try {
        const rainData = await ensureRainData();
        const rows = rainData.stations
          .filter((station) => pointInFeature([station.lon, station.lat], feature))
          .map((station) => ({
            station,
            elevation: Number.isFinite(station.elevation) ? station.elevation : 0,
            mm: rainData.values.get(station.id),
          }))
          .filter((row) => Number.isFinite(row.mm))
          .sort((a, b) => a.elevation - b.elevation);
        if (rows.length === 0) {
          setAnalysis({ observedAt: rainData.observedAt, totalStations: 0, upper: null, lower: null });
          setAnalysisStatus('ready');
          return;
        }
        const splitIndex = Math.max(1, Math.floor(rows.length / 2));
        const lowerRows = rows.slice(0, splitIndex);
        const upperRows = rows.slice(splitIndex).length > 0 ? rows.slice(splitIndex) : rows.slice(-1);
        setAnalysis({
          observedAt: rainData.observedAt,
          totalStations: rows.length,
          upper: summarizeStations(upperRows),
          lower: summarizeStations(lowerRows),
        });
        setAnalysisStatus('ready');
      } catch (error) {
        setAnalysisStatus('error');
        setAnalysis({ error: error instanceof Error ? error.message : '유역 관측값을 불러오지 못했습니다.' });
      }
    },
    [ensureRainData],
  );

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let starting = false;
    let retryTimer = 0;
    let setupInterval = 0;
    const cameraTimers = [];
    let activeMap = null;
    let previousTerrainPaint = null;
    const abortController = new AbortController();

    const setup = async () => {
      const map = mapRef.current;
      if (cancelled || starting || !map || !map.isStyleLoaded()) return;
      activeMap = map;
      starting = true;
      setTerrainStatus('loading');
      try {
        const [basins, rivers] = await Promise.all([
          fetch(BASIN_DATA_URL, { signal: abortController.signal }).then((response) => {
            if (!response.ok) throw new Error('유역 경계를 불러오지 못했습니다.');
            return response.json();
          }),
          fetch(RIVER_DATA_URL, { signal: abortController.signal }).then((response) => {
            if (!response.ok) throw new Error('하천 경계를 불러오지 못했습니다.');
            return response.json();
          }),
        ]);
        if (cancelled) return;
        basinDataRef.current = basins;
        addTerrainLayers(map, basins, rivers);
        map.setMaxPitch(70);
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
        map.setLayoutProperty(TERRAIN_HILLSHADE_LAYER_ID, 'visibility', 'visible');
        setLayerVisibility(map, BASIN_LAYER_IDS, basinVisible);
        setLayerVisibility(map, RIVER_LAYER_IDS, riverVisible);
        map.dragRotate.enable();
        if (!previousTerrainPaint) {
          previousTerrainPaint = {
            land: map.getPaintProperty('land', 'fill-color'),
            neighborLand: map.getPaintProperty('neighbor-land', 'fill-color'),
            seam: map.getPaintProperty('inter-korean-seam', 'fill-color'),
            provinceBorder: map.getPaintProperty('province-border', 'line-color'),
          };
        }
        const applyTerrainPalette = () => {
          if (cancelled || !activeMap) return;
          activeMap.setPaintProperty('land', 'fill-color', '#b9c7ae');
          activeMap.setPaintProperty('neighbor-land', 'fill-color', '#9da8ad');
          activeMap.setPaintProperty('inter-korean-seam', 'fill-color', '#9da8ad');
          activeMap.setPaintProperty('province-border', 'line-color', '#43505b');
        };
        const applyTerrainCamera = (duration = 0) => {
          if (cancelled || !activeMap) return;
          activeMap.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
          applyTerrainPalette();
          activeMap.easeTo({
            center: [127.7, 36.35],
            zoom: 6.15,
            pitch: 50,
            bearing: -10,
            duration,
          });
        };
        applyTerrainCamera(950);
        cameraTimers.push(
          window.setTimeout(() => applyTerrainCamera(500), 700),
          window.setTimeout(() => applyTerrainCamera(500), 1600),
        );
        setTerrainStatus('ready');
        window.clearInterval(setupInterval);
      } catch (error) {
        if (!cancelled && error?.name !== 'AbortError') {
          setTerrainStatus('error');
          retryTimer = window.setTimeout(setup, 2000);
        }
      } finally {
        starting = false;
      }
    };

    setup();
    retryTimer = window.setTimeout(setup, 350);
    setupInterval = window.setInterval(setup, 500);
    return () => {
      cancelled = true;
      abortController.abort();
      window.clearTimeout(retryTimer);
      window.clearInterval(setupInterval);
      cameraTimers.forEach((timer) => window.clearTimeout(timer));
      const map = activeMap;
      if (!map) return;
      setLayerVisibility(map, [TERRAIN_HILLSHADE_LAYER_ID, ...BASIN_LAYER_IDS, ...RIVER_LAYER_IDS], false);
      map.getSource(BASIN_SELECTED_SOURCE_ID)?.setData(EMPTY_FEATURE_COLLECTION);
      map.setTerrain(null);
      if (previousTerrainPaint) {
        map.setPaintProperty('land', 'fill-color', previousTerrainPaint.land);
        map.setPaintProperty('neighbor-land', 'fill-color', previousTerrainPaint.neighborLand);
        map.setPaintProperty('inter-korean-seam', 'fill-color', previousTerrainPaint.seam);
        map.setPaintProperty('province-border', 'line-color', previousTerrainPaint.provinceBorder);
      }
      map.setMaxPitch(60);
      map.dragRotate.disable();
      map.easeTo({ pitch: 0, bearing: 0, duration: 550 });
    };
    // Terrain initialization intentionally runs only when the view opens or closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mapRef]);

  useEffect(() => {
    if (!active) return;
    const map = mapRef.current;
    if (!map?.getSource(TERRAIN_SOURCE_ID)) return;
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
  }, [active, mapRef, terrainExaggeration]);

  useEffect(() => {
    if (!active) return;
    const map = mapRef.current;
    if (!map) return;
    setLayerVisibility(map, BASIN_LAYER_IDS, basinVisible);
    setLayerVisibility(map, RIVER_LAYER_IDS, riverVisible);
    if (!basinVisible) map.getSource(BASIN_SELECTED_SOURCE_ID)?.setData(EMPTY_FEATURE_COLLECTION);
  }, [active, basinVisible, mapRef, riverVisible]);

  const windHourKey = useMemo(() => {
    const timestamp =
      currentTime instanceof Date && Number.isFinite(currentTime.getTime())
        ? currentTime.getTime()
        : Date.now();
    return Math.round(timestamp / HOUR_MS) * HOUR_MS;
  }, [currentTime]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setWindData((previous) => ({ ...previous, status: 'loading', error: '' }));
    fetchTerrainWindForecast(new Date(windHourKey))
      .then((payload) => {
        if (!cancelled) {
          setWindData({
            status: 'ready',
            points: payload.points ?? [],
            validTime: payload.validTime,
            error: '',
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setWindData({
            status: 'error',
            points: [],
            validTime: null,
            error: error instanceof Error ? error.message : '지상풍 예보를 불러오지 못했습니다.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, windHourKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!active || !map) return undefined;
    const canvas = map.getCanvas();
    const handleClick = (event) => {
      if (!basinVisible || !map.getLayer('terrain-basin-fill')) return;
      const rendered = map.queryRenderedFeatures(event.point, { layers: ['terrain-basin-fill'] });
      const basinCode = rendered[0]?.properties?.mbsncd;
      const feature = basinDataRef.current?.features?.find(
        (candidate) => String(candidate.properties?.mbsncd) === String(basinCode),
      );
      if (!feature) return;
      setSelectedBasin(feature.properties ?? {});
      map.getSource(BASIN_SELECTED_SOURCE_ID)?.setData({
        type: 'FeatureCollection',
        features: [feature],
      });
      analyzeBasin(feature);
    };
    const handleMove = (event) => {
      if (!basinVisible || !map.getLayer('terrain-basin-fill')) {
        canvas.style.cursor = '';
        return;
      }
      const rendered = map.queryRenderedFeatures(event.point, { layers: ['terrain-basin-fill'] });
      canvas.style.cursor = rendered.length > 0 ? 'pointer' : '';
    };
    map.on('click', handleClick);
    map.on('mousemove', handleMove);
    return () => {
      map.off('click', handleClick);
      map.off('mousemove', handleMove);
      canvas.style.cursor = '';
    };
  }, [active, analyzeBasin, basinVisible, mapRef]);

  const retryWind = () => {
    setWindData((previous) => ({ ...previous, status: 'loading', error: '' }));
    fetchTerrainWindForecast(new Date(windHourKey))
      .then((payload) => {
        setWindData({ status: 'ready', points: payload.points ?? [], validTime: payload.validTime, error: '' });
      })
      .catch((error) => {
        setWindData({
          status: 'error',
          points: [],
          validTime: null,
          error: error instanceof Error ? error.message : '지상풍 예보를 불러오지 못했습니다.',
        });
      });
  };

  if (!active) return null;

  return (
    <>
      <WindParticleOverlay
        active={windVisible && windData.status === 'ready'}
        mapRef={mapRef}
        points={windData.points}
      />

      <div
        data-video-hide
        className="absolute right-6 top-[18%] z-20 w-[320px] rounded-md border border-white/15 bg-slate-950/78 p-3 text-white shadow-2xl backdrop-blur-md"
      >
        <div className="flex items-center justify-between gap-3 px-1 pb-2">
          <div>
            <div className="text-sm font-black">지형·수문 레이어</div>
            <div className="mt-0.5 text-[11px] font-semibold text-white/50">
              {terrainStatus === 'ready'
                ? `지상풍 예보 ${formatTime(windData.validTime)}`
                : terrainStatus === 'error'
                  ? '3D 지형 연결 재시도 중'
                  : '3D 지형 준비 중'}
            </div>
          </div>
          {windData.status === 'loading' ? (
            <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" aria-label="지상풍 로딩 중" />
          ) : windData.status === 'error' ? (
            <button
              type="button"
              onClick={retryWind}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-red-400/15 text-red-200 hover:bg-red-400/25"
              aria-label="지상풍 다시 불러오기"
              title={windData.error}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <LayerToggle active={windVisible} icon={<Wind className="h-4 w-4" aria-hidden="true" />} label="지상풍" onClick={() => setWindVisible((value) => !value)} />
          <LayerToggle active={basinVisible} icon={<Layers3 className="h-4 w-4" aria-hidden="true" />} label="유역" onClick={() => setBasinVisible((value) => !value)} />
          <LayerToggle active={riverVisible} icon={<Waves className="h-4 w-4" aria-hidden="true" />} label="하천" onClick={() => setRiverVisible((value) => !value)} />
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-md bg-white/5 px-3 py-2">
          <Mountain className="h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <label className="min-w-0 flex-1">
            <span className="flex justify-between text-[11px] font-bold text-white/65">
              <span>지형 높이</span>
              <span className="tabular-nums">x{terrainExaggeration.toFixed(1)}</span>
            </span>
            <input
              type="range"
              min="0.6"
              max="1.8"
              step="0.1"
              value={terrainExaggeration}
              onChange={(event) => setTerrainExaggeration(Number(event.target.value))}
              className="mt-1 h-1.5 w-full cursor-pointer accent-amber-300"
              aria-label="지형 높이 배율"
            />
          </label>
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-[10px] font-semibold text-white/45">
          <span className="text-cyan-200">약풍</span>
          <span className="text-yellow-300">보통</span>
          <span className="text-rose-300">강풍</span>
        </div>
      </div>

      {selectedBasin ? (
        <aside
          className="absolute left-[7%] top-[29%] z-20 w-[390px] overflow-hidden rounded-md border border-white/15 bg-slate-950/82 text-white shadow-2xl backdrop-blur-md"
          aria-label="선택 유역 강수 분석"
        >
          <div className="flex items-start justify-between gap-4 px-5 py-4">
            <div>
              <div className="text-[11px] font-black text-cyan-300">중권역 관측 분석</div>
              <div className="mt-1 text-2xl font-black">{selectedBasin.mbsnnm}</div>
              <div className="mt-1 text-xs font-semibold text-white/50">
                {analysis?.observedAt ? `${formatTime(analysis.observedAt)} 기준` : '관측값 계산 중'}
                {analysis?.totalStations ? ` · ${analysis.totalStations}개 AWS` : ''}
              </div>
            </div>
            {analysisStatus === 'loading' ? (
              <LoaderCircle className="mt-1 h-5 w-5 animate-spin text-cyan-300" aria-hidden="true" />
            ) : null}
          </div>
          {analysisStatus === 'error' ? (
            <div className="border-t border-white/10 px-5 py-4 text-sm font-semibold text-red-200">
              {analysis?.error}
            </div>
          ) : (
            <>
              <BasinMetric label="상류권 누적강수" summary={analysis?.upper} accent="#facc15" />
              <BasinMetric label="하류권 관측값" summary={analysis?.lower} accent="#7dd3fc" />
            </>
          )}
          <div className="flex items-start gap-2 border-t border-white/10 bg-amber-300/8 px-5 py-3 text-[11px] font-semibold leading-relaxed text-amber-100/70">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>상·하류권은 유역 내 관측지점 고도 기준이며, 침수·홍수 발생 예측이 아닙니다.</span>
          </div>
        </aside>
      ) : null}

      {workspaceMode !== 'record' ? (
        <div className="pointer-events-none absolute bottom-2 left-5 z-20 text-[9px] font-semibold text-white/45">
          지형 AWS Terrain Tiles · 유역/하천 VWorld · 바람 기상청 API허브
        </div>
      ) : null}
    </>
  );
}

export default TerrainRainOverlay;
