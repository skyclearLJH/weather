import { useEffect, useRef } from 'react';

const KOREA_WIND_BOUNDS = {
  west: 124.2,
  east: 131.2,
  south: 32.8,
  north: 39.2,
};
const GRID_COLUMNS = 42;
const GRID_ROWS = 36;
const MAX_PARTICLES = 430;
const MIN_PARTICLES = 180;
const PARTICLE_AREA = 4100;
const PARTICLE_MAX_AGE = 150;
const VISUAL_TIME_SCALE = 1900;
const METERS_PER_LATITUDE_DEGREE = 111_320;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const vectorFromMeteorologicalWind = (point) => {
  const radians = (point.direction * Math.PI) / 180;
  return {
    u: -point.speed * Math.sin(radians),
    v: -point.speed * Math.cos(radians),
  };
};

const buildWindGrid = (points) => {
  const vectors = points.map((point) => ({ ...point, ...vectorFromMeteorologicalWind(point) }));
  const nodes = new Array(GRID_COLUMNS * GRID_ROWS);
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const lat =
      KOREA_WIND_BOUNDS.south +
      (row / (GRID_ROWS - 1)) * (KOREA_WIND_BOUNDS.north - KOREA_WIND_BOUNDS.south);
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const lon =
        KOREA_WIND_BOUNDS.west +
        (column / (GRID_COLUMNS - 1)) * (KOREA_WIND_BOUNDS.east - KOREA_WIND_BOUNDS.west);
      let weightSum = 0;
      let u = 0;
      let v = 0;
      vectors.forEach((point) => {
        const dx = (point.lon - lon) * Math.cos((lat * Math.PI) / 180);
        const dy = point.lat - lat;
        const distanceSquared = dx * dx + dy * dy + 0.018;
        const weight = 1 / (distanceSquared * distanceSquared);
        weightSum += weight;
        u += point.u * weight;
        v += point.v * weight;
      });
      const normalizedU = weightSum > 0 ? u / weightSum : 0;
      const normalizedV = weightSum > 0 ? v / weightSum : 0;
      nodes[row * GRID_COLUMNS + column] = {
        u: normalizedU,
        v: normalizedV,
        speed: Math.hypot(normalizedU, normalizedV),
      };
    }
  }
  return nodes;
};

