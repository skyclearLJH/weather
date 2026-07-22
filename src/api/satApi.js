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

// 정투영 (위경도 → LCC km): FD 셀이 EA 도메인 안쪽인지 판정할 때 사용
export const lonLatToLccKm = (lon, lat) => {
  const phi = lat * DEG;
  const rho = A * F * lccT(phi) ** N;
  const theta = N * (lon * DEG - LON0);
  return [(rho * Math.sin(theta)) / 1000, (RHO0 - rho * Math.cos(theta)) / 1000];
};

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

// --- 전구(FD) GEOS 격자 ---
// 원본 5500x5500(2km)을 서버가 11x11 블록 최대로 500x500으로 다운샘플.
// 투영 상수는 gk2a_ami_le1b_ir105_fd020ge_202607180500.nc 전역 속성에서 추출.
export const FD_GRID = { width: 500, height: 500, factor: 11 };

const FD_CFAC = 20425338.903339352;
const FD_LFAC = -20425338.903339352;
const FD_COFF = 2750.5;
const FD_LOFF = 2750.5;
const FD_SUBLON_RAD = 2.2375121010567303; // 128.2°E
const FD_H_KM = 42164.0; // 지구 중심으로부터 위성 거리
const FD_RAT = 1.006739501; // (적도반경/극반경)^2
const FD_SN_CONST = 1737122264; // H^2 - 적도반경^2 (km^2)
const SCALE_16 = 65536;

// GEOS 역투영: FD 원본 픽셀 좌표 → [lon, lat] 또는 null(디스크 밖)
// 스캔각: line 0 = 북쪽(lfac 음수), col 0 = 서쪽
export const geosPixelToLonLat = (srcCol, srcRow) => {
  const x = ((srcCol - FD_COFF) * SCALE_16) / FD_CFAC * DEG;
  const y = ((srcRow - FD_LOFF) * SCALE_16) / FD_LFAC * DEG;
  const cosx = Math.cos(x);
  const cosy = Math.cos(y);
  const sinx = Math.sin(x);
  const siny = Math.sin(y);
  const denom = cosy * cosy + FD_RAT * siny * siny;
  const sd2 = FD_H_KM * cosx * cosy * (FD_H_KM * cosx * cosy) - denom * FD_SN_CONST;
  if (sd2 < 0) return null; // 지구 디스크 밖
  const sn = (FD_H_KM * cosx * cosy - Math.sqrt(sd2)) / denom;
  const s1 = FD_H_KM - sn * cosx * cosy;
  const s2 = sn * sinx * cosy;
  const s3 = sn * siny; // y 양수 = 북쪽
  const sxy = Math.hypot(s1, s2);
  const lon = (Math.atan2(s2, s1) + FD_SUBLON_RAD) / DEG;
  const lat = Math.atan((FD_RAT * s3) / sxy) / DEG;
  return [lon, lat];
};

export const fdCellToLonLat = (col, row) =>
  geosPixelToLonLat(
    col * FD_GRID.factor + (FD_GRID.factor - 1) / 2,
    row * FD_GRID.factor + (FD_GRID.factor - 1) / 2,
  );

// --- 동아시아 정밀 크롭(KO) 격자 ---
// FD 원본 2km에서 (1071,354)부터 3618x2132 픽셀을 2x2 블록최대(4km)로 잘라
// 1809x1066으로 제공 (대략 lon 95~168E / lat 5~55N, 기상청 EA 섹터 상당).
// 서버 gk2a-ir.js의 KO_CROP과 반드시 일치. 클라이언트는 이 격자를 3D 메쉬가
// 아니라 텍스처로 입혀 렌더하므로(정점 수와 분리) 고해상도도 가볍게 그린다.
export const KO_GRID = { width: 1809, height: 1066, col0: 1071, row0: 354, factor: 2 };

export const koCellToLonLat = (col, row) =>
  geosPixelToLonLat(
    KO_GRID.col0 + col * KO_GRID.factor + (KO_GRID.factor - 1) / 2,
    KO_GRID.row0 + row * KO_GRID.factor + (KO_GRID.factor - 1) / 2,
  );

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
// GK2A는 매일 15:20 UTC(=00:20 KST) 한 슬롯만 전구 관측을 건너뛴다(위성 정비 시간).
// NOAA 버킷 하루치(144슬롯)를 훑어 이 슬롯만 항상 비어 있음을 확인했다. 앞으로도
// 생기지 않는 자료라 타임라인에서 아예 제외한다 — 그대로 두면 재생이 그 지점에서
// 끊기고 "아직 준비되지 않은 시각입니다"가 잘못 뜬다.
const SAT_DAILY_GAP_UTC = { hour: 15, minute: 20 };

