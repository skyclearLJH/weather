// 방송 원고를 읽어 주는 음성을 만든다.
// Google TTS 키도 브라우저에 내려보내면 안 되므로 여기서만 쓴다(기사 프록시와 같은 방식).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// 화면에서 고를 수 있는 목소리만 받는다. 임의의 이름이 그대로 넘어가면
// 요금이 다른 음성이 불릴 수 있어 목록으로 묶어 둔다.
const VOICES = new Set([
  'ko-KR-Neural2-A', // 여성
  'ko-KR-Neural2-B', // 여성
  'ko-KR-Neural2-C', // 남성
  'ko-KR-Chirp3-HD-Aoede', // 여성
  'ko-KR-Chirp3-HD-Leda', // 여성
  'ko-KR-Chirp3-HD-Charon', // 남성
  'ko-KR-Chirp3-HD-Orus', // 남성
]);
const DEFAULT_VOICE = 'ko-KR-Neural2-B';

// Cloudflare Workers에는 process가 없다. typeof로 감싸지 않으면
// 키가 비었을 때 그 줄에서 함수가 통째로 죽는다(error code 1101).
const readApiKey = (context) => {
  const fromBinding = context.env?.GOOGLE_TTS_API_KEY;
  if (fromBinding) return fromBinding;
  try {
    return (typeof process !== 'undefined' && process.env?.GOOGLE_TTS_API_KEY) || '';
  } catch {
    return '';
  }
};

// 원고는 방송용으로 줄을 짧게 끊어 놨다. 그대로 읽히면 줄마다 끊겨 어색하므로
// 줄바꿈은 이어 붙이고, 원고 끝 표시인 //는 읽지 않게 뺀다.
const toSpeakableText = (script) => script
  .replace(/\/\//g, ' ')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .join(' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost(context) {
  const apiKey = readApiKey(context);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Google TTS API 키가 설정되지 않았습니다.' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  let text = '';
  let voice = DEFAULT_VOICE;
  let speakingRate = 1;
  try {
    const body = await context.request.json();
    text = toSpeakableText(String(body?.script ?? '')).slice(0, 4000);
    if (VOICES.has(body?.voice)) voice = body.voice;
    if (Number.isFinite(body?.speakingRate)) {
      speakingRate = Math.min(1.6, Math.max(0.7, Number(body.speakingRate)));
    }
  } catch {
    return new Response(JSON.stringify({ error: '요청 형식이 올바르지 않습니다.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  if (!text) {
    return new Response(JSON.stringify({ error: '읽을 원고가 비어 있습니다.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  try {
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ko-KR', name: voice },
        // 영상에 붙일 것이라 MP3로 받는다. 재생과 합성 모두 이 형식이면 충분하다.
        audioConfig: { audioEncoding: 'MP3', speakingRate, pitch: 0, sampleRateHertz: 24000 },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || result?.error) {
      const message = result?.error?.message || `음성 생성 실패 (${response.status})`;
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    if (!result?.audioContent) {
      return new Response(JSON.stringify({ error: '음성이 비어 있습니다.' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // base64를 그대로 내리면 화면에서 다시 풀어야 한다. 여기서 풀어 오디오로 준다.
    const binary = atob(result.audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-Tts-Voice': voice,
        'X-Tts-Chars': String(text.length),
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || '음성 생성 중 오류가 발생했습니다.' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
