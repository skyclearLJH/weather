// 레이더 화면에 그려진 바로 그 데이터에서 '기사에 쓸 사실'을 뽑아낸다.
//
// 기사를 LLM에 맡길 때 레이더 이미지를 그대로 보여주면 지명을 지어내기 때문에,
// 여기서 위치·강도·이동을 수치로 확정한 뒤 문장 쓰기만 넘긴다.
// 화면이 이미 들고 있는 격자(buckets)와 좌표 매핑을 그대로 쓰므로 추가 통신이 없다.

import sggLabels from '../data/map/kr-sgg-labels-20260701.json';

const SIDO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기',
  강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남', 전북특별자치도: '전북',
  전남광주통합특별시: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',
};

const DIRECTION_NAMES = [
  '북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동',
  '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서',
];

const REGION_POINTS = (sggLabels.features ?? []).map((feature) => ({
  sido: SIDO_SHORT[feature.properties?.sidonm] ?? feature.properties?.sidonm ?? '',
  sgg: feature.properties?.sggnm ?? '',
  lon: feature.geometry?.coordinates?.[0] ?? 0,
  lat: feature.geometry?.coordinates?.[1] ?? 0,
}));

const toRad = (deg) => (deg * Math.PI) / 180;

const distanceKm = (lon1, lat1, lon2, lat2) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
};

const bearingDeg = (lon1, lat1, lon2, lat2) => {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
};

// 좌표에서 가장 가까운 시군구. 육지에서 멀면(=해상) null을 준다.
const nearestRegion = (lon, lat, maxKm = 45) => {
  let best = null;
  let bestKm = Infinity;
  for (const region of REGION_POINTS) {
    const km = distanceKm(lon, lat, region.lon, region.lat);
    if (km < bestKm) {
      bestKm = km;
      best = region;
    }
  }
  return bestKm <= maxKm ? best : null;
};

// 한 프레임에서 기준 등급 이상인 격자 셀을 모아 위치·강도를 요약한다.
const summarizeFrame = ({ buckets, mappings, canvasWidth, canvasHeight, minBucket, toLonLat, bucketToMm }) => {
  if (!buckets || !mappings) return null;
  const cells = [];
  let weightSum = 0;
  let lonSum = 0;
  let latSum = 0;
  let maxBucket = 0;
  let maxPoint = null;

  // 격자 전체를 훑되 화면 픽셀 기준으로 성기게 샘플링한다(4px 간격이면 충분하고 빠르다).
  const step = 4;
  for (let y = 0; y < canvasHeight; y += step) {
    for (let x = 0; x < canvasWidth; x += step) {
      const sourceIndex = mappings[y * canvasWidth + x];
      if (sourceIndex < 0) continue;
      const bucket = buckets[sourceIndex] ?? 0;
      if (bucket < minBucket) continue;
      const [lon, lat] = toLonLat(x, y);
      const weight = bucketToMm(bucket);
      cells.push({ lon, lat, bucket });
      lonSum += lon * weight;
      latSum += lat * weight;
      weightSum += weight;
      if (bucket > maxBucket) {
        maxBucket = bucket;
        maxPoint = { lon, lat };
      }
    }
  }
  if (cells.length === 0) return null;
  return {
    count: cells.length,
    centroid: { lon: lonSum / weightSum, lat: latSum / weightSum },
    maxBucket,
    maxMm: bucketToMm(maxBucket),
    maxPoint,
    cells,
  };
};

// 강한 에코가 걸친 지역 이름들(가까운 시군구 기준, 빈도순).
const regionsOf = (cells, limit = 4) => {
  const counter = new Map();
  cells.forEach(({ lon, lat }) => {
    const region = nearestRegion(lon, lat);
    if (!region) return;
    const key = `${region.sido} ${region.sgg}`;
    counter.set(key, (counter.get(key) ?? 0) + 1);
  });
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
};

const seaSideOf = (centroid) => {
  const region = nearestRegion(centroid.lon, centroid.lat, 60);
  if (region) return null;
  if (centroid.lon < 126) return '서해상';
  if (centroid.lon > 129.5) return '동해상';
  return '남해상';
};

/**
 * 레이더 프레임들에서 기사용 사실을 만든다.
 *
 * frames: [{ validTime: Date, buckets: Uint8Array }] — 과거→현재 순, 관측(obs)만
 * options.mappings: 화면이 쓰는 radarMap (캔버스 픽셀 → 격자 인덱스)
 * options.bucketToMm: 등급 → mm/h 하한값
 */
