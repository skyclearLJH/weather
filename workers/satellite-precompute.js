const CACHE_PREFIX = 'satellite/gk2a-ir/v1/pairs/';
const TEN_MINUTES_MS = 10 * 60 * 1000;
// src/components/SatelliteView.jsx의 TIMELINE_HOURS와 반드시 같아야 한다.
// 워커가 더 넓은 구간을 채우면 화면에 안 쓰이는 프레임까지 저장해 KV를 낭비한다.
const TIMELINE_HOURS = 6;

// --- 안전장치: 하루 R2 쓰기 상한 ---
// R2 무료 Class A(쓰기·목록)는 월 100만 회 = 하루 약 33,000회. 이 워커의 정상
// 사용량은 하루 약 300회(10분당 신규 1장 + 목록/색인)로 무료 범위의 1% 안팎이다.
// 만에 하나 버그·폭주로 쓰기가 치솟아도 과금으로 이어지지 않도록, UTC 하루 단위로
// 실제 저장된 프레임 수를 세어 이 상한을 넘으면 그날은 더 이상 새 프레임을 저장하지
// 않는다(다음 UTC 자정에 리셋). 상한(2,000)은 정상 사용량의 6배 이상이자 무료 하루
// 한도의 6% 수준이라, 정상 운영에선 절대 닿지 않고 폭주 때만 제동을 건다.
// env.MAX_SATELLITE_WRITES_PER_DAY로 덮어쓸 수 있다.
const DEFAULT_MAX_WRITES_PER_DAY = 2000;
const WRITE_BUDGET_PREFIX = 'satellite/gk2a-ir/v1/write-budget/';

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

const listStoredDates = async (store) => {
  const dates = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: CACHE_PREFIX, cursor });
    for (const object of page.objects ?? []) {
      const match = object.key.match(/(\d{12})\.bin\.gz$/);
      if (match) dates.add(match[1]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return dates;
};

const pruneStoredDates = async (store, retainedHours = 20) => {
  const cutoff = Date.now() - retainedHours * 60 * 60 * 1000;
  const expired = [];
  let cursor;
  do {
    const page = await store.list({ prefix: CACHE_PREFIX, cursor });
    for (const object of page.objects ?? []) {
      const match = object.key.match(/(\d{12})\.bin\.gz$/);
      if (match && parseUtc(match[1]).getTime() < cutoff) expired.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (expired.length > 0) {
    await store.delete(expired);
  }
  return expired.length;
};

// 오늘(UTC) 쓰기 예산 키 — 하루 한 개의 작은 카운터 오브젝트.
const writeBudgetKey = (date = new Date()) =>
  `${WRITE_BUDGET_PREFIX}${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.json`;

const readWritesToday = async (store) => {
  try {
    const object = await store.get(writeBudgetKey());
    if (!object) return 0;
    const data = await object.json();
    return Number(data?.count) || 0;
  } catch {
    return 0;
  }
};

// 실제로 저장된(=Pages가 'live'로 응답한) 프레임 수만 오늘 카운터에 더한다.
// 겹치는 크론끼리의 경합으로 약간 적게 셀 수 있으나, 상한에 6배 여유가 있어 무방하다.
const addWritesToday = async (store, delta) => {
  if (delta <= 0) return;
  const key = writeBudgetKey();
  const used = await readWritesToday(store);
  await store.put(key, JSON.stringify({ count: used + delta, updatedAt: new Date().toISOString() }));
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
  const store = env.SATELLITE_R2;
  if (!store) throw new Error('SATELLITE_R2 binding is missing');
  const origin = String(env.SATELLITE_ORIGIN || 'https://weather-ljh.pages.dev').replace(/\/$/, '');
  const batchSize = Math.max(1, Math.min(6, Number(env.SATELLITE_BATCH_SIZE) || 4));
  const maxWritesPerDay = Math.max(
    0,
    Number(env.MAX_SATELLITE_WRITES_PER_DAY) || DEFAULT_MAX_WRITES_PER_DAY,
  );

  // 하루 쓰기 상한: 오늘 이미 상한만큼 저장했으면 이번 주기는 저장 없이 건너뛴다.
  const writesToday = await readWritesToday(store);
  if (writesToday >= maxWritesPerDay) {
    return {
      checkedAt: new Date().toISOString(),
      skipped: 'daily write cap reached',
      writesToday,
      maxWritesPerDay,
    };
  }
  // 이번 주기에 저장할 수 있는 최대 장수 = 남은 예산과 배치 크기 중 작은 값.
  const remainingBudget = maxWritesPerDay - writesToday;
  const effectiveBatch = Math.min(batchSize, remainingBudget);

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
  if (missing.length > 0 && effectiveBatch > 0) {
    targets.push(missing[0]);
    for (let index = missing.length - 1; index >= 0 && targets.length < effectiveBatch; index--) {
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
  // 실제 저장된('live') 프레임만 오늘 쓰기 예산에 반영한다. 이미 있던 프레임('r2'/'kv')은
  // 쓰기가 아니므로 세지 않는다.
  const newWrites = results.filter((result) => result.ok && result.source === 'live').length;
  await addWritesToday(store, newWrites);

  const prunedFrameCount = await pruneStoredDates(store);

  return {
    checkedAt: new Date().toISOString(),
    latest,
    storedFrameCount: stored.size,
    requestedFrameCount: targets.length,
    newWrites,
    writesToday: writesToday + newWrites,
    maxWritesPerDay,
    prunedFrameCount,
    results,
  };
};

const status = async (env) => {
  const store = env.SATELLITE_R2;
  if (!store) throw new Error('SATELLITE_R2 binding is missing');
  const origin = String(env.SATELLITE_ORIGIN || 'https://weather-ljh.pages.dev').replace(/\/$/, '');
  const latest = await getLatest(origin);
  const timeline = buildTimeline(latest);
  const stored = await listStoredDates(store);
  const available = timeline.filter((date) => stored.has(date));
  const writesToday = await readWritesToday(store);
  const maxWritesPerDay = Math.max(
    0,
    Number(env.MAX_SATELLITE_WRITES_PER_DAY) || DEFAULT_MAX_WRITES_PER_DAY,
  );
  return {
    checkedAt: new Date().toISOString(),
    ready: available.length > 0,
    latest,
    timelineFrameCount: timeline.length,
    precomputedFrameCount: available.length,
    newestPrecomputed: available[0] ?? null,
    oldestPrecomputed: available.at(-1) ?? null,
    writesToday,
    maxWritesPerDay,
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