const sampleWind = (grid, lon, lat) => {
  if (
    lon < KOREA_WIND_BOUNDS.west ||
    lon > KOREA_WIND_BOUNDS.east ||
    lat < KOREA_WIND_BOUNDS.south ||
    lat > KOREA_WIND_BOUNDS.north
  ) {
    return null;
  }
  const x =
    ((lon - KOREA_WIND_BOUNDS.west) /
      (KOREA_WIND_BOUNDS.east - KOREA_WIND_BOUNDS.west)) *
    (GRID_COLUMNS - 1);
  const y =
    ((lat - KOREA_WIND_BOUNDS.south) /
      (KOREA_WIND_BOUNDS.north - KOREA_WIND_BOUNDS.south)) *
    (GRID_ROWS - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(GRID_COLUMNS - 1, x0 + 1);
  const y1 = Math.min(GRID_ROWS - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = grid[y0 * GRID_COLUMNS + x0];
  const b = grid[y0 * GRID_COLUMNS + x1];
  const c = grid[y1 * GRID_COLUMNS + x0];
  const d = grid[y1 * GRID_COLUMNS + x1];
  const interpolate = (key) =>
    (a[key] * (1 - tx) + b[key] * tx) * (1 - ty) +
    (c[key] * (1 - tx) + d[key] * tx) * ty;
  return { u: interpolate('u'), v: interpolate('v'), speed: interpolate('speed') };
};

const particleColor = (speed) => {
  if (speed >= 12) return 'rgba(251,113,133,0.9)';
  if (speed >= 7) return 'rgba(250,204,21,0.86)';
  if (speed >= 3) return 'rgba(125,211,252,0.82)';
  return 'rgba(224,242,254,0.7)';
};

function WindParticleOverlay({ active, mapRef, points }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!active || !canvas || !map || points.length < 4) return undefined;

    const context = canvas.getContext('2d');
    const windGrid = buildWindGrid(points);
    let animationFrame = 0;
    let previousTime = performance.now();
    let particles = [];
    let pixelRatio = 1;

    const visibleBounds = () => {
      const bounds = map.getBounds();
      return {
        west: clamp(bounds.getWest(), KOREA_WIND_BOUNDS.west, KOREA_WIND_BOUNDS.east),
        east: clamp(bounds.getEast(), KOREA_WIND_BOUNDS.west, KOREA_WIND_BOUNDS.east),
        south: clamp(bounds.getSouth(), KOREA_WIND_BOUNDS.south, KOREA_WIND_BOUNDS.north),
        north: clamp(bounds.getNorth(), KOREA_WIND_BOUNDS.south, KOREA_WIND_BOUNDS.north),
      };
    };

    const resetParticle = (particle, randomAge = false) => {
      const bounds = visibleBounds();
      const west = bounds.west < bounds.east ? bounds.west : KOREA_WIND_BOUNDS.west;
      const east = bounds.west < bounds.east ? bounds.east : KOREA_WIND_BOUNDS.east;
      const south = bounds.south < bounds.north ? bounds.south : KOREA_WIND_BOUNDS.south;
      const north = bounds.south < bounds.north ? bounds.north : KOREA_WIND_BOUNDS.north;
      particle.lon = west + Math.random() * (east - west);
      particle.lat = south + Math.random() * (north - south);
      particle.age = randomAge ? Math.floor(Math.random() * PARTICLE_MAX_AGE) : 0;
      particle.maxAge = PARTICLE_MAX_AGE * (0.65 + Math.random() * 0.7);
    };

    const resize = () => {
      const container = map.getContainer();
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      const count = clamp(Math.round((width * height) / PARTICLE_AREA), MIN_PARTICLES, MAX_PARTICLES);
      particles = Array.from({ length: count }, () => {
        const particle = {};
        resetParticle(particle, true);
        return particle;
      });
    };

    const clearTrails = () => {
      const width = canvas.width / pixelRatio;
      const height = canvas.height / pixelRatio;
      context.clearRect(0, 0, width, height);
    };

    const draw = (now) => {
      const elapsedSeconds = Math.min(0.05, Math.max(0.008, (now - previousTime) / 1000));
      previousTime = now;
      const width = canvas.width / pixelRatio;
      const height = canvas.height / pixelRatio;
      context.globalCompositeOperation = 'destination-in';
      context.fillStyle = 'rgba(0,0,0,0.9)';
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
      context.lineCap = 'round';
      context.lineWidth = 1.35;

      particles.forEach((particle) => {
        const wind = sampleWind(windGrid, particle.lon, particle.lat);
        if (!wind || wind.speed < 0.15 || particle.age >= particle.maxAge) {
          resetParticle(particle);
          return;
        }
        const previous = map.project([particle.lon, particle.lat]);
        const simulatedSeconds = elapsedSeconds * VISUAL_TIME_SCALE;
        const cosine = Math.max(0.35, Math.cos((particle.lat * Math.PI) / 180));
        const nextLon =
          particle.lon + (wind.u * simulatedSeconds) / (METERS_PER_LATITUDE_DEGREE * cosine);
        const nextLat = particle.lat + (wind.v * simulatedSeconds) / METERS_PER_LATITUDE_DEGREE;
        const next = map.project([nextLon, nextLat]);
        if (
          next.x < -20 ||
          next.x > width + 20 ||
          next.y < -20 ||
          next.y > height + 20 ||
          !Number.isFinite(next.x) ||
          !Number.isFinite(next.y)
        ) {
          resetParticle(particle);
          return;
        }
        context.strokeStyle = particleColor(wind.speed);
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(next.x, next.y);
        context.stroke();
        particle.lon = nextLon;
        particle.lat = nextLat;
        particle.age += 1;
      });
      animationFrame = window.requestAnimationFrame(draw);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(map.getContainer());
    map.on('movestart', clearTrails);
    animationFrame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      map.off('movestart', clearTrails);
      clearTrails();
    };
  }, [active, mapRef, points]);

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none absolute inset-0 z-[12] transition-opacity duration-300 ${
        active ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden="true"
    />
  );
}

export default WindParticleOverlay;
