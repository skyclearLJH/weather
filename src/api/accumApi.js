// 방송모드 'n일 누적 강수량' 데이터 모듈.
//
// 데이터 구성: AWS 시간통계(awsh.php)의 RN_DAY(그날 0시~해당 정시 누적)와
// 일자료(sfc_aws_day, rn_day)의 일합계를 조합한다. 기간 내 임의 정시 T의
// 누적 = (T 이전 완결 일들의 일합계 합) + (T 시각의 RN_DAY).
const KMA_PROXY_BASE = '/api/kma/';

// 누적 강수 팔레트(시안): 낮은 값은 단계를 촘촘히, 높은 값은 성기게.
// 주요 경계 10/30/100/200/300/500/700에서 색 계열이 바뀐다. (단위 mm)
export const ACCUM_PALETTE = [
  { min: 0.1, color: [255, 246, 170] }, // 연노랑
  { min: 2, color: [252, 231, 80] },
  { min: 5, color: [243, 205, 22] },
  { min: 10, color: [154, 219, 90] }, // 연두 →
  { min: 20, color: [76, 188, 64] },
  { min: 30, color: [64, 187, 227] }, // 하늘 →
  { min: 50, color: [38, 137, 222] },
  { min: 70, color: [23, 87, 196] },
  { min: 100, color: [126, 106, 224] }, // 보라 →
  { min: 130, color: [156, 72, 213] },
  { min: 160, color: [199, 60, 195] },
  { min: 200, color: [239, 84, 84] }, // 빨강 →
  { min: 250, color: [229, 44, 44] },
  { min: 300, color: [193, 18, 18] },
  { min: 400, color: [148, 7, 7] },
  { min: 500, color: [102, 2, 2] },
  { min: 700, color: [58, 58, 66] }, // 700 이상 진회
];

// 스케일바에 굵게 표기할 주요 경계
export const ACCUM_MAJOR_BREAKS = [10, 30, 100, 200, 300, 500, 700];
export const ACCUM_SCALE_TOP = 1000;

export const accumBucket = (mm) => {
  let bucket = 0;
  for (let index = 0; index < ACCUM_PALETTE.length; index++) {
    if (mm >= ACCUM_PALETTE[index].min) {
      bucket = index + 1;
    } else {
      break;
    }
  }
  return bucket;
};

const pad2 = (value) => String(value).padStart(2, '0');
export const formatAccumHourTm = (date) =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}00`;
const formatDay = (date) =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;

const fetchKmaLines = async (path, params) => {
  const url = new URL(`${KMA_PROXY_BASE}${path}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    throw new Error(`관측 자료 요청 실패 (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder('euc-kr').decode(buffer);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
};

// AWS 지점 좌표 (STN_ID, LON, LAT가 앞 세 컬럼)
let stationCoordsPromise = null;
export const fetchAwsStationCoords = () => {
  if (!stationCoordsPromise) {
    stationCoordsPromise = fetchKmaLines('api/typ01/url/stn_inf.php', {
      inf: 'AWS',
      stn: '',
      tm: '',
      help: 1,
    })
      .then((lines) => {
        const stations = [];
        lines.forEach((line) => {
          const fields = line.split(/\s+/);
          if (fields.length < 3) {
            return;
          }
          const lon = Number.parseFloat(fields[1]);
          const lat = Number.parseFloat(fields[2]);
          if (Number.isFinite(lon) && Number.isFinite(lat) && lon > 100 && lat > 20) {
            stations.push({ id: fields[0], lon, lat });
          }
        });
        if (stations.length < 100) {
          throw new Error('AWS 지점 정보를 불러오지 못했습니다.');
        }
        return stations;
      })
      .catch((error) => {
        stationCoordsPromise = null;
        throw error;
      });
  }
  return stationCoordsPromise;
};

// 특정 정시의 지점별 RN_DAY (그날 0시~해당 시각 누적, mm). -99 등 결측은 제외.
export const fetchHourlyRnDay = async (hourDate) => {
  const lines = await fetchKmaLines('api/typ01/url/awsh.php', {
    var: 'RN',
    tm: formatAccumHourTm(hourDate),
    help: 1,
  });
  const byStation = new Map();
  lines.forEach((line) => {
    const fields = line.split(/\s+/);
    if (fields.length < 5 || !/^\d{12}$/.test(fields[0])) {
      return;
    }
    const value = Number.parseFloat(fields[4]);
    if (Number.isFinite(value) && value >= 0) {
      byStation.set(fields[1], value);
    }
  });
  if (byStation.size < 50) {
    throw new Error('시간통계 자료가 아직 준비되지 않았습니다.');
  }
  return byStation;
};

// 완결된 하루의 지점별 일강수량 합계 (mm)
export const fetchDailyRnTotal = async (dayDate) => {
  const lines = await fetchKmaLines('api/typ01/url/sfc_aws_day.php', {
    tm2: formatDay(dayDate),
    obs: 'rn_day',
    stn: 0,
    disp: 0,
    help: 0,
  });
  const byStation = new Map();
  lines.forEach((line) => {
    const fields = line.split(/\s+/);
    if (fields.length < 6) {
      return;
    }
    const value = Number.parseFloat(fields[5]);
    if (Number.isFinite(value) && value >= 0) {
      byStation.set(fields[1], value);
    }
  });
  if (byStation.size < 50) {
    throw new Error('일강수 자료를 불러오지 못했습니다.');
  }
  return byStation;
};
