// 레이더 사실 요약을 방송 원고로 바꾼다.
// Gemini 키는 브라우저에 내려보내면 안 되므로 여기서만 쓴다(KMA 프록시와 같은 방식).

import SGG_NAMES from './_sgg-names.json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

// gemini-2.5-flash는 신규 사용자에게 닫혔고, API가 3.6-flash를 쓰라고 안내한다.
const MODEL = 'gemini-3.6-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

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
  let durationSeconds = 60;
  try {
    const body = await context.request.json();
    facts = String(body?.facts ?? '').slice(0, 4000);
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

  // 한국어 방송 낭독은 초당 약 5.5자. 1분이면 330자 안팎이고, 실측 낭독이
  // 55~65초에 들도록 300~420자 사이를 목표로 잡는다.
  const targetChars = Math.round(durationSeconds * 5.5);
  const minChars = Math.round(targetChars * 0.9);
  const maxChars = Math.round(targetChars * 1.27);

  const allowedPlaces = extractAllowedPlaces(facts);
  const placeBlock = allowedPlaces.length
    ? `
[쓸 수 있는 지명]
${allowedPlaces.join(', ')}
이 목록에 없는 지명은 쓰지 마세요.
`
    : '';

  const buildPayload = (retryNote = '') => ({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [{
        text: `${STYLE_SAMPLES}

${facts}
${placeBlock}
`
          + `위 사실만으로 원고를 쓰세요. 공백을 뺀 글자 수가 ${minChars}~${maxChars}자,`
          + ' 문단은 8~11개가 되게 하세요.\n'
          + '쓰기 전에 이동 방향과 시제(전/후)를 사실과 한 번 대조하세요.'
          + `${retryNote}`,
      }],
    }],
    // 이 모델은 내부 추론(thinking)이 출력 예산을 함께 쓴다. 실측으로 추론에만
    // 2천 토큰 안팎이 나가므로, 원고가 중간에 잘리지 않도록 넉넉히 잡는다.
    generationConfig: { temperature: 0.75, maxOutputTokens: 16000 },
  });

  // 한 번 부르고, 사실에 없는 지명이 섞이면 그 지명을 짚어 한 번만 다시 쓰게 한다.
  const askOnce = async (retryNote) => {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(retryNote)),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok || result?.error) {
      const raw = result?.error?.message || `기사 생성 실패 (${response.status})`;
      // 무료 한도(분당 20회)에 걸린 것은 고장이 아니라 잠깐 기다리면 되는 일이다.
      if (response.status === 429 || /quota|rate limit/i.test(raw)) {
        const seconds = Math.ceil(Number(/retry in ([\d.]+)s/i.exec(raw)?.[1] ?? 35));
        const limited = new Error(`무료 사용 한도가 잠시 찼습니다. ${seconds}초쯤 뒤에 다시 만들어 주세요.`);
        limited.status = 429;
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
      model: MODEL,
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
    return new Response(JSON.stringify({ error: error.message || '기사 생성 중 오류가 발생했습니다.' }), {
      status: error.status === 429 ? 429 : 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
