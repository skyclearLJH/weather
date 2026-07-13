// 레이더 실황(HSP 합성 강수)과 초단기 강수예측(QPF 분포도) 데이터 모듈.
//
// 좌표계: 기상청 레이더 합성 격자는 WGS84 타원체 람베르트 정형원추(LCC,
// 표준위선 30/60N, 원점 38N/126E) 투영이며, (126E,38N)이 격자 (1120,1680)에
// 온다. nph-rdr_latlon_api 실측 격자 모서리와 5m 이내로 일치함을 확인했다.
const KMA_PROXY_BASE = '/api/kma/';

// --- LCC 순방향 투영 (위경도 → km) ---
const DEG = Math.PI / 180;
const ELLIPSOID_A = 6378137.0;
const E2 = 0.00669437999014;
const E = Math.sqrt(E2);
const SP1 = 30 * DEG;
const SP2 = 60 * DEG;
const LAT0 = 38 * DEG;
const LON0 = 126 * DEG;

const lccM = (phi) => Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
const lccT = (phi) =>
  Math.tan(Math.PI / 4 - phi / 2) /
  ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2);

const LCC_N =
  (Math.log(lccM(SP1)) - Math.log(lccM(SP2))) / (Math.log(lccT(SP1)) - Math.log(lccT(SP2)));
const LCC_F = lccM(SP1) / (LCC_N * lccT(SP1) ** LCC_N);
const LCC_RHO0 = ELLIPSOID_A * LCC_F * lccT(LAT0) ** LCC_N;

export const lonLatToLccKm = (lon, lat) => {
  const rho = ELLIPSOID_A * LCC_F * lccT(lat * DEG) ** LCC_N;
  const theta = LCC_N * (lon * DEG - LON0);
  return [(rho * Math.sin(theta)) / 1000, (LCC_RHO0 - rho * Math.cos(theta)) / 1000];
};

// 대량 픽셀 매핑용: rho는 위도에만, theta는 경도에만 의존하므로 분리 계산한다.
export const lccRhoKm = (lat) => (ELLIPSOID_A * LCC_F * lccT(lat * DEG) ** LCC_N) / 1000;
export const lccTheta = (lon) => LCC_N * (lon * DEG - LON0);
export const LCC_RHO0_KM = LCC_RHO0 / 1000;

// --- 레이더 HSP 격자 상수 ---
// rdr_cmp_file.php(data=bin, cmp=hsp): gzip → 1024B 헤더 + Int16LE, j=0이 남쪽.
// 값/100 = mm/h, -30000 = 관측영역 밖, -25000 = 무강수.
export const RADAR_GRID = {
  nx: 2305,
  ny: 2881,
  cellKm: 0.5,
  originI: 1120, // (126E, 38N)의 격자 위치
  originJ: 1680,
  headerBytes: 1024,
};

// 렌더링·캐시 메모리를 줄이기 위한 격자 축소 배율(2 → 1km 해상도)
export const RADAR_DOWNSAMPLE = 2;

// --- 강수 팔레트 (기상청 분포도 범례에서 추출, mm/h 미만 경계 오름차순) ---
export const RAIN_PALETTE = [
  { min: 0.1, color: [0, 200, 255] },
  { min: 0.5, color: [0, 155, 245] },
  { min: 1, color: [0, 74, 245] },
  { min: 2, color: [0, 255, 0] },
  { min: 3, color: [0, 190, 0] },
  { min: 4, color: [0, 140, 0] },
  { min: 5, color: [0, 90, 0] },
  { min: 6, color: [255, 255, 0] },
  { min: 7, color: [255, 220, 31] },
  { min: 8, color: [249, 205, 0] },
  { min: 9, color: [224, 185, 0] },
  { min: 10, color: [204, 170, 0] },
  { min: 15, color: [255, 102, 0] },
  { min: 20, color: [255, 50, 0] },
  { min: 25, color: [210, 0, 0] },
  { min: 30, color: [180, 0, 0] },
  { min: 40, color: [224, 169, 255] },
  { min: 50, color: [201, 105, 255] },
  { min: 60, color: [179, 41, 255] },
  { min: 70, color: [147, 0, 228] },
  { min: 90, color: [179, 180, 222] },
  { min: 110, color: [76, 78, 177] },
  { min: 150, color: [0, 3, 144] },
];

const rainBucket = (mmPerHour) => {
  let bucket = 0;
  for (let index = 0; index < RAIN_PALETTE.length; index++) {
    if (mmPerHour >= RAIN_PALETTE[index].min) {
      bucket = index + 1;
    } else {
      break;
    }
  }
  return bucket;
};

// QPF 색상 → 팔레트 버킷 역매핑 (정확히 같은 RGB로 그려짐)
const QPF_COLOR_TO_BUCKET = new Map(
  RAIN_PALETTE.map(({ color }, index) => [(color[0] << 16) | (color[1] << 8) | color[2], index + 1]),
);

// --- QPF 분포도 이미지의 지리 정합 ---
// 835×820 PNG에서 지도영역은 x 1..798, y 21..818 (798×798).
// 해안선 자동 정합(경계점 4,472개 중 99% 일치)으로 산출한 LCC 경계(km).
export const QPF_IMAGE = {
  cropX: 1,
  cropY: 21,
  cropSize: 798,
  lccXMin: -437.82,
  lccXMax: 584.82,
  lccYMin: -768.32,
  lccYMax: 254.32,
};

