// 레이더 화면에 그려진 바로 그 데이터에서 '기사에 쓸 사실'을 뽑아낸다.
// 규칙은 docs/radar-script-generator-spec.md를 따른다.
//
// 이동 방향과 강수 구역 확대·축소는 뽑지 않는다. 무게중심으로 계산하면
// 비구름이 여러 곳에 흩어져 있을 때 실제와 다른 방향이 나와, 방송 원고에
// 틀린 이야기가 실렸다. 다만 같은 위치의 강수 강도 변화는 과거 격자와 직접
// 비교해 쓸 수 있게 한다. 앞일은 우리가 셈하지 않고 기상청 초단기예측만 쓴다.
//
// 기사를 LLM에 맡길 때 레이더 이미지를 그대로 보여주면 지명을 지어내기 때문에,
// 여기서 위치·강도·같은 위치의 변화만 수치로 확정한 뒤 문장 쓰기만 넘긴다.
// 화면이 이미 들고 있는 격자(buckets)와 좌표 매핑을 그대로 쓰므로 추가 통신이 없다.

import sggLabels from '../data/map/kr-sgg-labels-20260701.json';
import { provinceContaining } from './krLand.js';

const SIDO_SHORT = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기',
  강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남', 전북특별자치도: '전북',
  전남광주통합특별시: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주',
};

// 방송에서는 '충남 서산시'가 아니라 '서산'으로 부른다.
const SHORT_NAME = (sgg) => {
  // '포항시남구', '안산시단원구'처럼 시 안의 구까지 붙은 이름은 시 이름만 남긴다.
  const cityWithGu = /^(.+?)시.*구$/.exec(sgg);
  if (cityWithGu?.[1]?.length >= 2) return cityWithGu[1];
  const shortened = sgg.replace(/(특별자치시|광역시|특별시|시|군|구)$/, '');
  return shortened.length >= 2 ? shortened : sgg;
};

// 기사에서 흐름을 이야기할 때 쓰는 권역. 시군구 하나하나보다 이 단위가 먼저 온다.
const AREA_BY_SIDO = {
  서울: '수도권', 인천: '수도권', 경기: '수도권',
  강원: '강원', 충북: '충청', 충남: '충청', 대전: '충청', 세종: '충청',
  전북: '전북', 전남: '전남', 광주: '전남',
  경북: '경북', 대구: '경북', 경남: '경남', 부산: '경남', 울산: '경남',
  제주: '제주',
};


const REGION_POINTS = (sggLabels.features ?? []).map((feature) => ({
  sido: SIDO_SHORT[feature.properties?.sidonm] ?? feature.properties?.sidonm ?? '',
  sgg: feature.properties?.sggnm ?? '',
  lon: feature.geometry?.coordinates?.[0] ?? 0,
  lat: feature.geometry?.coordinates?.[1] ?? 0,
}));

// 방송에서는 '33.8밀리미터'라고 하지 않는다. 10 단위로 어림하고
// 가장 짙은 색 구간은 범례에 맞춰 100밀리미터로 묶는다.
const toBroadcastMm = (mm) => {
  if (mm >= 100) return 100;
  const rounded = Math.round(mm / 10) * 10;
  return rounded > 0 ? rounded : Math.round(mm);
};

// 색은 모델이 짐작하게 두면 90밀리미터를 '붉은색'이라 부르는 일이 생긴다.
// 화면 범례 그대로 사실에 적어 준다.
const colorOf = (mm) => {
  if (mm >= 100) return '가장 짙은 색';
  if (mm >= 50) return '보라색';
  if (mm >= 30) return '붉은색';
  return null;
};

const toRad = (deg) => (deg * Math.PI) / 180;

const distanceKm = (lon1, lat1, lon2, lat2) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
};

// 해상 에코를 현재 강수 핵으로 잘못 뽑지 않도록 실제 시도 경계 안인지 확인한다.
// 판정은 영상 자동 설정과 같은 krLand.js를 쓴다(같은 일을 두 번 구현하지 않는다).
const isSouthKoreanLand = (lon, lat) => provinceContaining(lon, lat) !== null;

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
  if (bestKm > maxKm) return null;
  // 대표점에서 멀면 그 시군 안이라고 단정할 수 없다. '인근'으로 부르게 표시해 둔다.
  return { ...best, farFromCenter: bestKm > 20 };
};

