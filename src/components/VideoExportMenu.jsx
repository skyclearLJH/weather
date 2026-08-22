import { useEffect, useMemo, useState } from 'react';
import { Check, Download, Film, MapPin, Volume2 } from 'lucide-react';
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny';

const VIDEO_TARGETS = [
  { id: 'radar', label: '레이더' },
  { id: 'tracking', label: '호우추적' },
  { id: 'terrain', label: '지형호우' },
  { id: 'history', label: '과거 사례 비교' },
  { id: 'satellite', label: '위성' },
  { id: 'kim', label: 'KIM 국지 강수예상' },
  { id: 'accum', label: '누적강수량' },
  { id: 'kim-global', label: 'KIM 전구' },
  { id: 'ifs', label: 'ECMWF IFS' },
  { id: 'gfs', label: 'NOAA GFS' },
  { id: 'compare', label: '전구모델 비교' },
  { id: 'temperature', label: '기온변화' },
];

const VIDEO_DURATIONS = [5, 8, 10, 12, 15, 20, 30];
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
const VIDEO_FRAME_RATE = 30;
const VIDEO_BITRATE = 10_000_000;

const TARGET_URLS = {
  radar: '/?view=radar&mode=record&videoTarget=radar',
  tracking: '/?view=radar&mode=record&videoTarget=tracking',
  terrain: '/?view=radar&mode=record&videoTarget=terrain',
  history: '/?view=radar&mode=record&videoTarget=history',
  satellite: '/?view=radar&mode=record&videoTarget=satellite',
  kim: '/?view=radar&mode=record&videoTarget=kim',
  accum: '/?view=radar&mode=record&videoTarget=accum',
  'kim-global': '/?view=radar&mode=record&videoTarget=kim-global',
  ifs: '/?view=radar&mode=record&videoTarget=ifs',
  gfs: '/?view=radar&mode=record&videoTarget=gfs',
  compare: '/?view=radar&mode=record&videoTarget=compare',
  temperature: '/?view=heatwave&mode=record&temperatureMode=change',
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

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const AUDIO_BITRATE = 128_000;
// 낭독이 끝나자마자 화면이 끊기면 급해 보인다. 뒤에 조금 여유를 둔다.
const NARRATION_TAIL_SEC = 1.2;
// 음성 영상 한 사이클의 짜임새. 관측을 돌리고 현재에서 멈춰 보여 준 뒤,
// 초단기 예측을 돌리고 마지막에서 다시 멈춘다. 곧바로 되감으면 눈이 따라가지 못한다.
const CYCLE_PLAN = [
  { phase: 'observation', play: 10, hold: 3 },
  { phase: 'forecast', play: 4, hold: 3 },
];
const CYCLE_SEC = CYCLE_PLAN.reduce((sum, step) => sum + step.play + step.hold, 0); // 20초
const CYCLE_COUNT = 3;
// 순위표는 두 번째 사이클에서만 띄운다.
const RANKING_CYCLE_INDEX = 1;

// 원고를 음성으로 바꿔 오디오 버퍼로 돌려준다. 영상 길이를 여기서 나온
// 실제 낭독 길이에 맞추므로, 글자 수로 어림하지 않는다.
const synthesizeNarration = async ({ script, voice, speakingRate }) => {
  const response = await fetch('/api/weather-tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, voice, speakingRate }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = `음성을 만들지 못했습니다 (${response.status})`;
    try {
      message = JSON.parse(raw)?.error || message;
    } catch {
      message = `서버가 음성 대신 오류 페이지를 보냈습니다 (${response.status}).`;
    }
    throw new Error(message);
  }
  const encoded = await response.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('이 브라우저에서는 음성을 넣을 수 없습니다.');
  const audioContext = new AudioContextClass();
  try {
    return await audioContext.decodeAudioData(encoded);
  } finally {
    audioContext.close?.();
  }
};

const waitForVideo = async (video, stream) => {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', reject, { once: true });
  });
};

