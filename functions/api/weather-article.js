// 레이더 사실 요약을 방송 원고로 바꾼다.
// Gemini 키는 브라우저에 내려보내면 안 되므로 여기서만 쓴다(KMA 프록시와 같은 방식).

import SGG_NAMES from './_sgg-names.json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// 무료 한도는 모델마다 따로 센다(하루 20회). 주 모델을 다 쓰면 다음 모델로 넘어가
// 하루에 쓸 수 있는 횟수를 늘린다. 앞쪽일수록 원고 품질이 낫다.
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const endpointOf = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// 이전 레이더 원고 호출과 비교할 수 있도록 당분간 남겨 둔 구형 지침.
const SYSTEM_PROMPT = `당신은 KBS 기상 방송 원고를 쓰는 기상캐스터입니다.
주어진 '관측 사실'만으로 레이더 영상 해설 원고를 씁니다.

[사실을 다루는 원칙]
- 사실에 없는 지명·수치·시각을 지어내지 않습니다. 부족하면 있는 것만 씁니다.
- 이동 방향과 지명, 숫자는 사실에 적힌 표현을 글자 그대로 옮깁니다.
  '동남동'을 '동북동'으로 바꾸는 것처럼 비슷한 말로 바꾸면 오보가 됩니다.
- 지명은 '쓸 수 있는 지명'에 있는 것만 씁니다. 목록에 없는 지명은 한 글자도 쓰지 않습니다.
  줄여 부르기는 됩니다: '태안군' → '태안', '태안 일대'.
  바꿔 부르기는 안 됩니다: '태안군' → '태안반도'.
  권역 이름(수도권·충청·경북 …)은 사실의 '권역'에 나온 것만 씁니다.
  사실이 '인근'이라고 준 곳은 '홍성'이 아니라 '홍성 인근'으로 씁니다.
- 사실은 모두 과거부터 지금까지의 관측입니다. '몇 시간 전'을 '몇 시간 후'로 바꾸지 않습니다.
- 레이더 수치는 지상에서 잰 값이 아닙니다. '시간당 50밀리미터가 내렸습니다'가 아니라
  '시간당 50밀리미터 안팎으로 추정되는 비구름'처럼 씁니다.
- 앞일은 '현재 추세대로라면', '유입될 가능성이 있습니다' 정도로만 한정합니다.
  몇 시간 뒤 상황은 레이더만으로 알 수 없으므로 쓰지 않습니다.
- 저기압·정체전선·태풍 같은 원인은 사실로 확인되지 않았으면 쓰지 않습니다.
- '극한호우', '물폭탄', '기록적 폭우' 같은 말은 쓰지 않습니다.
- 색은 사실에 적힌 것만 씁니다. 사실에 색이 없으면 색을 말하지 않습니다.
  세기와 색을 임의로 짝지으면 범례와 어긋납니다.
- 특보는 사실에 있을 때만 말합니다. 강한 비구름이 보인다고 특보가 났다고 쓰지 않습니다.
- 자리가 바뀌었으면 '이동', 같은 자리에서 세졌으면 '새로 발달',
  세졌다 약해졌다 하면 '강약을 반복'이라고 나눠 씁니다.

[구성]
1문단: 화면 전환을 알립니다. 예: '레이더 영상으로 현재 비구름 이동 모습 확인해 보겠습니다.'
2문단: 자료 기준 시각과 전국적인 강수 분포
3문단: 가장 강한 강수대의 지역과 강도, 형태
4문단: 30분~1시간 전과 견준 이동 방향이나 발달·약화
5문단: 다른 주요 강수대와 영향을 받는 인접 지역
마지막 문단: 확인된 위험에 맞춰 '짧은 시간 빗줄기가 강해질 수 있어 주의가 필요합니다' 정도로 맺습니다.
- 핵심 강수대는 2~3개만 다룹니다. 지역을 길게 나열하지 않습니다.
- 순서는 가장 강하고 방송 가치가 높은 강수대부터입니다. 약한 곳은 뒤로 보냅니다.
- 강수가 거의 없으면 억지로 채우지 말고 '내륙 대부분은 소강상태'라고 분명히 말합니다.

[문장]
- 한 줄에 8~12자로 짧게 끊고, 3~4줄이 한 문단이 되게 합니다.
- 문단 안에서는 그냥 줄을 바꾸고, 문단 사이에는 빈 줄을 하나 넣습니다.
- 한 줄에는 하나의 의미만 둡니다(자막을 함께 쓰기 때문입니다).
- 종결은 '~있습니다', '~확인되는데요', '~보입니다'를 섞어 쓰고,
  같은 어미가 잇따르지 않게 합니다.
- 숫자는 소리내어 읽기 좋게 씁니다: '30mm'가 아니라 '30밀리미터',
  '11:25'가 아니라 '오전 11시 25분'.
- 마지막 줄 끝에 //를 붙입니다.
- 원고 외의 설명이나 머리말을 붙이지 않습니다.

[색상 범례]
붉은색 = 시간당 30밀리미터 안팎, 보라색 = 시간당 50밀리미터 안팎,
가장 짙은 색 = 시간당 100밀리미터 안팎`;

