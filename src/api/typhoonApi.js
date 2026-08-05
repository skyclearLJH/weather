// 기상청 API허브 태풍정보(typ01) 조회·파싱.
//  - typ_now.php?tm=  : 특정 시각에 활동 중인 태풍 발견(분석행만 제공)
//  - typ_data.php?YY&typ&seq&disp=1 : 해당 발표(seq)의 분석 + 예측(FT=1) 전체
// 응답은 EUC-KR(CP949)이지만 우리가 쓰는 숫자 필드(LAT~RAD)는 LOC(위치 한글) 앞이라
// 콤마 분해만으로 안전하게 읽힌다. disp=1은 콤마 구분(CSV) 형식.

// 프록시(/api/kma/)는 뒤 경로를 apihub.kma.go.kr/ 뒤에 그대로 붙이므로
// apihub 실제 경로인 'api/typ01/url/...'을 포함해야 한다.
const KMA_BASE = '/api/kma/api/typ01/url';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 번호→이름 표(직접 관리). 미등록 태풍은 "제N호 태풍"으로 폴백한다.
// 형식: `${YY}-${TYP}` : { ko, en }
const TYPHOON_NAMES = {
  '2026-13': { ko: '돌핀', en: 'Dolphin' },
  '2026-14': { ko: '구지라', en: 'Kujira' },
  '2026-15': { ko: '찬홈', en: 'Chan-hom' },
};

export const getTyphoonName = (year, number) => TYPHOON_NAMES[`${year}-${number}`] ?? null;

// KMA 태풍 강도 → 숫자 등급 (최대풍속 WS, m/s 기준)
//  약(17~25)=1, 중(25~33)=2, 강(33~44)=3, 매우강(44~54)=4, 초강력(54↑)=5
//  17 미만은 열대저압부(TD)로 등급 없음(null).
export const windToGrade = (ws) => {
  if (!Number.isFinite(ws) || ws < 17) return null;
  if (ws < 25) return 1;
  if (ws < 33) return 2;
  if (ws < 44) return 3;
  if (ws < 54) return 4;
  return 5;
};

export const GRADE_LABELS = { 1: '약', 2: '중', 3: '강', 4: '매우강', 5: '초강력' };

const parseNum = (raw) => {
  const v = Number(raw);
  // 결측 코드(-9, -99, -999 등)와 NaN은 null 처리
  return Number.isFinite(v) && v > -900 ? v : null;
};

// UTC 'YYYYMMDDHHMM' → Date
const parseUtc = (s) => {
  if (!/^\d{12}$/.test(s ?? '')) return null;
  return new Date(
    Date.UTC(
      Number(s.slice(0, 4)),
      Number(s.slice(4, 6)) - 1,
      Number(s.slice(6, 8)),
      Number(s.slice(8, 10)),
      Number(s.slice(10, 12)),
    ),
  );
};

// disp=1 한 줄 → 포인트 객체. 데이터 줄이 아니면 null.
const parseRow = (line) => {
  if (!line || line[0] === '#') return null;
  const f = line.split(',');
  if (f.length < 16) return null;
  const ft = Number(f[0]);
  if (ft !== 0 && ft !== 1) return null;
  const lat = parseNum(f[7]);
  const lon = parseNum(f[8]);
  if (lat === null || lon === null) return null;
  const ws = parseNum(f[12]);
  return {
    ft, // 0=분석(과거/현재), 1=예측
    year: Number(f[1]),
    number: Number(f[2]),
    seq: Number(f[3]),
    tmd: Number(f[4]), // 예측 리드타임(시간)
    analysisTime: parseUtc(f[5]),
    validTime: parseUtc(f[6]),
    lat,
    lon,
    dir: f[9]?.trim() || null,
    speedKmh: parseNum(f[10]),
    pressure: parseNum(f[11]), // 중심기압 hPa
    wind: ws, // 최대풍속 m/s
    rad15: parseNum(f[13]), // 강풍(15m/s) 반경 km
    rad25: parseNum(f[14]), // 폭풍(25m/s) 반경 km
    radProb: parseNum(f[15]), // 70% 확률반경 km (예측행만 유효)
    grade: windToGrade(ws),
  };
};

const fetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`태풍 자료 요청 실패 (${res.status})`);
  return res.text();
};

const fmtTm = (date) => {
  const s = date.toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}${s.slice(11, 13)}00`;
};

// 현재(또는 근접 과거) 시각으로 활동 중인 태풍의 {year, number, seq} 목록을 찾는다.
const discoverActive = async () => {
  const now = new Date();
  // 정시 기준으로 몇 시간 거슬러 올라가며 시도(발표 지연 대비)
  for (const backHours of [0, 3, 6, 12, 24]) {
    const tm = fmtTm(new Date(now.getTime() - backHours * 3600 * 1000));
    let text;
    try {
      text = await fetchText(`${KMA_BASE}/typ_now.php?tm=${tm}&disp=1`);
    } catch {
      continue;
    }
    const rows = text.split(/\r?\n/).map(parseRow).filter(Boolean);
    if (rows.length === 0) continue;
    const byTyp = new Map();
    for (const r of rows) {
      const key = `${r.year}-${r.number}`;
      const prev = byTyp.get(key);
      if (!prev || r.seq > prev.seq) byTyp.set(key, { year: r.year, number: r.number, seq: r.seq });
    }
    return [...byTyp.values()];
  }
  return [];
};

// 태풍 하나의 최신 발표(seq) 분석+예측 전체 트랙을 가져온다.
const fetchTrack = async ({ year, number, seq }) => {
  const text = await fetchText(
    `${KMA_BASE}/typ_data.php?YY=${year}&typ=${number}&seq=${seq}&mode=1&disp=1`,
  );
  const rows = text.split(/\r?\n/).map(parseRow).filter(Boolean);
  const analysis = rows.filter((r) => r.ft === 0).sort((a, b) => a.seq - b.seq);
  const forecast = rows.filter((r) => r.ft === 1).sort((a, b) => a.tmd - b.tmd);
  const current = analysis.at(-1) ?? null;
  if (!current) return null;
  const nameInfo = getTyphoonName(year, number);
  return {
    id: `${year}-${number}`,
    year,
    number,
    seq,
    name: nameInfo?.ko ?? null,
    nameEn: nameInfo?.en ?? null,
    analysis,
    forecast,
    current,
    // 밴드 표기용 발표(분석) 시각
    announceTime: current.analysisTime ?? current.validTime ?? null,
  };
};

// 활동 중인 모든 태풍의 트랙을 반환(번호 오름차순).
export const fetchActiveTyphoons = async () => {
  const active = await discoverActive();
  const tracks = await Promise.all(
    active.map((t) => fetchTrack(t).catch(() => null)),
  );
  return tracks.filter(Boolean).sort((a, b) => a.number - b.number);
};

// 밴드 시각 라벨(2줄): { day: '8/3', time: '22시 발표' }
// API 분석시각 + 1시간 = 실제 통보문 발표시각(관측 후 약 1시간 뒤 발표).
export const formatAnnounceLabel = (date) => {
  if (!date) return null;
  const kst = new Date(date.getTime() + KST_OFFSET_MS + 60 * 60 * 1000);
  return {
    day: `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}`,
    time: `${kst.getUTCHours()}시 발표`,
  };
};
