import {
  RANKING_KINDS,
  buildRankingPayload,
  getRankingCacheKey,
  writePrecomputedRanking,
} from '../functions/api/rankings.js';
import {
  buildWarningImagePayload,
  writePrecomputedWarningImages,
} from '../functions/api/weather-warning.js';

const WARNING_IMAGE_CACHE_KEY = 'warning-images';

// --- 위성(GK2A) 프레임 엣지 캐시 프리워밍 ---
// /api/gk2a-ir는 미캐시 프레임을 한 아이솔레이트에서 직렬 처리(NOAA 원본 34MB
// 다운로드 + HDF5 해제)하므로, 사용자가 처음 열면 12시간치를 그 자리에서 굽느라
// 지연이 생긴다. 관측 30분이 지난 프레임은 7일 엣지 캐시를 받으므로(그 전엔 120초),
// 매 실행마다 '30분을 갓 넘긴' 프레임들만 미리 호출해 두면 굴러가는 12시간 창이
// 항상 데워진 상태로 유지된다. 이미 데워진 프레임 재호출은 값싼 엣지 HIT다.
// 엣지 캐시는 코로(colo)별이라 이 워커가 도는 지역에서 즉시 효과가 난다.
const SATELLITE_ORIGIN_DEFAULT = 'https://weather-ljh.pages.dev';
// 30분 크론 간격(15분)+프레임 간격(10분)+누락 실행 여유를 덮도록 30~130분 창을 굽는다.
const SATELLITE_WARM_AGES_MINUTES = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];
const SATELLITE_AREAS = ['ko', 'fd'];
const TEN_MINUTES_MS = 10 * 60 * 1000;

const formatSatelliteDate = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  );
};

// 프리워밍 대상 관측시각(UTC, 10분 정렬) 목록 — 현재시각을 10분에 맞춰 내림한 뒤
// 각 age만큼 과거로. age가 모두 30분 이상이라 항상 발표 완료된 슬롯이다.
export const satelliteWarmTargets = (now = Date.now()) => {
  const floored = Math.floor(now / TEN_MINUTES_MS) * TEN_MINUTES_MS;
  return SATELLITE_WARM_AGES_MINUTES.map((ageMin) =>
    formatSatelliteDate(new Date(floored - ageMin * 60 * 1000)),
  );
};

const warmSatelliteFrames = async (env) => {
  const origin = env.SITE_ORIGIN || SATELLITE_ORIGIN_DEFAULT;
  const results = [];
  // 직렬 처리 — 서버 processChain을 몰아치지 않도록 한 프레임씩. 대부분 엣지 HIT라 빠르다.
  for (const date of satelliteWarmTargets()) {
    for (const area of SATELLITE_AREAS) {
      try {
        const response = await fetch(`${origin}/api/gk2a-ir?date=${date}&area=${area}`);
        // 본문을 끝까지 읽어 엣지 캐시에 완전히 적재되게 한다.
        await response.arrayBuffer();
        results.push({
          date,
          area,
          ok: response.ok,
          status: response.status,
          cache: response.headers.get('cf-cache-status') ?? '',
        });
      } catch (error) {
        results.push({ date, area, ok: false, error: error.message });
      }
    }
  }
  return { generatedAt: new Date().toISOString(), results };
};

const makeContext = (env, request = new Request('https://weathernow.local/cron')) => ({
  env,
  request,
});