// 한 프레임에서 기준 등급 이상인 격자 셀을 모아 위치·강도를 요약한다.
const summarizeFrame = ({
  buckets,
  mappings,
  canvasWidth,
  canvasHeight,
  minBucket,
  toLonLat,
  bucketToMm,
  landOnly = false,
}) => {
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
      if (landOnly && !isSouthKoreanLand(lon, lat)) continue;
      const weight = bucketToMm(bucket);
      // sourceIndex를 보존하면 과거 프레임의 정확히 같은 격자를 다시 읽을 수 있다.
      // 이를 이용해 이동 방향을 추측하지 않고 해당 지역의 강도 변화만 비교한다.
      cells.push({ lon, lat, bucket, sourceIndex });
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
    const key = region.farFromCenter ? `${SHORT_NAME(region.sgg)} 인근` : SHORT_NAME(region.sgg);
    counter.set(key, (counter.get(key) ?? 0) + 1);
  });
  // 같은 곳이 '포항'과 '포항 인근'으로 겹쳐 나오면 정확한 쪽만 남긴다.
  const ranked = [...counter.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const exact = new Set(ranked.filter((name) => !name.endsWith(' 인근')));
  return ranked
    .filter((name) => !(name.endsWith(' 인근') && exact.has(name.replace(' 인근', ''))))
    .slice(0, limit);
};

// 전국을 한 덩어리로 다루면 '어디에 얼마나'를 말할 수 없다.
// 가까운 셀끼리 묶어 비구름 덩어리를 나눈 뒤, 덩어리마다 위치와 세기를 따로 낸다.
const clusterCells = (cells, cellDeg = 0.2) => {
  const buckets = new Map();
  cells.forEach((cell) => {
    const gx = Math.floor(cell.lon / cellDeg);
    const gy = Math.floor(cell.lat / cellDeg);
    const key = `${gx},${gy}`;
    const found = buckets.get(key);
    if (found) found.cells.push(cell);
    else buckets.set(key, { gx, gy, cells: [cell] });
  });

  const seen = new Set();
  const groups = [];
  for (const key of buckets.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const stack = [key];
    const merged = [];
    while (stack.length) {
      const node = buckets.get(stack.pop());
      merged.push(...node.cells);
      // 붙어 있는 칸(대각선 포함)은 같은 덩어리로 본다.
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const nextKey = `${node.gx + dx},${node.gy + dy}`;
          if (buckets.has(nextKey) && !seen.has(nextKey)) {
            seen.add(nextKey);
            stack.push(nextKey);
          }
        }
      }
    }
    groups.push(merged);
  }
  return groups.sort((a, b) => b.length - a.length);
};

// 덩어리 하나를 기사에 쓸 수 있는 형태로. 이름은 짧게, 세기는 그 덩어리의 최고값으로.
const describeCluster = (cells, bucketToMm) => {
  let lonSum = 0;
  let latSum = 0;
  let maxBucket = 0;
  cells.forEach((cell) => {
    lonSum += cell.lon;
    latSum += cell.lat;
    if (cell.bucket > maxBucket) maxBucket = cell.bucket;
  });
  const centroid = { lon: lonSum / cells.length, lat: latSum / cells.length };

  const counter = new Map();
  const areaCounter = new Map();
  cells.forEach(({ lon, lat }) => {
    const region = nearestRegion(lon, lat);
    if (!region) return;
    const short = region.farFromCenter ? `${SHORT_NAME(region.sgg)} 인근` : SHORT_NAME(region.sgg);
    counter.set(short, (counter.get(short) ?? 0) + 1);
    const area = AREA_BY_SIDO[region.sido];
    if (area) areaCounter.set(area, (areaCounter.get(area) ?? 0) + 1);
  });
  const byCount = (a, b) => b[1] - a[1];
  const ranked = [...counter.entries()].sort(byCount).map(([name]) => name);
  const exact = new Set(ranked.filter((name) => !name.endsWith(' 인근')));
  const places = ranked
    .filter((name) => !(name.endsWith(' 인근') && exact.has(name.replace(' 인근', ''))))
    .slice(0, 3);
  const area = [...areaCounter.entries()].sort(byCount)[0]?.[0] ?? null;

  return {
    places,
    area,
    sea: places.length ? null : seaSideOf(centroid),
    maxMm: toBroadcastMm(bucketToMm(maxBucket)),
    cellCount: cells.length,
    centroid,
    // 관측소 매칭 때만 쓴다. attachNearbyObservations가 API 전송 전에 제거한다.
    footprint: cells.map(({ lon, lat, sourceIndex }) => ({ lon, lat, sourceIndex })),
  };
};

const intensityTier = (mm) => {
  if (mm >= 100) return 5;
  if (mm >= 50) return 4;
  if (mm >= 30) return 3;
  if (mm >= 10) return 2;
  if (mm > 0) return 1;
  return 0;
};