const STYLE_SAMPLES = `[문체 예시 1 - 이 구성과 호흡을 가장 가깝게 따르세요]
레이더 영상으로
현재 비구름 이동 모습
확인해 보겠습니다.

오전 11시 25분 현재,
서해 중부에서 들어온 비구름이
충남 서해안과 충청 내륙을
지나고 있습니다.

특히 서산과 당진 일대에는
시간당 30mm 안팎,
홍성 주변에는 시간당 50mm가 넘는
강한 비구름이 발달해 있는데요.

한 시간 전보다 강한 비구름이
내륙 쪽으로 이동하면서
천안과 충북 일부 지역에도
비를 뿌리고 있습니다.

경북 북부와 강원 남부를 지나
동해안으로 빠져나가는
강한 비구름도 확인됩니다.

포항과 울산 인근에도
붉게 보이는 비구름이
국지적으로 발달하고 있습니다.

수도권에도 산발적으로
비구름이 지나고 있는 만큼,
짧은 시간 빗줄기가 강해지는 곳이
있어 주의가 필요합니다.//

[문체 예시 2]
레이더 영상을 통해
비구름 이동 모습을
확인해 보겠습니다.

어젯밤부터
강한 비구름이 충남 지역으로
계속해서 유입되고 있는데요.
검게 보이는 부분은
시간당 100mm 안팎의
극한 호우가 내리는 지역입니다.

자정 이후로
강한 비구름이
태안과 서산, 당진 일대에
걸쳐 있었는데요.
1시간 전부터는
상황이 달라졌습니다.

비구름이 다소
남쪽으로 내려오면서
지금은 홍성과 예산, 아산 일대를
지나고 있습니다.//`;

