import { useCallback, useEffect, useState } from 'react';
import { FileText, LoaderCircle, RefreshCw, X } from 'lucide-react';

// 레이더 화면에서 뽑은 '관측 사실'과 그것으로 쓴 방송 원고를 나란히 보여준다.
// 사실이 틀리면 원고도 틀리므로, 검수는 사실 쪽을 먼저 보게 위에 둔다.
// 원고는 그대로 읽을 게 아니라 손볼 것을 전제로 편집 가능하게 만든다.
function ArticleDraftPanel({ facts, durationSeconds = 60, onClose }) {
  const [script, setScript] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState('');
  const [meta, setMeta] = useState(null);

  const generate = useCallback(async () => {
    if (!facts) return;
    setStatus('loading');
    setError('');
    try {
      const response = await fetch('/api/weather-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts, durationSeconds }),
        signal: AbortSignal.timeout(120000),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `기사 생성 실패 (${response.status})`);
      setScript(payload.script ?? '');
      setMeta({ charCount: payload.charCount, finishReason: payload.finishReason });
      setStatus('ready');
    } catch (caught) {
      setError(caught.message || '기사를 만들지 못했습니다.');
      setStatus('error');
    }
  }, [facts, durationSeconds]);

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
          onClick={generate}
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

          {status === 'loading' ? (
            <div className="flex items-center gap-2 py-8 text-sm font-bold text-white/70">
              <LoaderCircle className="h-4 w-4 animate-spin text-cyan-300" />
              기사를 쓰는 중입니다…
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

      <div className="flex items-center gap-2 border-t border-white/15 px-5 py-3 text-[11px] font-semibold text-white/45">
        AI가 쓴 초안입니다. 방송 전 사실과 표현을 확인해 주세요.
      </div>
    </div>
  );
}

export default ArticleDraftPanel;
