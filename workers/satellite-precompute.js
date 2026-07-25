const CACHE_PREFIX = 'satellite/gk2a-ir/v1/pairs/';
const TEN_MINUTES_MS = 10 * 60 * 1000;
// src/components/SatelliteView.jsx의 TIMELINE_HOURS와 반드시 같아야 한다.
// 워커가 더 넓은 구간을 채우면 화면에 안 쓰이는 프레임까지 저장해 KV를 낭비한다.
const TIMELINE_HOURS = 6;

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const pad = (value) => String(value).padStart(2, '0');

const formatUtc = (date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
  `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;

const parseUtc = (value) =>
  new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
      Number(value.slice(8, 10)),
      Number(value.slice(10, 12)),
    ),
  );

const isDailyGap = (date) => date.getUTCHours() === 15 && date.getUTCMinutes() === 20;

const buildTimeline = (latest) => {
  const latestDate = parseUtc(latest);
  const count = Math.floor((TIMELINE_HOURS * 60) / 10);
  const dates = [];
  for (let index = 0; index <= count; index++) {
    const date = new Date(latestDate.getTime() - index * TEN_MINUTES_MS);
    if (!isDailyGap(date)) dates.push(formatUtc(date));
  }
  return dates;
};

// KV list는 무료 플랜 하루 1,000회 제한이라, 1분 크론에서 매번 돌리면 한도를 넘긴다.
// 저장 목록은 Pages 함수가 유지하는 색인 키 하나만 읽고, 색인이 없거나 오래됐을 때만
// 실제 list로 재구성한다(시간당 1회). 두 곳이 같은 키·같은 규칙을 쓴다.
const INDEX_KEY = 'satellite/gk2a-ir/v1/index.json';
// Pages 함수와 같은 주기(10분). 프레임 저장 때 색인을 고쳐 쓰지 않으므로,
// 방금 저장한 프레임은 다음 재구성에서 반영된다.
const INDEX_REBUILD_MS = 10 * 60 * 1000;

const listStoredDatesFromKv = async (store) => {
  const dates = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: CACHE_PREFIX, cursor });
    for (const key of page.keys ?? []) {
      const match = key.name.match(/(\d{12})\.bin\.gz$/);
      if (match) dates.add(match[1]);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return dates;
};

const listStoredDates = async (store) => {
  try {
    const index = await store.get(INDEX_KEY, 'json');
    const rebuiltAt = Date.parse(index?.rebuiltAt ?? '');
    if (
      Array.isArray(index?.dates) &&
      Number.isFinite(rebuiltAt) &&
      Date.now() - rebuiltAt < INDEX_REBUILD_MS
    ) {
      return new Set(index.dates);
    }
    const dates = await listStoredDatesFromKv(store);
    await store.put(
      INDEX_KEY,
      JSON.stringify({ dates: [...dates].sort(), rebuiltAt: new Date().toISOString() }),
    );
    return dates;
  } catch {
    return new Set();
  }
};

const getLatest = async (origin) => {
  const response = await fetch(`${origin}/api/gk2a-ir?latest=1`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`latest satellite request failed (${response.status})`);
  const data = await response.json();
  if (!/^\d{12}$/.test(data.latest ?? '')) {
    throw new Error('latest satellite timestamp is invalid');
  }
  return data.latest;
};

const precompute = async (env) => {
  const store = env.SATELLITE_CACHE || env.KIM_RAIN_CACHE;
  if (!store) throw new Error('SATELLITE_CACHE binding is missing');
  const origin = String(env.SATELLITE_ORIGIN || 'https://weather-ljh.pages.dev').replace(/\/$/, '');
  const batchSize = Math.max(1, Math.min(6, Number(env.SATELLITE_BATCH_SIZE) || 4));
  const latest = await getLatest(origin);
  const timeline = buildTimeline(latest);
  const stored = await listStoredDates(store);
  const missing = timeline.filter((date) => !stored.has(date));
  // 채우기 순서:
  //  1) 가장 최신 결측(사용자가 방금 보는 끝단)을 먼저,
  //  2) 그 뒤엔 가장 오래된 결측부터 최신 쪽으로 '연속으로' 메운다.
  // 예전처럼 두 끝(최신·최고령)만 번갈아 잡으면 가운데 구간이 계속 굶어
  // 09~12시대처럼 중간에 구멍이 남는다. 오래된 쪽부터 빈틈없이 밀어 올린다.
  const targets = [];
  if (missing.length > 0) {
    targets.push(missing[0]);
    for (let index = missing.length - 1; index >= 0 && targets.length < batchSize; index--) {
      if (missing[index] !== targets[0]) targets.push(missing[index]);
    }
  }

  // Pages 함수는 한 아이솔레이트에서 프레임을 직렬 변환한다(processChain). 그래서
  // 워커가 여러 요청을 '동시에' 던지면 Pages 큐 뒤쪽 프레임은 앞 프레임이 끝나길
  // 기다리다 공유 제한시간을 넘겨 매번 한두 개만 저장되고 나머지는 버려졌다
  // (batch 2를 동시에 보내도 실효 저장은 사실상 1개/크론). 하나씩 순차로 보내면
  //  - 각 빌드가 큐 대기 없이 제 속도로(수십 초) 끝나 실효 처리량이 오히려 오르고,
  //  - 느리거나 실패한 프레임이 있어도 각자 넉넉한 제한시간 안에서 끝나 나머지를
  //    막지 않는다.
  // 이미 저장된 시각은 precompute=1이 즉시 204(kv)로 응답하므로 크론이 겹쳐도
  // 재변환 없이 값싸게 지나간다.
  const results = [];
  for (const date of targets) {
    try {
      const response = await fetch(
        `${origin}/api/gk2a-ir?date=${date}&area=pair&precompute=1`,
        { signal: AbortSignal.timeout(75000) },
      );
      await response.arrayBuffer();
      results.push({
        date,
        ok: response.ok,
        status: response.status,
        source: response.headers.get('X-Satellite-Data-Source'),
      });
    } catch (error) {
      results.push({ date, ok: false, error: error.message });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    latest,
    storedFrameCount: stored.size,
    requestedFrameCount: targets.length,
    results,
  };
};

const status = async (env) => {
  const store = env.SATELLITE_CACHE || env.KIM_RAIN_CACHE;
  if (!store) throw new Error('SATELLITE_CACHE binding is missing');
  const origin = String(env.SATELLITE_ORIGIN || 'https://weather-ljh.pages.dev').replace(/\/$/, '');
  const latest = await getLatest(origin);
  const timeline = buildTimeline(latest);
  const stored = await listStoredDates(store);
  const available = timeline.filter((date) => stored.has(date));
  return {
    checkedAt: new Date().toISOString(),
    ready: available.length > 0,
    latest,
    timelineFrameCount: timeline.length,
    precomputedFrameCount: available.length,
    newestPrecomputed: available[0] ?? null,
    oldestPrecomputed: available.at(-1) ?? null,
  };
};

const isAuthorizedRefresh = (request, env) => {
  if (!env.CACHE_REFRESH_TOKEN) return false;
  return request.headers.get('Authorization') === `Bearer ${env.CACHE_REFRESH_TOKEN}`;
};

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(precompute(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/status') return jsonResponse(await status(env));
      if (url.pathname === '/refresh') {
        if (!isAuthorizedRefresh(request, env)) {
          return jsonResponse({ error: 'Unauthorized refresh request.' }, 401);
        }
        return jsonResponse(await precompute(env));
      }
      return jsonResponse({
        name: 'weathernow-satellite-precompute',
        endpoints: ['/status', '/refresh'],
      });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};