// 현재 강수 핵이 놓인 격자의 10여 분 전 강도와 현재 강도를 비교한다.
// 중심점 이동이나 면적 변화는 전혀 사용하지 않으며, 단계가 달라질 만큼
// 뚜렷한 변화만 기사 재료로 남긴다.
const intensityChangeAtSamePlace = (cluster, referenceFrame, latestFrame, bucketToMm) => {
  if (!referenceFrame?.buckets || !latestFrame?.validTime || !referenceFrame?.validTime) return null;
  const sourceIndexes = [...new Set(
    (cluster.footprint ?? []).map((point) => point.sourceIndex).filter(Number.isInteger),
  )];
  if (sourceIndexes.length < 5) return null;

  let previousMaxBucket = 0;
  sourceIndexes.forEach((sourceIndex) => {
    previousMaxBucket = Math.max(previousMaxBucket, referenceFrame.buckets[sourceIndex] ?? 0);
  });
  const previousMaxMm = toBroadcastMm(bucketToMm(previousMaxBucket));
  const currentMaxMm = cluster.maxMm;
  const minuteGap = Math.round(
    (latestFrame.validTime.getTime() - referenceFrame.validTime.getTime()) / 60000,
  );
  const tierGap = intensityTier(currentMaxMm) - intensityTier(previousMaxMm);
  const strengthened = tierGap >= 1
    || (currentMaxMm - previousMaxMm >= 10 && currentMaxMm >= Math.max(10, previousMaxMm * 1.5));
  const weakened = tierGap <= -1
    || (previousMaxMm - currentMaxMm >= 10 && previousMaxMm >= Math.max(10, currentMaxMm * 1.5));
  if (!strengthened && !weakened) return null;

  return {
    direction: strengthened ? 'stronger' : 'weaker',
    referenceAt: referenceFrame.validTime,
    minutesAgo: minuteGap,
    previousMaxMm,
    currentMaxMm,
    basis: 'same-grid',
  };
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
  strongMinBucket = 12, // 명세 기준: 육지의 시간당 10mm 이상(팔레트에서 10mm는 12번)
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
    landOnly: true,
  });

  const latest = usable.at(-1);
  const strongNow = summarize(latest, strongMinBucket);
  const anyNow = summarize(latest, anyMinBucket);

  // 강한 비구름을 덩어리로 나눠 '어디에 얼마나'를 각각 말할 수 있게 한다.
  const referenceFrame = usable
    .slice(0, -1)
    .map((frame) => ({
      frame,
      minutesAgo: Math.round((latest.validTime.getTime() - frame.validTime.getTime()) / 60000),
    }))
    .filter(({ minutesAgo }) => minutesAgo >= 8 && minutesAgo <= 20)
    .sort((left, right) => Math.abs(left.minutesAgo - 10) - Math.abs(right.minutesAgo - 10))[0]?.frame;

  const clusters = strongNow
    ? clusterCells(strongNow.cells)
        // 좁은 한두 격자에만 잡힌 값은 이상 에코일 수 있어 덩어리로 치지 않는다.
        .filter((cells) => cells.length >= 5)
        .map((cells) => describeCluster(cells, bucketToMm))
        .map((cluster) => ({
          ...cluster,
          intensityChange: intensityChangeAtSamePlace(cluster, referenceFrame, latest, bucketToMm),
        }))
        .sort((left, right) => right.maxMm - left.maxMm || right.cellCount - left.cellCount)
        .slice(0, 3)
    : [];

  // 비구름이 걸친 권역(수도권·충청 …)을 넓은 기준으로 따로 모은다.
  const areaCounter = new Map();
  if (anyNow) {
    anyNow.cells.forEach(({ lon, lat }) => {
      const region = nearestRegion(lon, lat);
      const area = region ? AREA_BY_SIDO[region.sido] : null;
      if (area) areaCounter.set(area, (areaCounter.get(area) ?? 0) + 1);
    });
  }
  const areas = [...areaCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);

  return {
    observedAt: latest.validTime,
    clusters,
    areas,
    strong: strongNow && {
      regions: regionsOf(strongNow.cells),
      sea: seaSideOf(strongNow.centroid),
      maxMm: toBroadcastMm(strongNow.maxMm),
      maxRegion: strongNow.maxPoint
        ? (() => {
          const region = nearestRegion(strongNow.maxPoint.lon, strongNow.maxPoint.lat);
          return region ? SHORT_NAME(region.sgg) : null;
        })()
        : null,
      cellCount: strongNow.count,
    },
    coverage: anyNow && {
      regions: regionsOf(anyNow.cells, 6),
      cellCount: anyNow.count,
      sea: seaSideOf(anyNow.centroid),
    },
  };
};

