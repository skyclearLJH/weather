// 레이더 화면이 추출한 수치형 결과를 원고 모델에 넘길 구조화된 사실로 정리한다.
// 이 단계에서 허용한 지명과 수치만 weather-article에 전달해 모델의 임의 보완을 막는다.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const MIN_ARTICLE_OBSERVATION_MM = 10;
const MIN_CORROBORATED_RADAR_MM = 30;

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

const cleanText = (value, max = 80) => String(value ?? '')
  .replace(/[\r\n\t]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const finite = (value, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const isoDate = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const kstTimeText = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const half = hour < 12 ? '오전' : '오후';
  const hour12 = hour % 12 || 12;
  return `${half} ${hour12}시 ${String(kst.getUTCMinutes()).padStart(2, '0')}분`;
};

const sanitizeObservation = (observation) => {
  const value = finite(observation?.value, 0, 500);
  // 클라이언트 필터를 우회한 입력도 10밀리미터 이하면 분석 JSON에 넣지 않는다.
  if (value === null || value <= MIN_ARTICLE_OBSERVATION_MM) return null;
  return {
    stationId: cleanText(observation.stationId, 20) || null,
    name: cleanText(observation.name, 40),
    label: cleanText(observation.label, 60),
    value,
    observedAt: isoDate(observation.observedAt),
    distanceKm: finite(observation.distanceKm, 0, 100),
  };
};

const sanitizeIntensityChange = (change, currentMaxMm) => {
  if (!['stronger', 'weaker'].includes(change?.direction) || change?.basis !== 'same-grid') return null;
  const minutesAgo = finite(change.minutesAgo, 5, 30);
  const previousMaxMm = finite(change.previousMaxMm, 0, 300);
  const referenceAt = isoDate(change.referenceAt);
  if (minutesAgo === null || previousMaxMm === null || !referenceAt) return null;
  return {
    direction: change.direction,
    referenceAt,
    minutesAgo,
    previousMaxMm,
    currentMaxMm,
    basis: 'same-grid',
  };
};

const sanitizeCluster = (cluster) => {
  const maxMm = finite(cluster?.maxMm, 0, 300);
  const lon = finite(cluster?.centroid?.lon, 120, 134);
  const lat = finite(cluster?.centroid?.lat, 30, 44);
  const places = (cluster?.places ?? []).map((place) => cleanText(place, 30)).filter(Boolean).slice(0, 3);
  const areas = (cluster?.areas ?? [cluster?.area])
    .map((area) => cleanText(area, 20))
    .filter(Boolean)
    .slice(0, 3);
  if (maxMm === null || lon === null || lat === null || places.length === 0) return null;
  const observations = (cluster?.observations ?? [cluster?.observation])
    .map(sanitizeObservation)
    .filter(Boolean)
    .sort((left, right) => right.value - left.value)
    .slice(0, 3);
  return {
    places,
    area: areas[0] ?? null,
    areas,
    maxMm,
    centroid: { lon, lat },
    observations,
    observation: observations[0] ?? null,
    intensityChange: sanitizeIntensityChange(cluster?.intensityChange, maxMm),
  };
};

const formatNumber = (value) => Number.isInteger(value) ? String(value) : String(value).replace(/\.0$/, '');

const approximateObservation = (value) => {
  const lower = Math.floor(value / 10) * 10;
  const upper = Math.ceil(value / 10) * 10;
  if (lower < 10) return { kind: 'around', value: String(Math.max(10, upper)) };
  if (value === lower) return { kind: 'around', value: String(lower) };
  if (upper > lower && upper - value <= 2) return { kind: 'near', value: String(upper) };
  return { kind: 'above', value: String(lower) };
};

const intensitySummary = (values, approximateSingle = false) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const min = sorted[0];
  const max = sorted.at(-1);
  if (min === undefined) return null;
  if (sorted.length === 1) {
    return approximateSingle
      ? approximateObservation(min)
      : { kind: 'exact', value: formatNumber(min) };
  }
  if (min === max) {
    return approximateSingle
      ? approximateObservation(min)
      : { kind: 'around', value: formatNumber(min) };
  }

  const lowerBand = Math.floor(min / 10) * 10;
  const upperBand = Math.ceil(max / 10) * 10;
  if (lowerBand >= 10 && min > lowerBand && max < lowerBand + 10) {
    return { kind: 'above', value: String(lowerBand) };
  }

  const anchor = Math.round(((min + max) / 2) / 10) * 10;
  if (anchor >= 10 && max - min <= 15 && min >= anchor - 10 && max <= anchor + 10) {
    return { kind: 'around', value: String(anchor) };
  }
  return {
    kind: 'range',
    lower: formatNumber(lowerBand),
    upper: formatNumber(upperBand || max),
  };
};

