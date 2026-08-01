import { useEffect, useMemo, useState } from 'react';
import { Check, Download, Film, MapPin, X } from 'lucide-react';

const VIDEO_TARGETS = [
  { id: 'radar', label: '레이더' },
  { id: 'satellite', label: '위성' },
  { id: 'kim', label: '강수예상도' },
  { id: 'accum', label: '누적강수량' },
  { id: 'temperature', label: '기온변화' },
];

const VIDEO_DURATIONS = [5, 8, 10, 12, 15, 20, 30];

const TARGET_URLS = {
  radar: '/?view=radar&mode=broadcast&videoTarget=radar',
  satellite: '/?view=radar&mode=broadcast&videoTarget=satellite',
  kim: '/?view=radar&mode=broadcast&videoTarget=kim',
  accum: '/?view=radar&mode=broadcast&videoTarget=accum',
  temperature: '/?view=heatwave&mode=broadcast&temperatureMode=change',
};

const readCamera = (map) => {
  const center = map?.getCenter?.();
  if (!map || !center) return null;
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
};

const chooseMimeType = () => {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
};

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function VideoExportMenu({
  currentTarget,
  mapRef,
  defaultStart = '',
  defaultEnd = '',
  onPreparePlayback,
  onStartPlayback,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [startInput, setStartInput] = useState(defaultStart);
  const [endInput, setEndInput] = useState(defaultEnd);
  const [durationSec, setDurationSec] = useState(10);
  const [startCamera, setStartCamera] = useState(null);
  const [endCamera, setEndCamera] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (defaultStart) setStartInput(defaultStart);
    if (defaultEnd) setEndInput(defaultEnd);
  }, [defaultEnd, defaultStart]);

  const currentLabel = useMemo(
    () => VIDEO_TARGETS.find((target) => target.id === currentTarget)?.label ?? '동영상',
    [currentTarget],
  );

  const handleTargetChange = (event) => {
    const nextTarget = event.target.value;
    if (nextTarget === currentTarget) return;
    window.location.href = TARGET_URLS[nextTarget];
  };

  const captureCamera = (setter) => {
    const camera = readCamera(mapRef.current);
    if (!camera) {
      setError('지도 화면이 준비된 뒤 위치를 저장해 주세요.');
      return;
    }
    setter(camera);
    setError('');
  };

  const handleRecord = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      setError('이 브라우저에서는 화면 녹화를 지원하지 않습니다.');
      return;
    }
    if (!startCamera || !endCamera) {
      setError('시작 화면과 종료 화면 위치를 모두 저장해 주세요.');
      return;
    }
    if (startInput && endInput && Date.parse(startInput) >= Date.parse(endInput)) {
      setError('종료 시각은 시작 시각보다 늦어야 합니다.');
      return;
    }

    let stream = null;
    try {
      setIsRecording(true);
      setError('');
      await onPreparePlayback?.({ start: startInput, end: endInput, durationSec });
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
        preferCurrentTab: true,
      });
      const chunks = [];
      const mimeType = chooseMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const stopped = new Promise((resolve) => {
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener('stop', resolve, { once: true });
      });

      const map = mapRef.current;
      map?.jumpTo?.(startCamera);
      recorder.start(250);
      await wait(180);
      map?.easeTo?.({ ...endCamera, duration: durationSec * 1000, essential: true });
      onStartPlayback?.({ start: startInput, end: endInput, durationSec });
      await wait(durationSec * 1000 + 220);
      recorder.stop();
      await stopped;

      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kbs-weather-${currentTarget}-${Date.now()}.webm`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (recordError) {
      if (recordError?.name !== 'NotAllowedError') {
        setError(recordError?.message || '동영상 파일을 생성하지 못했습니다.');
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setIsRecording(false);
    }
  };

  return (
    <div className="absolute right-6 top-6 z-50">
      {isOpen ? (
        <div className="w-[360px] rounded-lg border border-white/20 bg-slate-950/95 p-4 text-white shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-base font-black">
              <Film className="h-5 w-5 text-cyan-300" />
              동영상 생성
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white"
              aria-label="동영상 생성 메뉴 닫기"
              title="닫기"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1.5 text-xs font-bold text-white/65">
              대상
              <select
                value={currentTarget}
                onChange={handleTargetChange}
                className="h-10 rounded-md border border-white/15 bg-slate-800 px-3 text-sm font-bold text-white outline-none focus:border-cyan-300"
                aria-label="동영상 대상"
              >
                {VIDEO_TARGETS.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-bold text-white/65">
              시작 시각
              <input
                type="datetime-local"
                value={startInput}
                max={endInput || undefined}
                onChange={(event) => setStartInput(event.target.value)}
                className="h-10 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-semibold text-white outline-none [color-scheme:dark] focus:border-cyan-300"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-bold text-white/65">
              종료 시각
              <input
                type="datetime-local"
                value={endInput}
                min={startInput || undefined}
                onChange={(event) => setEndInput(event.target.value)}
                className="h-10 rounded-md border border-white/15 bg-slate-800 px-2 text-xs font-semibold text-white outline-none [color-scheme:dark] focus:border-cyan-300"
              />
            </label>

            <label className="col-span-2 flex flex-col gap-1.5 text-xs font-bold text-white/65">
              동영상 길이
              <select
                value={durationSec}
                onChange={(event) => setDurationSec(Number(event.target.value))}
                className="h-10 rounded-md border border-white/15 bg-slate-800 px-3 text-sm font-bold text-white outline-none focus:border-cyan-300"
                aria-label="동영상 길이"
              >
                {VIDEO_DURATIONS.map((seconds) => (
                  <option key={seconds} value={seconds}>{seconds}초</option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => captureCamera(setStartCamera)}
              className="flex h-10 items-center justify-center gap-2 rounded-md border border-white/20 bg-slate-800 text-sm font-bold transition hover:bg-slate-700"
            >
              {startCamera ? <Check className="h-4 w-4 text-emerald-300" /> : <MapPin className="h-4 w-4" />}
              시작 화면
            </button>
            <button
              type="button"
              onClick={() => captureCamera(setEndCamera)}
              className="flex h-10 items-center justify-center gap-2 rounded-md border border-white/20 bg-slate-800 text-sm font-bold transition hover:bg-slate-700"
            >
              {endCamera ? <Check className="h-4 w-4 text-emerald-300" /> : <MapPin className="h-4 w-4" />}
              종료 화면
            </button>
          </div>

          {error ? <div className="mt-3 text-xs font-bold text-rose-300">{error}</div> : null}

          <button
            type="button"
            onClick={handleRecord}
            disabled={isRecording}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-cyan-400 text-sm font-black text-slate-950 transition hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60"
          >
            <Download className="h-4 w-4" />
            {isRecording ? '생성 중' : `${currentLabel} 파일 생성`}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-slate-950/75 text-white shadow-xl backdrop-blur-sm transition hover:bg-slate-800"
          aria-label="동영상 생성 메뉴 열기"
          title="동영상 생성"
        >
          <Film className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

export default VideoExportMenu;