export const isSatGapSlot = (date) =>
  date.getUTCHours() === SAT_DAILY_GAP_UTC.hour &&
  date.getUTCMinutes() === SAT_DAILY_GAP_UTC.minute;

export const buildSatTimeline = (latestDate, hours = 12, stepMinutes = 10) => {
  const frames = [];
  const count = Math.floor((hours * 60) / stepMinutes);
  for (let i = count; i >= 0; i--) {
    const frame = new Date(latestDate.getTime() - i * stepMinutes * 60 * 1000);
    if (isSatGapSlot(frame)) {
      continue;
    }
    frames.push(frame);
  }
  return frames;
};

// --- 프레임 로드 ---
const FRAME_CACHE = new Map();
const FRAME_CACHE_LIMIT = 220;
const PAIR_CACHE = new Map();
const PAIR_CACHE_LIMIT = 90;
const BUNDLE_CACHE = new Map();
const BUNDLE_CACHE_LIMIT = 30;

// 응답 매직: EA는 'GKIR', FD는 'GKFD', KO는 'GKKO'
const FRAME_MAGIC = {
  ea: [0x47, 0x4b, 0x49, 0x52],
  fd: [0x47, 0x4b, 0x46, 0x44],
  ko: [0x47, 0x4b, 0x4b, 0x4f],
};

const rememberPromise = (cache, key, promise, limit) => {
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  while (cache.size > limit) {
    cache.delete(cache.keys().next().value);
  }
  return promise;
};

const parseAreaFrame = (input, area, dateUtc) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const magic = FRAME_MAGIC[area];
  if (
    bytes.length < 8 ||
    bytes[0] !== magic[0] ||
    bytes[1] !== magic[1] ||
    bytes[2] !== magic[2] ||
    bytes[3] !== magic[3]
  ) {
    throw new Error('위성 자료 형식 오류');
  }
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = head.getUint16(4, true);
  const height = head.getUint16(6, true);
  if (8 + width * height * 2 !== bytes.length) {
    throw new Error('위성 자료 길이 오류');
  }
  const data = new Uint16Array(bytes.buffer, bytes.byteOffset + 8, width * height);
  return {
    key: `${area}:${formatSatDateUtc(dateUtc)}`,
    date: dateUtc,
    width,
    height,
    data,
  };
};

const parsePairFrame = (input, dateUtc) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (
    bytes.length < 16 ||
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x53 ||
    bytes[3] !== 0x50
  ) {
    throw new Error('위성 묶음 자료 형식 오류');
  }
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const koLength = head.getUint32(4, true);
  const fdLength = head.getUint32(8, true);
  if (16 + koLength + fdLength !== bytes.length) {
    throw new Error('위성 묶음 자료 길이 오류');
  }
  const koBytes = bytes.slice(16, 16 + koLength);
  const fdBytes = bytes.slice(16 + koLength);
  return {
    key: formatSatDateUtc(dateUtc),
    date: dateUtc,
    ko: parseAreaFrame(koBytes, 'ko', dateUtc),
    fd: parseAreaFrame(fdBytes, 'fd', dateUtc),
  };
};