// 레이더 원고 생성기 전용 규칙. 기존 원고 API의 호환성은 유지하되 구조화 분석이
// 들어오면 이 지침을 우선 적용해 관측·실측·예측의 경계를 분명히 한다.
const RADAR_SCRIPT_SYSTEM_PROMPT = `당신은 KBS 기상 방송 원고를 쓰는 기상캐스터입니다.
입력된 구조화 사실만 사용해 약 1분 10초 분량의 한국어 원고를 씁니다.

[절대 규칙]
- 입력 사실에 없는 지명, 수치, 시각, 원인, 특보를 만들거나 보완하지 않습니다.
- 첫 문장은 정확히 "레이더 영상을 통해 현재 비구름 상황과 앞으로 한 시간 전망을 함께 살펴보겠습니다."로 씁니다.
- 레이더 강도는 "레이더에서는 ... 추정되는 비구름"처럼 추정치임을 밝힙니다.
- 지상 관측은 입력에 이미 묶인 표현을 그대로 활용합니다. 여러 지점을 한 문장에 묶고, 지점별 수치를 한 문장씩 다시 풀어 나열하지 않습니다. AWS라는 용어는 쓰지 않습니다.
- 지상 관측값은 영상의 1시간 강수량 순위표와 시각 차이가 날 수 있으므로 소수점이나 정확한 실측값을 쓰지 않습니다. 반드시 10밀리미터 단위의 "넘는", "가까운", "안팎" 표현만 사용하고, 입력에 이미 근사된 값을 더 정확한 숫자로 되돌리지 않습니다.
- 레이더상 강한 비구름과 인근의 강한 지상 관측이 함께 확인된 지역을 원고의 중심으로 삼습니다. 이런 지역이 하나면 원고 대부분을 그 권역에 집중하고, 여러 곳이면 확인된 곳을 모두 다룹니다.
- 레이더만 강하고 지상 관측으로 뒷받침되지 않은 지역은, 레이더·지상 관측 일치 지역이 하나라도 있을 때 원고에 넣지 않습니다.
- 레이더 추정과 지상 관측을 별개의 목록처럼 읽지 말고, "실제 지상 관측에서도"라는 연결을 이용해 같은 지역의 상황을 한 흐름으로 설명합니다.
- 강도 변화 사실은 같은 위치의 과거 격자와 현재 격자를 비교한 결과입니다. "10여 분 전보다 비의 강도가 뚜렷하게 강해졌습니다"처럼 자연스럽게 연결하되, 이를 비구름의 이동·새로운 발달·강수 구역 확대나 축소로 해석하지 않습니다.
- 비구름의 이동 방향과 강수 구역의 확대·축소는 어떤 경우에도 언급하지 않습니다.
- 관측 사실과 예측은 같은 문단에 섞지 않습니다.
- 예측은 입력에 forecast 사실이 있을 때만 쓰며, 반드시 "레이더 영상을 바탕으로 기상청이 예측한 초단기 예측에서는"이라는 취지의 문장으로 시작합니다.
- 초단기예측도 비슷한 강도의 지역을 한 문장에 묶습니다. 지역별 예측 수치를 각각 되풀이하지 않습니다.
- 예측에는 "가능성이 있습니다" 또는 "예상됩니다"를 쓰고 확정적으로 단정하지 않습니다.
- 미래 전망은 앞으로 한 시간까지만 다룹니다.
- 마지막 문장은 정확히 "해당 지역에서는 최신 기상 정보와 특보 상황을 계속 확인하시기 바랍니다."로 쓰고 끝에 //를 붙입니다.

[방송 문체]
- 쉬운 한국어를 쓰고 API, AWS, 격자, 추정 오차 같은 기술 설명은 넣지 않습니다.
- 가장 강한 육지 강수 핵부터 1~2곳을 설명하고, 지역을 길게 나열하지 않습니다.
- 원고는 수치 목록이 아니라 기사입니다. 문단마다 상황의 핵심을 먼저 말하고 수치는 그 판단을 뒷받침하는 근거로 한 번만 사용합니다.
- 자료 시각과 집중 지역 현황 → 가장 주목할 강수 핵 → 같은 위치의 강도 변화 → 이를 뒷받침하는 묶은 지상 관측 → 상황의 의미와 주의점 → 같은 지역의 초단기예측 순으로 자연스럽게 이어갑니다.
- 자료 시각만 한 문단으로 떼지 말고, "오후 2시 40분 레이더 관측을 보면"처럼 집중 지역의 현황과 한 문장으로 연결합니다.
- "특히", "불과 10여 분 전보다", "실제 지상 관측에서도", "이처럼", "한편" 같은 연결 표현을 사실관계에 맞게 활용해 문단 사이의 흐름을 만듭니다.
- 시간당 30밀리미터 이상인 레이더 추정이나 지상 관측이 있으면, "짧은 시간 빗줄기가 강해질 수 있어 주의가 필요합니다"처럼 직접 뒷받침되는 해설을 덧붙일 수 있습니다. 확인되지 않은 피해·원인·특보는 만들지 않습니다.
- 지역이 여럿이면 "지역에 따라 비의 강도 차이가 크게 나타나고 있습니다"처럼 수치를 반복하지 않는 해설을 활용합니다.
- 묶인 지상 관측과 묶인 예측은 각각 1~2문장으로 끝내고, 확보한 분량은 상황을 이해하기 쉬운 연결 문장과 주의 문장에 씁니다.
- 같은 종결어미와 "강한", "매우", "계속" 같은 표현을 잇달아 반복하지 않습니다.
- 한 줄은 자막에 쓰기 좋게 짧게 끊고, 문단 사이에는 빈 줄을 하나 둡니다.
- 원고 외의 설명이나 제목은 출력하지 않습니다.`;