export const buildRadarFacts = ({
  frames,
  mappings,
  canvasWidth,
  canvasHeight,
  toLonLat,
  bucketToMm,
  strongMinBucket = 13, // 15mm/h 이상 = 화면에서 주황~빨강
  anyMinBucket = 1,
}) => {
  const usable = (frames ?? []).filter((frame) => frame?.buckets);
  if (usable.length === 0) return null;

  const summarize = (frame, minBucket) => summarizeFrame({
    buckets: frame.buckets,
    mappings,
    canvasWidth,
    canvasHeight,
    minBucket,
    toLonLat,
    bucketToMm,
  });

  const latest = usable.at(-1);
  const strongNow = summarize(latest, strongMinBucket);
  const anyNow = summarize(latest, anyMinBucket);

  // 이동: 강한 에코가 있으면 그 무게중심, 없으면 전체 강수역 무게중심으로 궤적을 만든다.
  const track = [];
  usable.forEach((frame) => {
    const summary = summarize(frame, strongNow ? strongMinBucket : anyMinBucket);
    if (summary) track.push({ time: frame.validTime, centroid: summary.centroid, summary });
  });

  let movement = null;
  if (track.length >= 2) {
    const first = track[0];
    const last = track.at(-1);
    const hours = (last.time - first.time) / 3600000;
    if (hours > 0.1) {
      const km = distanceKm(first.centroid.lon, first.centroid.lat, last.centroid.lon, last.centroid.lat);
      const deg = bearingDeg(first.centroid.lon, first.centroid.lat, last.centroid.lon, last.centroid.lat);
      movement = {
        directionName: DIRECTION_NAMES[Math.round(deg / 22.5) % 16],
        degrees: Math.round(deg),
        speedKmh: Math.round(km / hours),
        distanceKm: Math.round(km),
        spanHours: Math.round(hours * 10) / 10,
        fromRegions: regionsOf(first.summary.cells, 3),
        fromSea: seaSideOf(first.centroid),
        fromTime: first.time,
      };
    }
  }

  // 강도 추세: 강한 셀 개수가 늘고 있으면 '발달', 줄면 '약화'.
  let trend = null;
  if (track.length >= 3) {
    const early = track[0].summary.count;
    const late = track.at(-1).summary.count;
    if (early > 0) {
      const ratio = late / early;
      trend = ratio >= 1.3 ? '확대' : ratio <= 0.7 ? '축소' : '비슷';
    }
  }

  return {
    observedAt: latest.validTime,
    strong: strongNow && {
      regions: regionsOf(strongNow.cells),
      sea: seaSideOf(strongNow.centroid),
      maxMm: strongNow.maxMm,
      maxRegion: strongNow.maxPoint
        ? (() => {
          const region = nearestRegion(strongNow.maxPoint.lon, strongNow.maxPoint.lat);
          return region ? `${region.sido} ${region.sgg}` : null;
        })()
        : null,
      cellCount: strongNow.count,
    },
    coverage: anyNow && {
      regions: regionsOf(anyNow.cells, 6),
      cellCount: anyNow.count,
      sea: seaSideOf(anyNow.centroid),
    },
    movement,
    trend,
  };
};

// 사실을 사람이 읽고 검수할 수 있는 텍스트로. 그대로 LLM 프롬프트에도 넣는다.
export const formatRadarFacts = (facts, extras = {}) => {
  if (!facts) return '레이더 자료가 아직 준비되지 않았습니다.';
  const lines = [];
  const time = facts.observedAt instanceof Date
    ? `${facts.observedAt.getMonth() + 1}월 ${facts.observedAt.getDate()}일 ${facts.observedAt.getHours()}시 ${String(facts.observedAt.getMinutes()).padStart(2, '0')}분`
    : '';
  lines.push(`[레이더 관측 - ${time} 기준]`);

  if (facts.strong) {
    const where = [facts.strong.sea, ...facts.strong.regions].filter(Boolean).join(', ');
    lines.push(`- 강한 비구름(15mm/h 이상) 위치: ${where || '뚜렷하지 않음'}`);
    lines.push(`- 최강 강도: 시간당 ${facts.strong.maxMm}mm 안팎${facts.strong.maxRegion ? ` (${facts.strong.maxRegion} 부근)` : ''}`);
  } else {
    lines.push('- 강한 비구름(15mm/h 이상): 없음');
  }

  if (facts.coverage) {
    const where = [facts.coverage.sea, ...facts.coverage.regions].filter(Boolean).join(', ');
    lines.push(`- 비구름이 걸친 지역: ${where}`);
  }

  // 라벨만 주면 '3시간 전'을 '3시간 후'로 뒤집어 쓰는 일이 생겨,
  // 시제가 드러나는 완성 문장으로 준다.
  if (facts.movement) {
    const from = [facts.movement.fromSea, ...facts.movement.fromRegions].filter(Boolean).join(', ');
    lines.push(`- 비구름은 지금 ${facts.movement.directionName}쪽으로 시속 ${facts.movement.speedKmh}km로 이동하고 있습니다. (이동 방향은 '${facts.movement.directionName}쪽'으로 그대로 쓸 것)`);
    if (from) lines.push(`- 이 비구름은 ${facts.movement.spanHours}시간 전에는 ${from}에 있었습니다. (지나온 과거 위치이며, 앞으로 갈 곳이 아님)`);
  }
  if (facts.trend) {
    const trendText = facts.trend === '확대'
      ? '넓어졌습니다'
      : facts.trend === '축소' ? '좁아졌습니다' : '비슷하게 유지되고 있습니다';
    lines.push(`- 최근 몇 시간 동안 비구름이 걸친 범위는 ${trendText}. (지금까지의 변화이며 앞으로의 예보가 아님)`);
  }

  if (extras.observations?.length) {
    lines.push(`- AWS 실측 1시간 최다: ${extras.observations.slice(0, 3).map((row) => `${row.name} ${row.value}mm`).join(', ')}`);
  }
  if (extras.warnings?.length) {
    lines.push(`- 발효 중인 특보: ${extras.warnings.join(', ')}`);
  }
  return lines.join('\n');
};