// 전체화면으로 들어가면 공유 트랙의 해상도가 뒤늦게 커진다. 바뀌기 전 크기로
// 출력 캔버스를 잡으면 작은 화면이 확대돼 찍히므로, 값이 멎을 때까지 기다린다.
const waitForStableCaptureSize = async (video, timeoutMs = 2500) => {
  const startedAt = performance.now();
  let previous = `${video.videoWidth}x${video.videoHeight}`;
  let sameCount = 0;
  while (performance.now() - startedAt < timeoutMs) {
    await wait(120);
    const current = `${video.videoWidth}x${video.videoHeight}`;
    if (current === previous && video.videoWidth > 0) {
      sameCount += 1;
      if (sameCount >= 2) return;
    } else {
      sameCount = 0;
      previous = current;
    }
  }
};

const drawVideoFrame = (context, video) => {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return false;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // 캡처된 방송 화면을 출력 캔버스에 1:1로 그린다. 출력 캔버스 크기를 캡처 원본과
  // 같게 잡으므로(아래 참조) 레터박스·왜곡·업스케일이 없어 방송모드와 화질이 같다.
  context.drawImage(
    video,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    context.canvas.width,
    context.canvas.height,
  );
  return true;
};

function VideoExportMenu({
  currentTarget,
  mapRef,
  defaultStart = '',
  defaultEnd = '',
  onBeforeScreenShare,
  onAfterScreenShare,
  onPreparePlayback,
  onStartPlayback,
  onCyclePhase,
  onRankingTable,
  narrationScript = '',
  narrationVoice = 'ko-KR-Neural2-B',
  narrationRate = 1.1,
  onAutoSetup,
}) {
  const [startInput, setStartInput] = useState(defaultStart);
  const [endInput, setEndInput] = useState(defaultEnd);
  const [durationSec, setDurationSec] = useState(10);
  const [startCamera, setStartCamera] = useState(null);
  const [endCamera, setEndCamera] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [withNarration, setWithNarration] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');
  const [autoLabel, setAutoLabel] = useState('');
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

  // 체크를 켜는 순간 시각과 두 화면을 대신 잡아 준다. 끄면 흔적을 지운다.
  const handleNarrationToggle = (event) => {
    const next = event.target.checked;
    setWithNarration(next);
    if (!next) {
      setAutoLabel('');
      return;
    }
    const auto = onAutoSetup?.();
    if (!auto) {
      setAutoLabel('');
      return;
    }
    setStartInput(auto.start);
    setEndInput(auto.end);
    if (auto.startCamera) setStartCamera(auto.startCamera);
    if (auto.endCamera) setEndCamera(auto.endCamera);
    setAutoLabel(auto.endLabel || '');
    setError('');
  };

  const handleRecord = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia || typeof VideoEncoder === 'undefined') {
      setError('이 브라우저에서는 MP4 영상 인코딩을 지원하지 않습니다.');
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

    if (withNarration && !narrationScript.trim()) {
      setError("읽을 원고가 없습니다. '기사 만들기'에서 원고를 쓰거나 붙여넣어 주세요.");
      return;
    }

    let stream = null;
    let sourceVideo = null;
    let cleanCaptureActive = false;
    let rankingTouched = false;
    try {
      setIsRecording(true);
      setRecordingProgress(0);
      setError('');

      // 음성을 먼저 만든다. 실제 낭독 길이를 알아야 영상 길이를 맞출 수 있고,
      // 화면 공유를 허락받기 전에 실패하면 사용자를 헛수고시키지 않는다.
      let narrationBuffer = null;
      if (withNarration) {
        setProgressLabel('원고를 음성으로 바꾸는 중입니다…');
        narrationBuffer = await synthesizeNarration({
          script: narrationScript,
          voice: narrationVoice,
          speakingRate: narrationRate,
        });
      }
      // 음성을 넣으면 20초 사이클을 정해진 횟수만큼 돌린다. 낭독이 그보다 길면
      // 소리가 잘리지 않게 사이클을 더 돌린다.
      const totalSeconds = narrationBuffer
        ? Math.max(CYCLE_SEC * CYCLE_COUNT, narrationBuffer.duration + NARRATION_TAIL_SEC)
        : durationSec;

      setProgressLabel('화면을 준비하는 중입니다…');
      await onPreparePlayback?.({ start: startInput, end: endInput, durationSec });
      await onBeforeScreenShare?.();
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: VIDEO_WIDTH },
          height: { ideal: VIDEO_HEIGHT },
          frameRate: { ideal: VIDEO_FRAME_RATE, max: VIDEO_FRAME_RATE },
          // 녹화 영상에 마우스 커서가 찍히지 않게 캡처에서 커서를 제외한다.
          cursor: 'never',
        },
        audio: false,
        preferCurrentTab: true,
        // 일부 브라우저는 최상위 constraints의 cursor를 참조하므로 함께 지정한다.
        cursor: 'never',
      });

      sourceVideo = document.createElement('video');
      await waitForVideo(sourceVideo, stream);
      document.body.classList.add('weather-video-capture');
      cleanCaptureActive = true;
      // 선택창이 풀어 버린 전체화면을 여기서 다시 잡는다. 크기를 재기 전에 해야
      // 방송화면과 같은 해상도로 찍힌다.
      await onAfterScreenShare?.();
      await waitForStableCaptureSize(sourceVideo);
      await new Promise((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      });
      await wait(120);
      // 출력 해상도를 캡처된 방송 화면(원본)과 동일하게 잡는다. 1920x1080에 억지로
      // 맞추면 레터박스·업스케일로 배율이 달라 보이고 화질이 떨어진다. 네이티브
      // 전체화면(1920x1080)에서 녹화하면 방송모드와 완전히 같은 크기·해상도가 된다.
      // (H.264는 짝수 크기를 요구하므로 짝수로 내림.)
      const captureWidth = sourceVideo.videoWidth || VIDEO_WIDTH;
      const captureHeight = sourceVideo.videoHeight || VIDEO_HEIGHT;
      const outputWidth = Math.max(2, captureWidth - (captureWidth % 2));
      const outputHeight = Math.max(2, captureHeight - (captureHeight % 2));
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('영상 합성 화면을 만들 수 없습니다.');

      const format = new Mp4OutputFormat();
      const codec = await getFirstEncodableVideoCodec(
        format.getSupportedVideoCodecs().filter((candidate) => candidate === 'avc'),
        { width: outputWidth, height: outputHeight },
      );
      if (codec !== 'avc') {
        throw new Error('이 기기에서 H.264 MP4 인코더를 사용할 수 없습니다.');
      }
      const target = new BufferTarget();
      const output = new Output({ format, target });
      const videoSource = new CanvasSource(canvas, {
        codec,
        quality: new Quality({ bitrate: VIDEO_BITRATE }),
      });
      output.addVideoTrack(videoSource, { frameRate: VIDEO_FRAME_RATE });

      // 오디오 트랙은 인코딩을 시작하기 전에 붙여야 한다.
      let audioSource = null;
      if (narrationBuffer) {
        const audioCodec = await getFirstEncodableAudioCodec(
          format.getSupportedAudioCodecs(),
          { numberOfChannels: narrationBuffer.numberOfChannels, sampleRate: narrationBuffer.sampleRate },
        );
        if (!audioCodec) throw new Error('이 기기에서 음성 트랙을 인코딩할 수 없습니다.');
        audioSource = new AudioBufferSource({
          codec: audioCodec,
          bitrate: AUDIO_BITRATE,
        });
        output.addAudioTrack(audioSource);
      }

      await output.start();

      const map = mapRef.current;
      map?.jumpTo?.(startCamera);
      await wait(180);
      drawVideoFrame(context, sourceVideo);
      const frameDuration = 1 / VIDEO_FRAME_RATE;
      await videoSource.add(0, frameDuration);
      map?.easeTo?.({ ...endCamera, duration: durationSec * 1000, essential: true });
      onStartPlayback?.({ start: startInput, end: endInput, durationSec });

      // 사이클 안에서 언제 무엇을 할지 미리 적어 둔다. 녹화 루프는 시각만 재고
      // 때가 되면 그대로 실행한다.
      const schedule = [];
      if (narrationBuffer) {
        for (let cycle = 0; ; cycle += 1) {
          let offset = cycle * CYCLE_SEC;
          if (offset >= totalSeconds) break;
          // 정해진 횟수를 채운 뒤 얼마 남지 않았으면 사이클을 새로 열지 않는다.
          // 되감자마자 영상이 끝나면 어색해서, 마지막 화면을 그대로 두고 맺는다.
          if (cycle >= CYCLE_COUNT && totalSeconds - offset < CYCLE_PLAN[0].play) break;
          // 사이클이 시작할 때 화면을 처음으로 돌리고 순위표를 켜거나 끈다.
          schedule.push({ at: offset * 1000, kind: 'cycle-start', cycle });
          for (const step of CYCLE_PLAN) {
            schedule.push({ at: offset * 1000, kind: 'phase', phase: step.phase, seconds: step.play });
            offset += step.play + step.hold;
          }
        }
      }
      let scheduleIndex = 0;
      const totalFrames = Math.max(2, Math.round(totalSeconds * VIDEO_FRAME_RATE));
      const startedAt = performance.now();

      if (narrationBuffer) setProgressLabel('영상을 찍는 중입니다…');

      for (let frameIndex = 1; frameIndex < totalFrames; frameIndex += 1) {
        const targetTime = startedAt + frameIndex * (1000 / VIDEO_FRAME_RATE);
        await wait(Math.max(0, targetTime - performance.now()));

        // 적어 둔 일정을 때가 되면 실행한다. 늦게 깨어났더라도 밀린 것을 몰아서 처리한다.
        const elapsed = performance.now() - startedAt;
        while (scheduleIndex < schedule.length && schedule[scheduleIndex].at <= elapsed) {
          const task = schedule[scheduleIndex];
          scheduleIndex += 1;
          if (task.kind === 'cycle-start') {
            // 화면을 처음 위치로 돌리고, 관측이 도는 동안에만 줌인이 진행되게 한다.
            map?.jumpTo?.(startCamera);
            map?.easeTo?.({ ...endCamera, duration: CYCLE_PLAN[0].play * 1000, essential: true });
            onRankingTable?.(task.cycle === RANKING_CYCLE_INDEX);
            rankingTouched = true;
          } else if (task.kind === 'phase') {
            onCyclePhase?.({
              phase: task.phase,
              start: startInput,
              end: endInput,
              seconds: task.seconds,
            });
          }
        }

        if (!drawVideoFrame(context, sourceVideo)) continue;
        await videoSource.add(frameIndex / VIDEO_FRAME_RATE, frameDuration);
        if (frameIndex % VIDEO_FRAME_RATE === 0 || frameIndex === totalFrames - 1) {
          // 음성을 넣을 때는 뒤에 합치는 몫을 남겨 둔다.
          const ratio = frameIndex / (totalFrames - 1);
          setRecordingProgress(Math.round(ratio * (narrationBuffer ? 90 : 100)));
        }
      }

      if (audioSource && narrationBuffer) {
        setProgressLabel('음성을 영상에 얹는 중입니다…');
        setRecordingProgress(94);
        await audioSource.add(narrationBuffer);
        audioSource.close();
      }

      setProgressLabel('파일로 만드는 중입니다…');
      setRecordingProgress(97);
      await output.finalize();
      setRecordingProgress(100);

      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kbs-weather-${currentTarget}-${Date.now()}.mp4`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (recordError) {
      if (recordError?.name !== 'NotAllowedError') {
        setError(recordError?.message || '동영상 파일을 생성하지 못했습니다.');
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (sourceVideo) sourceVideo.srcObject = null;
      if (cleanCaptureActive) document.body.classList.remove('weather-video-capture');
      // 녹화가 켰던 순위표는 원래대로 꺼 둔다.
      if (rankingTouched) onRankingTable?.(false);
      setIsRecording(false);
      setRecordingProgress(0);
      setProgressLabel('');
    }
  };

  return (
    <>
      {/* 만드는 동안 무슨 일이 어디까지 진행됐는지 화면 한가운데에 크게 보여 준다.
          녹화 화면에는 찍히면 안 되므로 data-video-hide를 단다. */}
      {isRecording ? (
        <div
          data-video-hide
          className="absolute left-1/2 top-1/2 z-[60] w-[min(420px,86vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-slate-950/95 px-6 py-5 text-white shadow-2xl backdrop-blur-md"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 text-sm font-black">
            <Film className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            동영상을 만들고 있습니다
          </div>
          <div className="mt-3 flex items-end gap-2">
            <span className="text-3xl font-black tabular-nums text-cyan-300">
              {recordingProgress}
            </span>
            <span className="pb-1 text-sm font-bold text-white/50">%</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-cyan-400 transition-[width] duration-300"
              style={{ width: `${recordingProgress}%` }}
            />
          </div>
          <div className="mt-3 text-xs font-semibold text-white/60">
            {progressLabel || '화면을 찍는 중입니다…'}
          </div>
          <div className="mt-1 text-[11px] font-semibold text-white/35">
            끝날 때까지 이 탭을 그대로 두세요.
          </div>
        </div>
      ) : null}

      <div data-video-hide className="absolute right-6 top-6 z-50">
      <div className="w-[360px] rounded-lg border border-white/20 bg-slate-950/95 p-4 text-white shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-center">
            <div className="flex items-center gap-2 text-base font-black">
              <Film className="h-5 w-5 text-cyan-300" />
              동영상 생성
            </div>
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

            {/* 음성을 넣으면 영상 길이는 '동영상 길이'가 아니라 낭독 길이를 따른다.
                그동안 레이더는 되풀이해 돈다. */}
            <label className="col-span-2 flex cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-bold text-white/75">
              <input
                type="checkbox"
                checked={withNarration}
                onChange={handleNarrationToggle}
                className="h-4 w-4 accent-cyan-400"
              />
              <Volume2 className="h-4 w-4 text-cyan-300" aria-hidden="true" />
              음성 포함
              <span className="ml-auto font-semibold text-white/45">
                {narrationScript.trim()
                  ? `원고 ${narrationScript.replace(/\s/g, '').length}자`
                  : '원고 없음'}
              </span>
            </label>

            {withNarration ? (
              <div className="col-span-2 -mt-1 space-y-1 text-[11px] font-semibold leading-relaxed text-white/45">
                <div>
                  한 사이클은 관측 {CYCLE_PLAN[0].play}초 · 현재에서 {CYCLE_PLAN[0].hold}초 정지 ·
                  초단기 예측 {CYCLE_PLAN[1].play}초 · 끝에서 {CYCLE_PLAN[1].hold}초 정지로
                  {CYCLE_SEC}초이고, {CYCLE_COUNT}번 돌아 {CYCLE_SEC * CYCLE_COUNT}초입니다.
                  두 번째 사이클에서만 시간당 강수량 순위표가 나옵니다.
                  낭독이 더 길면 소리가 잘리지 않게 사이클을 더 돌립니다.
                </div>
                <div className="text-cyan-200/70">
                  시각은 3시간 전 ~ 1시간 뒤, 시작 화면은 전국,
                  {autoLabel ? ` 종료 화면은 ${autoLabel}로` : ' 종료 화면은 비가 가장 센 곳으로'}
                  {' '}자동으로 잡았습니다. 바꾸려면 아래에서 다시 지정하세요.
                </div>
              </div>
            ) : null}

            <div className="col-span-2 flex h-9 items-center justify-between rounded-md border border-white/10 bg-white/5 px-3 text-xs font-bold text-white/65">
              <span>출력 형식</span>
              <span className="text-white">1920 × 1080 · H.264 MP4</span>
            </div>

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
            {isRecording
              ? `MP4 생성 중 ${recordingProgress}%`
              : `${currentLabel} MP4 생성`}
          </button>
        </div>
      </div>
    </>
  );
}

export default VideoExportMenu;