const refreshRankings = async (context) => {
  const results = [];
  const orderedKinds = [
    'precipitation-max-one-hour',
    ...RANKING_KINDS.filter((kind) => kind !== 'precipitation-max-one-hour'),
  ];

  for (const kind of orderedKinds) {
    // 최대 60분 강수량은 기간별 캐시 키(period:...)로 조회되므로
    // 오늘/어제를 각각 계산해 같은 키에 저장해야 프런트가 읽는다.
    const variants =
      kind === 'precipitation-max-one-hour'
        ? [
            { cacheVariant: 'period:today', options: { period: 'today' } },
            { cacheVariant: 'period:yesterday', options: { period: 'yesterday' } },
          ]
        : [{ cacheVariant: '', options: {} }];

    for (const { cacheVariant, options } of variants) {
      try {
        const payload = await buildRankingPayload(context, kind, options);
        await writePrecomputedRanking(context, kind, payload, cacheVariant);
        results.push({
          kind: cacheVariant ? `${kind}:${cacheVariant}` : kind,
          ok: true,
          observedAt: payload.observedAt ?? '',
        });
      } catch (error) {
        results.push({
          kind: cacheVariant ? `${kind}:${cacheVariant}` : kind,
          ok: false,
          error: error.message,
        });
      }
    }
  }

  return results;
};

const refreshWarningImages = async (context) => {
  try {
    const payload = await buildWarningImagePayload();
    await writePrecomputedWarningImages(context, payload);
    return { kind: WARNING_IMAGE_CACHE_KEY, ok: true, fetchedAt: payload.fetchedAt };
  } catch (error) {
    return { kind: WARNING_IMAGE_CACHE_KEY, ok: false, error: error.message };
  }
};

const refreshWeatherCache = async (env, request) => {
  if (!env.WEATHER_CACHE) {
    throw new Error('WEATHER_CACHE KV binding is required.');
  }

  const context = makeContext(env, request);
  const rankingResults = await refreshRankings(context);
  const warningResult = await refreshWarningImages(context);

  return {
    generatedAt: new Date().toISOString(),
    results: [...rankingResults, warningResult],
  };
};

const readStatus = async (env) => {
  if (!env.WEATHER_CACHE) {
    throw new Error('WEATHER_CACHE KV binding is required.');
  }

  const keys = [
    ...RANKING_KINDS.map((kind) => getRankingCacheKey(kind)),
    WARNING_IMAGE_CACHE_KEY,
  ];
  const records = await Promise.all(
    keys.map(async (key) => {
      const record = await env.WEATHER_CACHE.get(key, 'json');
      return {
        key,
        generatedAt: record?.generatedAt ?? '',
        hasPayload: Boolean(record?.payload),
      };
    }),
  );

  return {
    checkedAt: new Date().toISOString(),
    records,
  };
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const isAuthorizedRefresh = (request, env) => {
  if (!env.CACHE_REFRESH_TOKEN) {
    return false;
  }

  const authorization = request.headers.get('Authorization') ?? '';
  return authorization === `Bearer ${env.CACHE_REFRESH_TOKEN}`;
};

export default {
  async scheduled(_event, env, context) {
    // 랭킹·특보 캐시(KV)와 위성 프레임 엣지 프리워밍은 서로 독립이라 한쪽 실패가
    // 다른 쪽을 막지 않게 allSettled로 함께 돌린다.
    context.waitUntil(
      Promise.allSettled([refreshWeatherCache(env), warmSatelliteFrames(env)]),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/status') {
        return jsonResponse(await readStatus(env));
      }

      if (url.pathname === '/warm-satellite') {
        if (!isAuthorizedRefresh(request, env)) {
          return jsonResponse({ error: 'Unauthorized refresh request.' }, 401);
        }

        return jsonResponse(await warmSatelliteFrames(env));
      }

      if (url.pathname === '/refresh') {
        if (!isAuthorizedRefresh(request, env)) {
          return jsonResponse({ error: 'Unauthorized refresh request.' }, 401);
        }

        const [cache, satellite] = await Promise.allSettled([
          refreshWeatherCache(env, request),
          warmSatelliteFrames(env),
        ]);
        return jsonResponse({
          cache: cache.status === 'fulfilled' ? cache.value : { error: cache.reason?.message },
          satellite:
            satellite.status === 'fulfilled'
              ? satellite.value
              : { error: satellite.reason?.message },
        });
      }

      return jsonResponse({
        name: 'weathernow-precompute',
        endpoints: ['/status', '/refresh', '/warm-satellite'],
      });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};
