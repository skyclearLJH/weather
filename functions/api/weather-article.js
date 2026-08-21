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

지켜야 할 것:
- 사실에 없는 지명·수치·시각을 절대 지어내지 않습니다. 사실이 부족하면 있는 것만 씁니다.
- 이동 방향(예: 동남동쪽)과 지명, 숫자는 사실에 적힌 표현을 글자 그대로 옮깁니다.
  '동남동'을 '동북동'으로 바꾸는 것처럼 비슷한 말로 바꿔 쓰면 오보가 됩니다.
- 지명은 '쓸 수 있는 지명'에 있는 것만 씁니다. 목록에 없는 지명은 한 글자도 쓰지 않습니다.
  '태안군'을 '태안반도'로, '서산시'를 '충남 내륙'으로 바꿔 부르는 것도 안 됩니다.
  다만 '충남 태안군'을 '태안'처럼 이름의 일부만 줄여 부르는 것은 됩니다.
- '두 시간', '세 곳'처럼 사실에 없는 수를 붙이지 않습니다.
- 주어진 사실은 모두 과거부터 지금까지의 관측입니다. '몇 시간 전'을 '몇 시간 후'로
  바꿔 쓰지 않고, 앞으로 어디로 갈지·얼마나 올지는 사실에 없으므로 쓰지 않습니다.
- 방송 낭독용이라 한 줄에 8~12자로 짧게 끊어 씁니다.
- 문장은 '~습니다' 또는 '~데요'로 끝냅니다.
- 마지막 줄 끝에 //를 붙입니다.
- 색상 범례를 활용해 '붉게 보이는', '보라색으로 보이는' 같은 표현을 자연스럽게 씁니다.
- 예보는 단정하지 말고 '~로 보입니다', '~가능성이 있습니다' 수준으로 씁니다.
- 원고 외의 설명이나 머리말을 붙이지 않습니다.

[색상 범례]
붉은색 = 시간당 30mm 안팎, 보라색 = 시간당 50mm 안팎, 검은색 = 시간당 100mm 안팎`;

const STYLE_SAMPLES = `[문체 예시 1]
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
지나고 있습니다.//

[문체 예시 2]
레이더 영상으로
실시간 비구름 이동 모습
확인해 보겠습니다.
서해 남부 해상에서
호남지방을 거쳐
경북 지역까지
비구름이 자리하고 있습니다.
붉게 보이는
강한 비구름이
강약을 반복하며
광주·전남 일대를
지나고 있는데요.
밤 10시 전후에도
보성 등 일부 지역에는
시간당 50mm의
집중호우가 쏟아졌습니다.
또, 서해 남부 해상에서
검게 보이는 강한 비구름이
내륙으로 유입되고 있습니다.//`;

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
const extractAllowedPlaces = (facts) => {
  const found = new Set();
  SEA_NAMES.forEach((sea) => { if (facts.includes(sea)) found.add(sea); });
  SGG_NAMES.forEach((name) => { if (facts.includes(name)) found.add(name); });
  return [...found];
};

// 원고에 사실과 무관한 시군구가 섞였는지 본다. 전국 시군구명과 대조하므로
// '다시'처럼 시로 끝나는 일반 낱말을 지명으로 잘못 잡지 않는다.
const findForeignPlaces = (script, allowed) => {
  const allowedText = allowed.join(' ');
  return SGG_NAMES.filter((name) => script.includes(name) && !allowedText.includes(name));
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

  // 한국어 방송 낭독은 초당 약 5.5자. 1분이면 330자 안팎이다.
  const targetChars = Math.round(durationSeconds * 5.5);

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
          + `위 사실만으로 원고를 쓰세요. 공백을 뺀 글자 수가 ${targetChars}자 안팎(±15%)이 되게 하세요.
`
          + `쓰기 전에 이동 방향과 시제(전/후)를 사실과 한 번 대조하세요.${retryNote}`,
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
      throw new Error(result?.error?.message || `기사 생성 실패 (${response.status})`);
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
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