// 관측 시각 뒤 한 시간 안의 QPF 프레임에서 육지 강수 핵만 뽑는다.
// 관측 사실과 섞지 않도록 별도 객체로 돌려주며, 오래됐거나 프레임이 부족하면
// usable=false로 표시해 원고 생성 단계에서 전망을 통째로 생략한다.
export const buildForecastFacts = ({
  frames,
  mappings,
  canvasWidth,
  canvasHeight,
  toLonLat,
  bucketToMm,
  observedAt,
  strongMinBucket = 9,
}) => {
  const horizonEnd = observedAt instanceof Date
    ? observedAt.getTime() + 60 * 60 * 1000
    : Number.POSITIVE_INFINITY;
  const usableFrames = (frames ?? [])
    .filter((frame) => frame?.buckets && frame.validTime instanceof Date)
    .filter((frame) => !(observedAt instanceof Date) || (
      frame.validTime > observedAt && frame.validTime.getTime() <= horizonEnd
    ));
  if (usableFrames.length === 0) {
    return { usable: false, reason: 'missing', snapshots: [] };
  }

  const sourceAt = usableFrames[0].sourceAt instanceof Date ? usableFrames[0].sourceAt : null;
  const sourceAgeMinutes = sourceAt instanceof Date
    ? Math.round(((observedAt ?? new Date()).getTime() - sourceAt.getTime()) / 60000)
    : null;
  const horizonMinutes = Math.round(
    (usableFrames.at(-1).validTime.getTime() - (observedAt ?? usableFrames[0].validTime).getTime()) / 60000,
  );
  const complete = horizonMinutes >= 45;
  const fresh = sourceAgeMinutes === null || sourceAgeMinutes <= 60;

  const snapshots = usableFrames.map((frame) => {
    const summary = summarizeFrame({
      buckets: frame.buckets,
      mappings,
      canvasWidth,
      canvasHeight,
      minBucket: strongMinBucket,
      toLonLat,
      bucketToMm,
      landOnly: true,
    });
    const clusters = summary
      ? clusterCells(summary.cells)
          .filter((cells) => cells.length >= 5)
          .map((cells) => describeCluster(cells, bucketToMm))
          .sort((left, right) => right.maxMm - left.maxMm || right.cellCount - left.cellCount)
          .slice(0, 3)
      : [];
    return { validAt: frame.validTime, clusters };
  });

  return {
    usable: fresh && complete,
    reason: !fresh ? 'stale' : !complete ? 'incomplete' : null,
    sourceAt,
    sourceAgeMinutes,
    horizonMinutes,
    snapshots,
  };
};

// 관측소와 강수 핵의 실제 격자 영역 사이 최단거리. 넓고 굽은 강수대는 중심점이
// 강수대 밖에 놓일 수 있으므로 중심점 하나와의 거리로 대표 지점을 고르면 안 된다.
const distanceToFootprint = (station, footprint, centroid) => {
  if (!footprint?.length) {
    return distanceKm(centroid.lon, centroid.lat, station.lon, station.lat);
  }
  let nearest = Number.POSITIVE_INFINITY;
  for (const point of footprint) {
    const distance = distanceKm(point.lon, point.lat, station.lon, station.lat);
    if (distance < nearest) nearest = distance;
  }
  return nearest;
};

// 각 육지 강수 핵 안팎의 RN-60m 상위 관측 지점을 최대 3개 붙인다.
// 먼저 실제 강수 격자에서 가까운 지점만 남기고, 그 안에서는 강수량이 큰 순으로
// 고른다. 같은 지점은 여러 핵에 중복 배정하지 않는다.
export const attachNearbyObservations = (
  clusters = [],
  observations = [],
  maxKm = 30,
  limitPerCluster = 3,
) => {
  const used = new Set();
  return clusters.map((cluster) => {
    const { footprint, ...publicCluster } = cluster;
    const candidates = observations
      .filter((row) => Number.isFinite(row.lon) && Number.isFinite(row.lat))
      .filter((row) => Number.isFinite(row.value) && row.value >= 0)
      .filter((row) => !used.has(row.stationId ?? row.name))
      .map((row) => ({
        ...row,
        distanceKm: distanceToFootprint(row, footprint, cluster.centroid),
      }))
      .filter((row) => row.distanceKm <= maxKm)
      .sort((left, right) => right.value - left.value || left.distanceKm - right.distanceKm)
      .slice(0, limitPerCluster);
    candidates.forEach((row) => used.add(row.stationId ?? row.name));
    const nearby = candidates.map((observation) => ({
      stationId: observation.stationId ?? null,
      name: observation.name,
      label: observation.label ?? observation.name,
      value: Math.round(Number(observation.value) * 10) / 10,
      observedAt: observation.observedAt ?? null,
      distanceKm: Math.round(observation.distanceKm),
    }));
    return {
      ...publicCluster,
      observations: nearby,
      // 구형 분석 호출과의 호환을 위해 첫 지점도 단수 필드로 유지한다.
      observation: nearby[0] ?? null,
    };
  });
};

