import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, Play, RefreshCw, Square, X } from 'lucide-react';

// 방송에 쓸 만한 목소리만 추렸다. Neural2는 또렷하고 Chirp3-HD는 더 자연스럽다.
const VOICE_OPTIONS = [
  { id: 'ko-KR-Neural2-C', label: '남성 (또렷) · 기본' },
  { id: 'ko-KR-Neural2-A', label: '여성 A (또렷)' },
  { id: 'ko-KR-Neural2-B', label: '여성 B (또렷)' },
  { id: 'ko-KR-Chirp3-HD-Aoede', label: '여성 (자연스러움)' },
  { id: 'ko-KR-Chirp3-HD-Leda', label: '여성 (차분함)' },
  { id: 'ko-KR-Chirp3-HD-Charon', label: '남성 (자연스러움)' },
  { id: 'ko-KR-Chirp3-HD-Orus', label: '남성 (묵직함)' },
];

// 레이더 화면에서 뽑은 '관측 사실'과 그것으로 쓴 방송 원고를 나란히 보여준다.
// 사실이 틀리면 원고도 틀리므로, 검수는 사실 쪽을 먼저 보게 위에 둔다.
// 원고는 그대로 읽을 게 아니라 손볼 것을 전제로 편집 가능하게 만든다.
function ArticleDraftPanel({ facts, durationSeconds = 60, onClose }) {
  const [script, setScript] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState('');
  const [meta, setMeta] = useState(null);
  const [voice, setVoice] = useState('ko-KR-Neural2-C');
  const [speakingRate, setSpeakingRate] = useState(1);
  const [audioStatus, setAudioStatus] = useState('idle'); // idle | loading | playing | error
  const [audioError, setAudioError] = useState('');
  const [audioSeconds, setAudioSeconds] = useState(null);
  const audioRef = useRef(null);
  const audioUrlRef = useRef('');
  const [waitSeconds, setWaitSeconds] = useState(null);
  // 겹쳐 부르면 기다림 루프가 쌓여 스스로 한도를 먹는다. 한 번에 하나만 돌게 한다.
  const runningRef = useRef(false);
  const aliveRef = useRef(true);

  const generate = useCallback(async (isRetry = false) => {
    if (!facts) return;
    if (runningRef.current && !isRetry) return;
    runningRef.current = true;
    setStatus('loading');
    setError('');
    try {
      const response = await fetch('/api/weather-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts, durationSeconds }),
        signal: AbortSignal.timeout(120000),
      });
      // 서버가 죽거나 경로가 안 잡히면 HTML(오류 페이지)이 온다.
      // 그대로 파싱하면 'Unexpected token <'만 보여서 원인을 알 수 없으므로 구분해 준다.
      const raw = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error(
          `서버가 기사 대신 오류 페이지를 보냈습니다 (${response.status}). `
          + '개발 서버라면 재시작이, 배포본이라면 GEMINI_API_KEY 설정 확인이 필요합니다.',
        );
      }
      // 무료 한도는 잠깐 기다리면 풀린다. 사용자가 다시 누르게 하지 않고 한 번은 대신 기다린다.
      if (response.status === 429 && !isRetry) {
        const wait = Math.min(60, Number(/(\d+)초/.exec(payload?.error ?? '')?.[1] ?? 35));
        setWaitSeconds(wait);
        for (let left = wait; left > 0; left -= 1) {
          // 패널을 닫았으면 더 기다릴 이유가 없다.
          if (!aliveRef.current) { setWaitSeconds(null); return undefined; }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, 1000); });
          setWaitSeconds(left - 1);
        }
        setWaitSeconds(null);
        return generate(true);
      }
      if (!response.ok) throw new Error(payload?.error || `기사 생성 실패 (${response.status})`);
      setScript(payload.script ?? '');
      setMeta({
        charCount: payload.charCount,
        finishReason: payload.finishReason,
        foreignPlaces: payload.foreignPlaces ?? [],
      });
      setStatus('ready');
    } catch (caught) {
      setError(caught.message || '기사를 만들지 못했습니다.');
      setStatus('error');
    } finally {
      runningRef.current = false;
    }
    return undefined;
  }, [facts, durationSeconds]);

  // 만든 소리는 blob URL로 잡아 두고, 다시 만들 때마다 이전 것을 놓아준다.
  const releaseAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = '';
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    releaseAudio();
    setAudioStatus('idle');
  }, [releaseAudio]);

  const speak = useCallback(async () => {
    if (!script.trim()) return;
    releaseAudio();
    setAudioStatus('loading');
    setAudioError('');
    setAudioSeconds(null);
    try {
      const response = await fetch('/api/weather-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, voice, speakingRate }),
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) {
        const raw = await response.text();
        let message = `음성 생성 실패 (${response.status})`;
        try {
          message = JSON.parse(raw)?.error || message;
        } catch {
          message = `서버가 음성 대신 오류 페이지를 보냈습니다 (${response.status}). `
            + '개발 서버라면 재시작이, 배포본이라면 GOOGLE_TTS_API_KEY 설정 확인이 필요합니다.';
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      // 실제 낭독 길이를 알아야 영상 길이를 맞출 수 있어 재어 둔다.
      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration)) setAudioSeconds(Math.round(audio.duration));
      });
      audio.addEventListener('ended', () => setAudioStatus('idle'));
      await audio.play();
      setAudioStatus('playing');
    } catch (caught) {
      setAudioError(caught.message || '음성을 만들지 못했습니다.');
      setAudioStatus('error');
    }
  }, [script, voice, speakingRate, releaseAudio]);

  // 패널을 닫을 때 재생 중인 소리도, 기다리던 재시도도 남지 않게 한다.
  useEffect(() => () => {
    aliveRef.current = false;
    releaseAudio();
  }, [releaseAudio]);

  useEffect(() => {
    generate();
    // 패널이 열릴 때 한 번만 자동 생성한다(다시 만들기는 버튼으로).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 낭독 시간 어림: 한국어 방송은 초당 5.5자 안팎.
  const readSeconds = Math.round((script.replace(/\s/g, '').length / 5.5) || 0);

  return (
    <div
      data-video-hide
      className="absolute left-1/2 top-1/2 z-50 flex w-[min(880px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-white/20 bg-slate-950/95 text-white shadow-2xl backdrop-blur-md"
      role="dialog"
      aria-label="레이더 기사 미리보기"
    >
      <div className="flex items-center gap-3 border-b border-white/15 px-5 py-3.5">
        <FileText className="h-5 w-5 text-cyan-300" aria-hidden="true" />
        <span className="text-base font-black">레이더 기사 미리보기</span>
        <button
          type="button"
          onClick={() => generate()}
          disabled={status === 'loading'}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-md border border-white/20 px-3 text-xs font-black text-white/80 transition hover:bg-white/10 disabled:opacity-50"
        >
          {status === 'loading'
            ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
          다시 만들기
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-white/20 text-white/70 transition hover:bg-white/10 hover:text-white"
          aria-label="닫기"
          title="닫기"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid max-h-[70vh] grid-cols-1 gap-0 overflow-auto md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="border-b border-white/10 px-5 py-4 md:border-b-0 md:border-r">
          <div className="mb-2 text-[11px] font-black tracking-wide text-cyan-200">
            관측 사실 (이 내용만으로 원고를 씁니다)
          </div>
          <pre className="whitespace-pre-wrap break-words text-[13px] font-semibold leading-relaxed text-white/85">
            {facts || '레이더 자료를 불러오는 중입니다.'}
          </pre>
        </div>

        <div className="px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-black tracking-wide text-cyan-200">방송 원고</span>
            {status === 'ready' ? (
              <span className="text-[11px] font-bold text-white/45">
                {meta?.charCount}자 · 약 {readSeconds}초
                {meta?.finishReason && meta.finishReason !== 'STOP' ? ' · 잘림' : ''}
              </span>
            ) : null}
          </div>

          {/* 관측 사실에 없는 지명이 남았다면 방송 사고로 이어지므로 눈에 띄게 알린다. */}
          {status === 'ready' && meta?.foreignPlaces?.length ? (
            <div className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] font-bold text-amber-100">
              사실에 없는 지명이 들어 있습니다: {meta.foreignPlaces.join(', ')} — 확인 후 고쳐 주세요.
            </div>
          ) : null}

          {status === 'loading' ? (
            <div className="flex items-center gap-2 py-8 text-sm font-bold text-white/70">
              <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" />
              {waitSeconds !== null
                ? `무료 사용 한도가 잠시 찼습니다. ${waitSeconds}초 뒤 자동으로 다시 만듭니다…`
                : '기사를 쓰는 중입니다…'}
            </div>
          ) : status === 'error' ? (
            <div className="py-6 text-sm font-semibold text-red-200">{error}</div>
          ) : (
            <textarea
              value={script}
              onChange={(event) => setScript(event.target.value)}
              spellCheck={false}
              className="h-[46vh] w-full resize-none rounded-md border border-white/15 bg-slate-900/70 p-3 text-[15px] font-semibold leading-relaxed text-white outline-none focus:border-cyan-300/60"
              aria-label="방송 원고"
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-white/15 px-5 py-3">
        <select
          value={voice}
          onChange={(event) => { setVoice(event.target.value); stopSpeaking(); }}
          className="h-9 rounded-md border border-white/20 bg-slate-900 px-2 text-xs font-bold text-white/85 outline-none"
          aria-label="목소리"
        >
          {VOICE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-[11px] font-bold text-white/60">
          속도
          <input
            type="range"
            min="0.8"
            max="1.3"
            step="0.05"
            value={speakingRate}
            onChange={(event) => setSpeakingRate(Number(event.target.value))}
            className="w-24 accent-cyan-400"
            aria-label="낭독 속도"
          />
          <span className="w-8 tabular-nums text-white/80">{speakingRate.toFixed(2)}</span>
        </label>

        <button
          type="button"
          onClick={audioStatus === 'playing' ? stopSpeaking : speak}
          disabled={audioStatus === 'loading' || !script.trim()}
          className="flex h-9 items-center gap-1.5 rounded-md border border-cyan-300/40 bg-cyan-400/15 px-3 text-xs font-black text-cyan-100 transition hover:bg-cyan-400/25 disabled:opacity-40"
        >
          {audioStatus === 'loading'
            ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            : audioStatus === 'playing'
              ? <Square className="h-3.5 w-3.5" />
              : <Play className="h-3.5 w-3.5" />}
          {audioStatus === 'playing' ? '멈춤' : '미리듣기'}
        </button>

        {audioSeconds !== null ? (
          <span className="text-[11px] font-bold text-white/45">낭독 {audioSeconds}초</span>
        ) : null}
        {audioStatus === 'error' ? (
          <span className="text-[11px] font-bold text-red-200">{audioError}</span>
        ) : null}

        <span className="ml-auto text-[11px] font-semibold text-white/45">
          AI가 쓴 초안입니다. 방송 전 사실과 표현을 확인해 주세요.
        </span>
      </div>
    </div>
  );
}

export default ArticleDraftPanel;
