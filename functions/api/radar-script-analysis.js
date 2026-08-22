// 레이더 화면이 추출한 수치형 결과를 원고 모델에 넘길 구조화된 사실로 정리한다.
// 이 단계에서 허용한 지명과 수치만 weather-article에 전달해 모델의 임의 보완을 막는다.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

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
  if (value === null) return null;
  return {
    stationId: cleanText(observation.stationId, 20) || null,
    name: cleanText(observation.name, 40),
    label: cleanText(observation.label, 60),
    value,
    observedAt: isoDate(observation.observedAt),
    distanceKm: finite(observation.distanceKm, 0, 100),
  };
};

const sanitizeCluster = (cluster) => {
  const maxMm = finite(cluster?.maxMm, 0, 300);
  const lon = finite(cluster?.centroid?.lon, 120, 134);
  const lat = finite(cluster?.centroid?.lat, 30, 44);
  const places = (cluster?.places ?? []).map((place) => cleanText(place, 30)).filter(Boolean).slice(0, 3);
  if (maxMm === null || lon === null || lat === null || places.length === 0) return null;
  const observations = (cluster?.observations ?? [cluster?.observation])
    .map(sanitizeObservation)
    .filter(Boolean)
    .sort((left, right) => right.value - left.value)
    .slice(0, 3);
  return {
    places,
    area: cleanText(cluster?.area, 20) || null,
    maxMm,
    centroid: { lon, lat },
    observations,
    observation: observations[0] ?? null,
  };
};

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
          firstValidAt: snapshot.validAt,
          lastValidAt: snapshot.validAt,
          maxMm: cluster.maxMm,
        });
      } else {
        existing.lastValidAt = snapshot.validAt;
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
  const facts = [];
  const observedText = kstTimeText(observedAt);

  facts.push({
    type: 'observation-time',
    text: `${observedText} 레이더 관측입니다.`,
  });
  facts.push({
    type: 'distribution',
    text: landCores.length > 0
      ? `육지에서 시간당 10밀리미터 이상으로 추정되는 비구름이 ${areas.length ? areas.join(', ') : landCores.flatMap((core) => core.places).slice(0, 4).join(', ')}에 분포합니다.`
      : '육지에는 시간당 10밀리미터 이상의 뚜렷한 강수 핵이 없습니다.',
  });

  landCores.forEach((core, index) => {
    facts.push({
      type: 'radar-core',
      coreIndex: index,
      text: `${core.places.join(', ')} 부근 비구름은 레이더에서 시간당 ${core.maxMm}밀리미터 안팎으로 추정됩니다.`,
    });
    core.observations.forEach((observation) => {
      facts.push({
        type: 'nearby-observation',
        coreIndex: index,
        text: `가까운 ${observation.label || observation.name} 지점에서는 지난 1시간 동안 ${observation.value}밀리미터의 비가 관측됐습니다.`,
      });
    });
  });

  if (forecast.available && forecast.summary.length > 0) {
    forecast.summary.slice(0, 2).forEach((item) => {
      facts.push({
        type: 'forecast',
        text: `레이더 영상을 바탕으로 기상청이 예측한 초단기 예측에서는 ${kstTimeText(item.firstValidAt)}부터 ${item.places.join(', ')} 부근에 시간당 최대 ${item.maxMm}밀리미터 안팎으로 추정되는 비구름이 나타날 가능성이 있습니다.`,
      });
    });
  }

  return {
    schemaVersion: 2,
    observedAt,
    observedLabel: observedText,
    thresholdMmPerHour: 10,
    areas,
    landCores,
    nearbyObservations: landCores
      .flatMap((core) => core.observations),
    forecast,
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