const gunzipFrame = async (bytes) => {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('이 브라우저는 위성 압축 자료를 지원하지 않습니다.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const bundleStartFor = (dateUtc) => {
  const start = new Date(dateUtc);
  start.setUTCMinutes(start.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  return formatSatDateUtc(start);
};

const parseBundle = async (buffer) => {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x53 ||
    bytes[3] !== 0x42 ||
    bytes[4] !== 1
  ) {
    throw new Error('위성 30분 묶음 자료 형식 오류');
  }
  const count = bytes[5];
  const head = new DataView(buffer);
  let payloadOffset = 8 + count * 16;
  const frames = new Map();
  for (let index = 0; index < count; index++) {
    const descriptorOffset = 8 + index * 16;
    let date = '';
    for (let i = 0; i < 12; i++) {
      date += String.fromCharCode(bytes[descriptorOffset + i]);
    }
    const length = head.getUint32(descriptorOffset + 12, true);
    if (!/^\d{12}$/.test(date) || payloadOffset + length > bytes.length) {
      throw new Error('위성 30분 묶음 자료 길이 오류');
    }
    const compressed = bytes.slice(payloadOffset, payloadOffset + length);
    const raw = await gunzipFrame(compressed);
    frames.set(date, parsePairFrame(raw, parseSatDateUtc(date)));
    payloadOffset += length;
  }
  return frames;
};

const fetchSatBundle = (bundleStart) => {
  if (BUNDLE_CACHE.has(bundleStart)) return BUNDLE_CACHE.get(bundleStart);
  const promise = (async () => {
    const response = await fetch(`/api/gk2a-ir?bundle=${bundleStart}`, {
      signal: AbortSignal.timeout(90000),
    });
    if (response.status === 404) return new Map();
    if (!response.ok) throw new Error(`위성 묶음 자료 요청 실패 (${response.status})`);
    return parseBundle(await response.arrayBuffer());
  })();
  return rememberPromise(BUNDLE_CACHE, bundleStart, promise, BUNDLE_CACHE_LIMIT);
};

const fetchDirectPair = async (dateUtc) => {
  const date = formatSatDateUtc(dateUtc);
  const response = await fetch(`/api/gk2a-ir?date=${date}&area=pair`, {
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    let message = `위성 자료 요청 실패 (${response.status})`;
    try {
      const detail = await response.json();
      if (response.status === 404) message = '아직 준비되지 않은 시각입니다.';
      else if (detail?.error) message = detail.error;
    } catch {
      // 본문이 JSON이 아니면 기본 메시지 유지
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return parsePairFrame(await response.arrayBuffer(), dateUtc);
};

export const fetchSatFramePair = (dateUtc, preferSingle = false) => {
  const key = formatSatDateUtc(dateUtc);
  if (PAIR_CACHE.has(key)) return PAIR_CACHE.get(key);
  const promise = (async () => {
    if (preferSingle) return fetchDirectPair(dateUtc);
    try {
      const bundle = await fetchSatBundle(bundleStartFor(dateUtc));
      const bundled = bundle.get(key);
      if (bundled) return bundled;
    } catch {
      // 묶음 캐시가 없거나 손상됐으면 기존 단일 시각 경로로 즉시 대체한다.
    }
    return fetchDirectPair(dateUtc);
  })();
  return rememberPromise(PAIR_CACHE, key, promise, PAIR_CACHE_LIMIT);
};

export const fetchSatFrame = async (dateUtc, area = 'ea') => {
  if (area === 'ko' || area === 'fd') {
    const pair = await fetchSatFramePair(dateUtc);
    return pair[area];
  }
  const key = `${area}:${formatSatDateUtc(dateUtc)}`;
  if (FRAME_CACHE.has(key)) {
    return FRAME_CACHE.get(key);
  }

  const promise = (async () => {
    const response = await fetch(`/api/gk2a-ir?date=${formatSatDateUtc(dateUtc)}&area=${area}`, {
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
    return parseAreaFrame(await response.arrayBuffer(), area, dateUtc);
  })();

  return rememberPromise(FRAME_CACHE, key, promise, FRAME_CACHE_LIMIT);
};

// 최신 발표 시각 조회: 서버가 NOAA 목록만 읽어 즉시(수백 ms) 응답한다.
// 실패하면 예전 방식(프레임을 하나씩 받아보는 순차 탐색)으로 폴백.
export const probeLatestSatDate = async () => {
  try {
    const response = await fetch('/api/gk2a-ir?latest=1', {
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const { latest, cachedLatest } = await response.json();
      const readyLatest = /^\d{12}$/.test(cachedLatest ?? '') ? cachedLatest : latest;
      if (/^\d{12}$/.test(readyLatest ?? '')) {
        return parseSatDateUtc(readyLatest);
      }
    }
  } catch {
    // 목록 조회 실패 시 폴백
  }

  // 폴백: 원본 생성 지연(~12분)을 고려해 15분 전부터 거꾸로 최대 12슬롯 시도
  let candidate = floorToTenMinutesUtc(new Date(Date.now() - 15 * 60 * 1000));
  for (let i = 0; i < 12; i++) {
    if (isSatGapSlot(candidate)) {
      // 매일 비는 슬롯은 시도하지 않고 건너뛴다
      candidate = new Date(candidate.getTime() - 10 * 60 * 1000);
      continue;
    }
    try {
      await fetchSatFrame(candidate, 'ko');
      return candidate;
    } catch {
      candidate = new Date(candidate.getTime() - 10 * 60 * 1000);
    }
  }
  throw new Error('최근 위성 자료를 찾지 못했습니다.');
};