// --- 시각 유틸 (KST 기준 문자열) ---
const pad2 = (value) => String(value).padStart(2, '0');

export const formatRadarTm = (date) =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`;

export const parseRadarTm = (tm) =>
  new Date(
    Number(tm.slice(0, 4)),
    Number(tm.slice(4, 6)) - 1,
    Number(tm.slice(6, 8)),
    Number(tm.slice(8, 10)),
    Number(tm.slice(10, 12)),
  );

export const floorToFiveMinutes = (date) => {
  const floored = new Date(date);
  floored.setMinutes(Math.floor(floored.getMinutes() / 5) * 5, 0, 0);
  return floored;
};

export const floorToTenMinutes = (date) => {
  const floored = new Date(date);
  floored.setMinutes(Math.floor(floored.getMinutes() / 10) * 10, 0, 0);
  return floored;
};

// --- 레이더 실황 프레임 ---
const gunzipToArrayBuffer = async (response) => {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text') || contentType.includes('html')) {
    throw new Error('레이더 자료가 아직 준비되지 않았습니다.');
  }

  const compressed = await response.arrayBuffer();
  const bytes = new Uint8Array(compressed);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error('레이더 자료 형식이 올바르지 않습니다.');
  }

  const stream = new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
  );
  return stream.arrayBuffer();
};

// HSP 격자를 내려받아 1/2 축소(최댓값 유지) 버킷 배열로 변환한다.
export const fetchRadarFrame = async (tm) => {
  const url = `${KMA_PROXY_BASE}api/typ04/url/rdr_cmp_file.php?tm=${tm}&data=bin&cmp=hsp`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`레이더 자료 요청 실패 (${response.status})`);
  }

  const raw = await gunzipToArrayBuffer(response);
  const { nx, ny, headerBytes } = RADAR_GRID;
  if (raw.byteLength !== headerBytes + nx * ny * 2) {
    throw new Error('레이더 격자 크기가 예상과 다릅니다.');
  }

  const grid = new Int16Array(raw, headerBytes, nx * ny);
  const scale = RADAR_DOWNSAMPLE;
  const width = Math.floor(nx / scale);
  const height = Math.floor(ny / scale);
  const buckets = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxValue = -30000;
      for (let dy = 0; dy < scale; dy++) {
        const rowBase = (y * scale + dy) * nx + x * scale;
        for (let dx = 0; dx < scale; dx++) {
          const value = grid[rowBase + dx];
          if (value > maxValue) {
            maxValue = value;
          }
        }
      }
      buckets[y * width + x] = maxValue > 0 ? rainBucket(maxValue / 100) : 0;
    }
  }

  return { tm, width, height, buckets };
};

// --- 초단기 예측(QPF) 프레임 ---
// 분포도 PNG의 지도영역에서 강수 색 픽셀만 버킷 배열로 추출한다.
export const fetchQpfFrame = async (tm, efMinutes) => {
  const url = `${KMA_PROXY_BASE}api/typ03/cgi/rdr/nph-qpf_ana_img?tm=${tm}&qpf=B&ef=${efMinutes}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`예측강수 자료 요청 실패 (${response.status})`);
  }

  const blob = await response.blob();
  if (blob.size < 4000) {
    throw new Error('예측강수 자료가 아직 준비되지 않았습니다.');
  }

  const bitmap = await createImageBitmap(blob);
  const { cropX, cropY, cropSize } = QPF_IMAGE;
  const canvas = document.createElement('canvas');
  canvas.width = cropSize;
  canvas.height = cropSize;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);
  bitmap.close();

  const { data } = context.getImageData(0, 0, cropSize, cropSize);
  const buckets = new Uint8Array(cropSize * cropSize);
  for (let index = 0; index < buckets.length; index++) {
    const offset = index * 4;
    const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    buckets[index] = QPF_COLOR_TO_BUCKET.get(key) ?? 0;
  }

  return { tm, ef: efMinutes, size: cropSize, buckets };
};

// 최신 자료 시각 탐색: 후보 시각을 최신부터 시도해 처음 성공하는 프레임을 쓴다.
export const probeLatestRadarTm = async (now = new Date()) => {
  const base = floorToFiveMinutes(now);
  for (let step = 0; step < 6; step++) {
    const candidate = new Date(base.getTime() - step * 5 * 60 * 1000);
    const tm = formatRadarTm(candidate);
    try {
      const frame = await fetchRadarFrame(tm);
      return { tm, frame };
    } catch {
      // 다음 후보 시각으로
    }
  }
  throw new Error('최근 레이더 자료를 찾지 못했습니다.');
};

export const probeLatestQpfTm = async (now = new Date()) => {
  const base = floorToTenMinutes(now);
  for (let step = 0; step < 6; step++) {
    const candidate = new Date(base.getTime() - step * 10 * 60 * 1000);
    const tm = formatRadarTm(candidate);
    try {
      const frame = await fetchQpfFrame(tm, 10);
      return { tm, frame };
    } catch {
      // 다음 후보 시각으로
    }
  }
  throw new Error('최근 예측강수 자료를 찾지 못했습니다.');
};
