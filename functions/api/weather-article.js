// 레이더 사실 요약을 방송 원고로 바꾼다.
// Gemini 키는 브라우저에 내려보내면 안 되므로 여기서만 쓴다(KMA 프록시와 같은 방식).

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

const readApiKey = (context) =>
  context.env?.GEMINI_API_KEY || process.env?.GEMINI_API_KEY || '';

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

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [{
        text: `${STYLE_SAMPLES}\n\n${facts}\n\n`
          + `위 사실만으로 원고를 쓰세요. 공백을 뺀 글자 수가 ${targetChars}자 안팎(±15%)이 되게 하세요.`,
      }],
    }],
    // 이 모델은 내부 추론(thinking)이 출력 예산을 함께 쓴다. 실측으로 추론에만
    // 2천 토큰 안팎이 나가므로, 원고가 중간에 잘리지 않도록 넉넉히 잡는다.
    generationConfig: { temperature: 0.75, maxOutputTokens: 16000 },
  };

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000),
    });
    const result = await response.json();
    if (!response.ok || result?.error) {
      const message = result?.error?.message || `기사 생성 실패 (${response.status})`;
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const candidate = result?.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const script = parts.map((part) => part?.text ?? '').join('').trim();
    if (!script) {
      return new Response(JSON.stringify({ error: '기사가 비어 있습니다. 다시 시도해 주세요.' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return new Response(JSON.stringify({
      script,
      model: MODEL,
      charCount: script.replace(/\s/g, '').length,
      // 잘림 여부를 화면에서 알 수 있게 함께 준다(MAX_TOKENS면 예산 부족).
      finishReason: candidate?.finishReason ?? null,
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
