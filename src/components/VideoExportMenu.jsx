import { useEffect, useMemo, useState } from 'react';
import { Check, Download, Film, MapPin } from 'lucide-react';
import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny';

const VIDEO_TARGETS = [
  { id: 'radar', label: '레이더' },
  { id: 'tracking', label: '호우추적' },
  { id: 'terrain', label: '지형호우' },
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
  onPreparePlayback,
  onStartPlayback,
}) {
  const [startInput, setStartInput] = useState(defaultStart);
  const [endInput, setEndInput] = useState(defaultEnd);
  const [durationSec, setDurationSec] = useState(10);
  const [startCamera, setStartCamera] = useState(null);
  const [endCamera, setEndCamera] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
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

    let stream = null;
    let sourceVideo = null;
    let cleanCaptureActive = false;
    try {
      setIsRecording(true);
      setRecordingProgress(0);
      setError('');
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
      await output.start();

      const map = mapRef.current;
      map?.jumpTo?.(startCamera);
      await wait(180);
      drawVideoFrame(context, sourceVideo);
      const frameDuration = 1 / VIDEO_FRAME_RATE;
      await videoSource.add(0, frameDuration);
      map?.easeTo?.({ ...endCamera, duration: durationSec * 1000, essential: true });
      onStartPlayback?.({ start: startInput, end: endInput, durationSec });

      const totalFrames = durationSec * VIDEO_FRAME_RATE;
      const startedAt = performance.now();
      for (let frameIndex = 1; frameIndex < totalFrames; frameIndex += 1) {
        const targetTime = startedAt + frameIndex * (1000 / VIDEO_FRAME_RATE);
        await wait(Math.max(0, targetTime - performance.now()));
        if (!drawVideoFrame(context, sourceVideo)) continue;
        await videoSource.add(frameIndex / VIDEO_FRAME_RATE, frameDuration);
        if (frameIndex % VIDEO_FRAME_RATE === 0 || frameIndex === totalFrames - 1) {
          setRecordingProgress(Math.round((frameIndex / (totalFrames - 1)) * 100));
        }
      }
      await output.finalize();

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
      setIsRecording(false);
      setRecordingProgress(0);
    }
  };

  return (
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
  );
}

export default VideoExportMenu;