const observationAmountText = (summary) => {
  if (summary.kind === 'above') return `${summary.value}밀리미터가 넘는`;
  if (summary.kind === 'near') return `${summary.value}밀리미터에 가까운`;
  if (summary.kind === 'around') return `${summary.value}밀리미터 안팎의`;
  if (summary.kind === 'range') return `${summary.lower}에서 ${summary.upper}밀리미터의`;
  return `${summary.value}밀리미터의`;
};

const forecastAmountText = (summary) => {
  if (summary.kind === 'above') return `${summary.value}밀리미터 이상으로`;
  if (summary.kind === 'near') return `${summary.value}밀리미터에 가까운 수준으로`;
  if (summary.kind === 'around') return `${summary.value}밀리미터 안팎으로`;
  if (summary.kind === 'range') return `${summary.lower}에서 ${summary.upper}밀리미터로`;
  return `${summary.value}밀리미터 안팎으로`;
};

const toRad = (degrees) => (degrees * Math.PI) / 180;

const distanceKm = (left, right) => {
  const dLat = toRad(right.lat - left.lat);
  const dLon = toRad(right.lon - left.lon);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(left.lat)) * Math.cos(toRad(right.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
};

const samePlace = (left, right) => left.replace(/\s*인근$/, '') === right.replace(/\s*인근$/, '');

const forecastMatchesFocus = (item, focusCores) => focusCores.some((core) => (
  item.places.some((place) => core.places.some((focusPlace) => samePlace(place, focusPlace)))
  || distanceKm(item.centroid, core.centroid) <= 70
));

const intensityTier = (mm) => {
  if (mm >= 100) return 5;
  if (mm >= 50) return 4;
  if (mm >= 30) return 3;
  if (mm >= 10) return 2;
  return mm > 0 ? 1 : 0;
};

const forecastTrend = (items) => {
  const directions = items.map((item) => {
    const tierGap = intensityTier(item.lastMm) - intensityTier(item.firstMm);
    if (tierGap >= 1 || item.lastMm - item.firstMm >= 20) return 'stronger';
    if (tierGap <= -1 || item.firstMm - item.lastMm >= 20) return 'weaker';
    return null;
  }).filter(Boolean);
  if (directions.length === 0) return null;
  if (directions.every((direction) => direction === 'weaker')) return 'weaker';
  if (directions.every((direction) => direction === 'stronger')) return 'stronger';
  return null;
};

const buildObservationGroups = (landCores) => {
  const used = new Set();
  return landCores.map((core, coreIndex) => {
    const ranked = core.observations
      .filter((observation) => observation.value > MIN_ARTICLE_OBSERVATION_MM)
      .filter((observation) => {
        const key = observation.stationId || observation.label || observation.name;
        if (used.has(key)) return false;
        used.add(key);
        return true;
      })
      .sort((left, right) => right.value - left.value);
    const topValue = ranked[0]?.value;
    // 한 지역 안에서도 값 차이가 지나치게 큰 지점은 같은 표현으로 묶지 않는다.
    // 최고값과 15밀리미터 이내인 지점만 최대 3곳 골라 간결하게 요약한다.
    const observations = ranked
      .filter((observation) => topValue - observation.value <= 15)
      .slice(0, 3);
    if (observations.length === 0) return null;
    return {
      coreIndex,
      places: core.places,
      observations,
      amount: intensitySummary(observations.map((item) => item.value), true),
    };
  }).filter(Boolean);
};

const buildForecastGroups = (summary, focusCores) => {
  const selected = summary
    .filter((item) => focusCores.length === 0 || forecastMatchesFocus(item, focusCores))
    .slice(0, 3);
  if (selected.length === 0) return [];
  const maxValue = Math.max(...selected.map((item) => item.maxMm));
  const high = selected.filter((item) => maxValue - item.maxMm <= 20);
  const low = selected.filter((item) => maxValue - item.maxMm > 20);
  return [high, low].filter((items) => items.length > 0).map((items) => ({
    places: [...new Set(items.flatMap((item) => item.places))].slice(0, 3),
    firstValidAt: items.map((item) => item.firstValidAt).sort()[0],
    lastValidAt: items.map((item) => item.lastValidAt).sort().at(-1),
    amount: intensitySummary(items.map((item) => item.maxMm)),
    trend: forecastTrend(items),
  }));
};

const minutesAgoText = (minutes) => minutes >= 8 && minutes <= 14
  ? '10여 분 전'
  : `${Math.round(minutes)}분 전`;

const sanitizeForecast = (forecast, observedAt) => {
  if (!forecast?.usable) {
    return {
      available: false,
      reason: cleanText(forecast?.reason, 20) || 'missing',
      sourceAt: isoDate(forecast?.sourceAt),
      horizonMinutes: finite(forecast?.horizonMinutes, 0, 90),
      snapshots: [],
      summary: [],
    };
  }

  const end = new Date(observedAt).getTime() + 60 * 60 * 1000;
  const snapshots = (forecast.snapshots ?? []).map((snapshot) => {
    const validAt = isoDate(snapshot?.validAt);
    if (!validAt || new Date(validAt).getTime() > end) return null;
    const clusters = (snapshot?.clusters ?? []).map(sanitizeCluster).filter(Boolean).slice(0, 3);
    return { validAt, clusters };
  }).filter(Boolean);

  // 같은 지명이 여러 예측 시각에 반복되면 가장 강한 값과 첫 등장 시각만 남긴다.
  const summaryByPlace = new Map();
  snapshots.forEach((snapshot) => {
    snapshot.clusters.forEach((cluster) => {
      const key = cluster.places[0];
      const existing = summaryByPlace.get(key);
      if (!existing) {
        summaryByPlace.set(key, {
          places: cluster.places,
          centroid: cluster.centroid,
          firstValidAt: snapshot.validAt,
          lastValidAt: snapshot.validAt,
          firstMm: cluster.maxMm,
          lastMm: cluster.maxMm,
          maxMm: cluster.maxMm,
        });
      } else {
        existing.lastValidAt = snapshot.validAt;
        existing.lastMm = cluster.maxMm;
        existing.maxMm = Math.max(existing.maxMm, cluster.maxMm);
      }
    });
  });

  return {
    available: snapshots.length > 0,
    reason: snapshots.length > 0 ? null : 'missing',
    sourceAt: isoDate(forecast.sourceAt),
    horizonMinutes: finite(forecast.horizonMinutes, 0, 90),
    snapshots,
    summary: [...summaryByPlace.values()]
      .sort((left, right) => right.maxMm - left.maxMm)
      .slice(0, 3),
  };
};

export const buildRadarScriptAnalysis = (input) => {
  const radar = input?.radar ?? {};
  const observedAt = isoDate(radar.observedAt);
  if (!observedAt) throw new Error('레이더 관측 시각이 올바르지 않습니다.');

  const landCores = (radar.clusters ?? []).map(sanitizeCluster).filter(Boolean).slice(0, 3);
  const areas = (radar.areas ?? []).map((area) => cleanText(area, 20)).filter(Boolean).slice(0, 5);
  const forecast = sanitizeForecast(input?.forecast, observedAt);
  const corroboratedEntries = landCores
    .map((core, coreIndex) => ({ core, coreIndex }))
    .filter(({ core }) => (
      core.maxMm >= MIN_CORROBORATED_RADAR_MM
      && core.observations.some((observation) => observation.value > MIN_ARTICLE_OBSERVATION_MM)
    ));
  // 일치 지점이 하나라도 있으면 그 지역만 자세히 다룬다. 전혀 없을 때만
  // 가장 강한 레이더 핵 하나를 지상 관측 미확인 상태로 짧게 남긴다.
  const focusedEntries = corroboratedEntries.length > 0
    ? corroboratedEntries
    : landCores.slice(0, 1).map((core, coreIndex) => ({ core, coreIndex }));
  const focusedCores = focusedEntries.map(({ core }) => core);
  const focusedAreas = [...new Set(focusedCores.flatMap((core) => core.areas))];
  const observationGroups = buildObservationGroups(
    corroboratedEntries.map(({ core }) => core),
  );
  const forecastGroups = forecast.available
    ? buildForecastGroups(forecast.summary, focusedCores)
    : [];
  const facts = [];
  const observedText = kstTimeText(observedAt);

  facts.push({
    type: 'observation-time',
    text: `${observedText} 레이더 관측입니다.`,
  });
  facts.push({
    type: 'distribution',
    text: corroboratedEntries.length > 0
      ? `현재 ${focusedAreas.length ? focusedAreas.join(', ') : focusedCores.flatMap((core) => core.places).join(', ')}에는 레이더상 강한 비구름이 걸쳐 있습니다.`
      : landCores.length > 0
        ? `육지에서 시간당 10밀리미터 이상으로 추정되는 비구름이 ${areas.length ? areas.join(', ') : landCores.flatMap((core) => core.places).slice(0, 4).join(', ')}에 분포합니다.`
      : '육지에는 시간당 10밀리미터 이상의 뚜렷한 강수 핵이 없습니다.',
  });

  focusedEntries.forEach(({ core, coreIndex }) => {
    facts.push({
      type: corroboratedEntries.length > 0 ? 'corroborated-radar-core' : 'radar-core-unconfirmed',
      coreIndex,
      text: core.maxMm >= MIN_CORROBORATED_RADAR_MM
        ? `${core.places.join(', ')} 부근에는 레이더에서 시간당 ${core.maxMm}밀리미터 안팎의 강한 비를 뿌릴 수 있는 구름대가 확인됩니다.`
        : `${core.places.join(', ')} 부근에는 레이더에서 시간당 ${core.maxMm}밀리미터 안팎의 비를 뿌릴 수 있는 구름대가 확인됩니다.`,
    });
    if (core.intensityChange) {
      facts.push({
        type: 'intensity-change',
        coreIndex,
        text: `${core.places.join(', ')} 부근은 ${minutesAgoText(core.intensityChange.minutesAgo)}보다 레이더상 비의 강도가 뚜렷하게 ${core.intensityChange.direction === 'stronger' ? '강해졌습니다' : '약해졌습니다'}.`,
      });
    }
  });

  observationGroups.forEach((group) => {
    const labels = group.observations.map((observation) => observation.label || observation.name);
    facts.push({
      type: 'nearby-observation-group',
      text: labels.length === 1
        ? `가까운 ${labels[0]} 지점에서는 지난 1시간 동안 ${observationAmountText(group.amount)} 비가 관측됐습니다.`
        : `가까운 ${labels.join(', ')} 지점에서는 지난 1시간 동안 모두 ${observationAmountText(group.amount)} 비가 관측됐습니다.`,
    });
  });

  if (forecast.available && forecastGroups.length > 0) {
    forecastGroups.forEach((group) => {
      facts.push({
        type: 'forecast-group',
        text: `레이더 영상을 바탕으로 기상청이 예측한 초단기 예측에서는 앞으로 한 시간 동안 ${group.places.join(', ')} 부근에 시간당 ${forecastAmountText(group.amount)} 추정되는 비구름이 나타날 가능성이 있습니다.${group.trend === 'weaker' ? ' 예측 후반으로 갈수록 강도는 점차 약해질 것으로 예측됐습니다.' : group.trend === 'stronger' ? ' 예측 후반으로 갈수록 강도는 점차 강해질 것으로 예측됐습니다.' : ''}`,
      });
    });
  }

  return {
    schemaVersion: 4,
    observedAt,
    observedLabel: observedText,
    thresholdMmPerHour: 10,
    areas,
    landCores,
    focus: {
      mode: corroboratedEntries.length > 0 ? 'radar-observation-match' : 'radar-only-fallback',
      coreIndexes: focusedEntries.map(({ coreIndex }) => coreIndex),
      areas: focusedAreas,
    },
    nearbyObservations: landCores
      .flatMap((core) => core.observations),
    observationGroups,
    forecast,
    forecastGroups,
    facts,
    factsText: facts.map((fact) => `- ${fact.text}`).join('\n'),
    generatedAt: new Date().toISOString(),
  };
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    return json(buildRadarScriptAnalysis(body));
  } catch (error) {
    return json({ error: error.message || '레이더 분석 요청 형식이 올바르지 않습니다.' }, 400);
  }
}