// Cloudflare Workers에는 process가 없다. 로컬 dev(node)에서만 있으므로
// typeof로 감싸지 않으면 키가 비었을 때 그 줄에서 바로 예외(1101)가 난다.
const readApiKey = (context) => {
  const fromBinding = context.env?.GEMINI_API_KEY;
  if (fromBinding) return fromBinding;
  try {
    return (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || '';
  } catch {
    return '';
  }
};

// 사실에 적힌 지명만 쓰게 하려고, 프롬프트에 넣을 목록을 사실에서 그대로 뽑는다.
const SEA_NAMES = ['서해상', '동해상', '남해상'];
const AREA_NAMES = ['수도권', '강원', '충청', '전북', '전남', '경북', '경남', '제주'];

// 사실 쪽에서 '충남 서산시'가 아니라 '서산'으로 주므로, 대조도 짧은 이름으로 한다.
const shorten = (name) => {
  const cityWithGu = /^(.+?)시.*구$/.exec(name);
  if (cityWithGu?.[1]?.length >= 2) return cityWithGu[1];
  const cut = name.replace(/(특별자치시|광역시|특별시|시|군|구)$/, '');
  return cut.length >= 2 ? cut : name;
};
const SGG_SHORT = [...new Set(SGG_NAMES.map(shorten))];

const extractAllowedPlaces = (facts) => {
  const found = new Set();
  SEA_NAMES.forEach((sea) => { if (facts.includes(sea)) found.add(sea); });
  AREA_NAMES.forEach((area) => { if (facts.includes(area)) found.add(area); });
  SGG_SHORT.forEach((name) => { if (facts.includes(name)) found.add(name); });
  return [...found];
};

// '태안군'을 '태안반도'로, '서산시'를 '서해안'으로 바꿔 부르는 변형을 잡는다.
// 지명에 지형 이름을 붙이면 관측 지점과 다른 곳을 가리키게 된다.
const GEO_FORM = /[가-힣]{2,4}(?:반도|해안|내륙|계곡|평야|고원|산맥|지방|권역)/g;

// 원고에 사실과 무관한 지명이 섞였는지 본다. 전국 시군구명과 대조하므로
// '다시'처럼 시로 끝나는 일반 낱말을 지명으로 잘못 잡지 않는다.
const findForeignPlaces = (script, allowed) => {
  const allowedText = allowed.join(' ');
  const foreign = SGG_SHORT.filter((name) => script.includes(name) && !allowedText.includes(name));
  const reshaped = [...new Set(script.match(GEO_FORM) ?? [])]
    .filter((word) => !allowedText.includes(word));
  return [...new Set([...foreign, ...reshaped])];
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost(context) {
  const apiKey = readApiKey(context);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Gemini API 키가 설정되지 않았습니다.' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let facts = '';
  let durationSeconds = 70;
  try {
    const body = await context.request.json();
    const structuredFacts = body?.analysis?.factsText;
    facts = String(structuredFacts || body?.facts || '').slice(0, 6000);
    if (Number.isFinite(body?.durationSeconds)) {
      durationSeconds = Math.min(180, Math.max(20, Number(body.durationSeconds)));
    }
  } catch {
    return new Response(JSON.stringify({ error: '요청 형식이 올바르지 않습니다.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  if (!facts.trim()) {
    return new Response(JSON.stringify({ error: '관측 사실이 비어 있습니다.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  // TTS로 실제 재어 보니 공백 뺀 265자가 46초였다(초당 5.8자). 1분을 채우려면
  // 그보다 넉넉해야 해서 초당 6자로 잡고, 아래로는 덜 깎이게 폭을 좁게 준다.
  const targetChars = Math.round(durationSeconds * 6);
  const minChars = Math.round(targetChars * 0.95);
  const maxChars = Math.round(targetChars * 1.2);

  const allowedPlaces = extractAllowedPlaces(facts);
  const placeBlock = allowedPlaces.length
    ? `
[쓸 수 있는 지명]
${allowedPlaces.join(', ')}
이 목록에 없는 지명은 쓰지 마세요.
`
    : '';

  const buildPayload = (retryNote = '') => ({
    system_instruction: { parts: [{ text: RADAR_SCRIPT_SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [{
        text: `[원고에 사용할 수 있는 사실]
${facts}
${placeBlock}
`
          + `위 사실만으로 원고를 쓰세요. 공백을 뺀 글자 수가 ${minChars}~${maxChars}자,`
          + ' 문단은 6~8개가 되게 하세요.\n'
          + '관측·실측·예측 문단이 서로 섞이지 않았는지, 모든 지명과 수치가 사실에 있는지 대조하세요.'
          + `${retryNote}`,
      }],
    }],
    // 이 모델은 내부 추론(thinking)이 출력 예산을 함께 쓴다. 실측으로 추론에만
    // 2천 토큰 안팎이 나가므로, 원고가 중간에 잘리지 않도록 넉넉히 잡는다.
    generationConfig: { temperature: 0.75, maxOutputTokens: 16000 },
  });

  // 어떤 모델이 원고를 써 줬는지 화면에 알려 주려고 기억해 둔다.
  let usedModel = MODELS[0];

  const callModel = async (model, retryNote) => {
    const response = await fetch(endpointOf(model), {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(retryNote)),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok || result?.error) {
      const raw = result?.error?.message || `기사 생성 실패 (${response.status})`;
      if (response.status === 429 || /quota|rate limit/i.test(raw)) {
        // 하루치를 다 쓴 것과 잠깐 몰린 것은 전혀 다르다. 기다려서 될 일이 아니면
        // 기다리라고 하지 않는다.
        const violations = (result?.error?.details ?? [])
          .flatMap((detail) => detail?.violations ?? []);
        const daily = violations.some((v) => /PerDay/i.test(v?.quotaId ?? ''));
        const limited = daily
          ? new Error('오늘 쓸 수 있는 무료 횟수를 모두 썼습니다. 내일 다시 쓰거나 유료 전환이 필요합니다.')
          : new Error(`요청이 잠시 몰렸습니다. ${Math.ceil(Number(/retry in ([\d.]+)s/i.exec(raw)?.[1] ?? 35))}초쯤 뒤에 다시 만들어 주세요.`);
        limited.status = 429;
        limited.daily = daily;
        throw limited;
      }
      throw new Error(raw);
    }
    const candidate = result?.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    return {
      script: parts.map((part) => part?.text ?? '').join('').trim(),
      finishReason: candidate?.finishReason ?? null,
    };
  };

  // 한 번 부르고, 사실에 없는 지명이 섞이면 그 지명을 짚어 한 번만 다시 쓰게 한다.
  // 하루치를 다 쓴 모델은 건너뛰고 다음 모델로 넘어간다.
  const askOnce = async (retryNote) => {
    let lastError = null;
    for (const model of MODELS) {
      try {
        const answer = await callModel(model, retryNote);
        usedModel = model;
        return answer;
      } catch (error) {
        lastError = error;
        if (!error.daily) throw error;
      }
    }
    throw lastError ?? new Error('기사 생성에 실패했습니다.');
  };

  try {
    let attempt = await askOnce('');
    let foreign = findForeignPlaces(attempt.script, allowedPlaces);
    if (attempt.script && foreign.length) {
      const note = `
앞서 쓴 원고에 사실에 없는 지명 ${foreign.join(', ')}이(가) 들어갔습니다. `
        + '이 지명은 빼고, 쓸 수 있는 지명만으로 다시 쓰세요.';
      const second = await askOnce(note);
      if (second.script) {
        const stillForeign = findForeignPlaces(second.script, allowedPlaces);
        // 두 번째가 더 낫거나 같으면 그것을 쓴다.
        if (stillForeign.length <= foreign.length) {
          attempt = second;
          foreign = stillForeign;
        }
      }
    }

    if (!attempt.script) {
      return new Response(JSON.stringify({ error: '기사가 비어 있습니다. 다시 시도해 주세요.' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(JSON.stringify({
      script: attempt.script,
      model: usedModel,
      charCount: attempt.script.replace(/\s/g, '').length,
      // 잘림 여부를 화면에서 알 수 있게 함께 준다(MAX_TOKENS면 예산 부족).
      finishReason: attempt.finishReason,
      // 끝내 남은 낯선 지명은 숨기지 말고 화면에서 눈에 띄게 알린다.
      foreignPlaces: foreign,
      generatedAt: new Date().toISOString(),
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message || '기사 생성 중 오류가 발생했습니다.',
      // 하루 한도면 화면에서 기다리게 하지 않는다.
      dailyQuotaExhausted: Boolean(error.daily),
    }), {
      status: error.status === 429 ? 429 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