// 사실을 사람이 읽고 검수할 수 있는 텍스트로. 그대로 LLM 프롬프트에도 넣는다.
export const formatRadarFacts = (facts, extras = {}) => {
  if (!facts) return '레이더 자료가 아직 준비되지 않았습니다.';
  const lines = [];

  // 방송에서는 날짜보다 '오전/오후 몇 시 몇 분 현재'로 부른다.
  let time = '';
  if (facts.observedAt instanceof Date) {
    const hour = facts.observedAt.getHours();
    const half = hour < 12 ? '오전' : '오후';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    time = `${half} ${hour12}시 ${String(facts.observedAt.getMinutes()).padStart(2, '0')}분`;
  }
  // 자료가 늦게 들어오면 '현재'라고 하면 안 된다. 몇 분 지난 자료인지 밝힌다.
  const delayMinutes = facts.observedAt instanceof Date
    ? Math.round((Date.now() - facts.observedAt.getTime()) / 60000)
    : 0;
  lines.push(delayMinutes >= 10
    ? `[레이더 관측 - ${time} 자료 기준 (지금보다 ${delayMinutes}분 전 자료라 '현재'라고 하지 말고 '${time} 레이더 기준'으로 쓸 것)]`
    : `[레이더 관측 - ${time} 현재]`);

  if (facts.areas?.length) {
    lines.push(`- 비구름이 걸친 권역: ${facts.areas.join(', ')}`);
  }
  if (facts.coverage) {
    const where = [facts.coverage.sea, ...facts.coverage.regions].filter(Boolean).join(', ');
    if (where) lines.push(`- 비구름이 지나는 곳: ${where}`);
  }

  // 덩어리마다 '어디에 시간당 몇 mm'를 따로 준다. 기사에서 지역별로 나눠 말할 재료다.
  if (facts.clusters?.length) {
    facts.clusters.forEach((cluster, index) => {
      const where = cluster.places.length ? cluster.places.join(', ') : cluster.sea;
      if (!where) return;
      const area = cluster.area ? ` [${cluster.area}]` : '';
      const color = colorOf(cluster.maxMm);
      lines.push(`- 강한 비구름 ${index + 1}: ${where}${area} — 시간당 ${cluster.maxMm}밀리미터 안팎으로 추정${color ? ` (화면에서 ${color})` : ''}`);
    });
  } else if (!facts.strong) {
    lines.push('- 강한 비구름(시간당 10밀리미터 이상): 없음. 내륙 대부분 소강상태');
  }

  // 최고값이 어느 강수대에도 속하지 않으면 좁은 이상 에코일 수 있다.
  // 앞에서 말한 강수대와 어긋나 보이므로 아예 내보내지 않는다.
  const inClusters = facts.clusters?.some((cluster) => cluster.places.some(
    (place) => facts.strong?.maxRegion && place.startsWith(facts.strong.maxRegion.replace(' 인근', '')),
  ));
  if (facts.strong?.maxMm && (!facts.strong.maxRegion || inClusters)) {
    lines.push(`- 전국에서 가장 센 곳: 시간당 ${facts.strong.maxMm}밀리미터 안팎으로 추정${facts.strong.maxRegion ? ` (${facts.strong.maxRegion} 부근)` : ''}`);
  }

  // 라벨만 주면 '3시간 전'을 '3시간 후'로 뒤집어 쓰는 일이 생겨,
  // 시제가 드러나는 완성 문장으로 준다.
  if (extras.observations?.length) {
    lines.push(`- AWS 지상 실측 1시간 최다(레이더 추정이 아닌 실측값): ${extras.observations.slice(0, 3).map((row) => `${row.name} ${row.value}밀리미터`).join(', ')}`);
  }
  if (extras.warnings?.length) {
    lines.push(`- 발효 중인 특보: ${extras.warnings.join(', ')}`);
  }
  return lines.join('\n');
};
