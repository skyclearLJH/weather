// GK2A(천리안2A) IR105 위성 영상 데이터 모듈 (방송모드 위성 뷰 전용).
//
// 데이터: /api/gk2a-ir 함수가 LE1B IR105 동아시아(EA) NetCDF를 750x650 uint16 DN
// 격자로 다운샘플해 준다. 격자는 레이더와 동일한 WGS84 타원체 LCC(표준위선
// 30/60N, 원점 38N/126E)이며 EA 도메인은 원점 기준 easting -2999~+2999km,
// northing +2599~-2599km (row 0 = 북쪽), 원해상도 2km → 다운샘플 후 8km.
//
// DN → 휘도온도(BT) 변환: LE1B FD 원본 파일의 공식 검정계수 사용
// (gk2a_ami_le1b_ir105_fd020ge_202607180500.nc 속성에서 추출).

export const SAT_GRID = {
  width: 750,
  height: 650,
  cellKm: 8,
  // 셀 중심 기준 LCC km 좌표 (원점 126E/38N)
  xMinKm: -2999 + 3, // upper_left_easting -2999km + (8km 셀 중심 보정 - 원본 1km 픽셀중심)
  yMaxKm: 2599 - 3,
};

// --- DN → 휘도온도(K) ---
const DN2RAD_GAIN = -0.0198196955025196;
const DN2RAD_OFFSET = 161.580139160156;
const PLANCK_H = 6.62606957e-34;
const LIGHT_SPEED = 299792458;
const BOLTZMANN_K = 1.3806488e-23;
const WAVENUMBER = 1e6 / 10.5; // 중심파장 10.5um -> m^-1
const TEFF_C0 = -0.142866448475177;
const TEFF_C1 = 1.00064069572049;
const TEFF_C2 = -5.50443294960498e-7;

const buildBtLut = () => {
  const lut = new Float32Array(8192);
  for (let dn = 0; dn < 8192; dn++) {
    const radiance = (DN2RAD_GAIN * dn + DN2RAD_OFFSET) * 1e-5;
    if (radiance <= 0) {
      lut[dn] = NaN;
      continue;
    }
    const teff =
      ((PLANCK_H * LIGHT_SPEED) / BOLTZMANN_K) * WAVENUMBER /
      Math.log((2 * PLANCK_H * LIGHT_SPEED * LIGHT_SPEED * WAVENUMBER ** 3) / radiance + 1);
    lut[dn] = TEFF_C0 + TEFF_C1 * teff + TEFF_C2 * teff * teff;
  }
  return lut;
};

export const DN_TO_BT_KELVIN = buildBtLut();

// --- LCC 역투영 (km → 위경도) : radarApi와 동일 파라미터 ---
const DEG = Math.PI / 180;
const A = 6378137.0;
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
const N =
  (Math.log(lccM(SP1)) - Math.log(lccM(SP2))) / (Math.log(lccT(SP1)) - Math.log(lccT(SP2)));
const F = lccM(SP1) / (N * lccT(SP1) ** N);
const RHO0 = A * F * lccT(LAT0) ** N;

export const lccKmToLonLat = (xKm, yKm) => {
  const x = xKm * 1000;
  const y = yKm * 1000;
  const rho = Math.sign(N) * Math.hypot(x, RHO0 - y);
  const theta = Math.atan2(x, RHO0 - y);
  const lon = (theta / N + LON0) / DEG;
  const t = (rho / (A * F)) ** (1 / N);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 6; i++) {
    phi =
      Math.PI / 2 -
      2 * Math.atan(t * ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2));
  }
  return [lon, phi / DEG];
};

// --- 시각 유틸 (관측 시각은 UTC 10분 단위) ---
const pad2 = (v) => String(v).padStart(2, '0');

export const formatSatDateUtc = (date) =>
  `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}`;

export const parseSatDateUtc = (value) =>
  new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
      Number(value.slice(8, 10)),
      Number(value.slice(10, 12)),
    ),
  );

export const floorToTenMinutesUtc = (date) => {
  const floored = new Date(date);
  floored.setUTCMinutes(Math.floor(floored.getUTCMinutes() / 10) * 10, 0, 0);
  return floored;
};

// 과거 12시간 타임라인 (오래된 것 → 최신 순, 10분 간격)
export const buildSatTimeline = (latestDate, hours = 12, stepMinutes = 10) => {
  const frames = [];
  const count = Math.floor((hours * 60) / stepMinutes);
  for (let i = count; i >= 0; i--) {
    frames.push(new Date(latestDate.getTime() - i * stepMinutes * 60 * 1000));
  }
  return frames;
};

// --- 프레임 로드 ---
const FRAME_CACHE = new Map();
const FRAME_CACHE_LIMIT = 90;

export const fetchSatFrame = async (dateUtc) => {
  const key = formatSatDateUtc(dateUtc);
  if (FRAME_CACHE.has(key)) {
    return FRAME_CACHE.get(key);
  }

  const promise = (async () => {
    const response = await fetch(`/api/gk2a-ir?date=${key}`, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      let message = `위성 자료 요청 실패 (${response.status})`;
      try {
        const detail = await response.json();
        if (response.status === 403 && detail?.error) {
          message = detail.error;
        } else if (response.status === 404) {
          message = '아직 준비되지 않은 시각입니다.';
        }
      } catch {
        // 본문이 JSON이 아니면 기본 메시지 유지
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8 || bytes[0] !== 0x47 || bytes[1] !== 0x4b || bytes[2] !== 0x49 || bytes[3] !== 0x52) {
      throw new Error('위성 자료 형식 오류');
    }
    const head = new DataView(buffer);
    const width = head.getUint16(4, true);
    const height = head.getUint16(6, true);
    // 8바이트 헤더 뒤 uint16 — 홀수 오프셋 아님이 보장되므로 직접 뷰 생성
    const data = new Uint16Array(buffer, 8, width * height);
    return { key, date: dateUtc, width, height, data };
  })();

  FRAME_CACHE.set(key, promise);
  promise.catch(() => FRAME_CACHE.delete(key));
  if (FRAME_CACHE.size > FRAME_CACHE_LIMIT) {
    const oldest = FRAME_CACHE.keys().next().value;
    FRAME_CACHE.delete(oldest);
  }
  return promise;
};

// 최신 발표 시각 탐색: 지금부터 거꾸로 최대 12슬롯(2시간) 시도
export const probeLatestSatDate = async () => {
  // 원본 생성 지연(관측 후 수 분)을 고려해 15분 전부터 시작
  let candidate = floorToTenMinutesUtc(new Date(Date.now() - 15 * 60 * 1000));
  for (let i = 0; i < 12; i++) {
    try {
      await fetchSatFrame(candidate);
      return candidate;
    } catch {
      candidate = new Date(candidate.getTime() - 10 * 60 * 1000);
    }
  }
  throw new Error('최근 위성 자료를 찾지 못했습니다.');
};
