// 인식기 어댑터: 카메라 + MediaPipe GestureRecognizer → HandFrame. 계약: docs/CONTRACTS-stage.md 2.4.
// 프론트에서 @mediapipe/tasks-vision을 import하는 유일한 파일이며, 동적 import만 쓴다.
// 판은 0.10.35로 고정한다(package.json). 1.x는 createFromOptions에서 사용 통계 로거를 조건 없이 만들어
// 1분마다 Google로 POST하고 끄는 옵션이 없다. 0.10.35에는 그 로거가 없다(scripts/check-bundle.mjs가 빌드마다 확인).
import type { GestureName, HandFrame, HandObs } from "../types";
import { VOTE_MAX } from "../types";

export const MODEL_PATH = "/models/gesture_recognizer.task";
export const WASM_PATH = "/mediapipe/wasm";
export type HandSourceError = "no-camera" | "denied" | "model-missing" | "wasm-failed" | "unsupported";
export interface HandSource {
  readonly video: HTMLVideoElement; readonly fps: number; readonly loadMs: number | null; readonly delegate: "GPU" | "CPU";
  /** recognizeForVideo 연속 실패 횟수(성공하면 0). 많이 쌓이면 호출 측이 마우스 입력으로 폴백한다. */
  readonly errors: number;
  onFrame(cb: (f: HandFrame) => void): () => void; stop(): void;
}
export interface RecognizerResultLike {
  gestures: { categoryName: string; score: number }[][];
  landmarks: { x: number; y: number; z: number }[][];
  handedness?: { categoryName: string; score: number }[][]; handednesses?: { categoryName: string; score: number }[][];
}

const GESTURES: readonly GestureName[] = ["None", "Closed_Fist", "Open_Palm", "Pointing_Up", "Thumb_Down", "Thumb_Up", "Victory", "ILoveYou"];

export function toHandFrame(result: RecognizerResultLike, t: number): HandFrame {
  const sides = result.handedness ?? result.handednesses ?? [];
  const hands: HandObs[] = result.landmarks.map((lms, i) => {
    const g = result.gestures[i]?.[0];
    const name = g?.categoryName as GestureName | undefined;
    const side = sides[i]?.[0]?.categoryName;
    return {
      landmarks: lms.map(p => [p.x, p.y, p.z] as [number, number, number]),
      gesture: name && GESTURES.includes(name) ? name : "None",
      score: g?.score ?? 0,
      handedness: side === "Left" || side === "Right" ? side : "Unknown",
    };
  });
  return { t, hands };
}

export interface HandSourceDeps {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  loadVision?: () => Promise<typeof import("@mediapipe/tasks-vision")>;
  modelExists?: () => Promise<boolean>;                              // 기본: fetch(MODEL_PATH, {method:"HEAD"}).ok
  createVideo?: () => HTMLVideoElement;                              // 기본: document.createElement("video")
  fetchImpl?: typeof fetch;                                          // 기본 modelExists에서만 사용
}

const FPS_WINDOW = 30;
/**
 * 영상이 재생 중인데 requestVideoFrameCallback이 이만큼 새 프레임을 주지 않으면 그 루프를 rAF + currentTime 확인으로
 * 바꾸고 계속 그 길로 간다. 일부 브라우저는 video가 렌더 트리에서 빠지면(display:none 등) 이 콜백을 멈춘다.
 */
export const RVFC_STALL_MS = 500;
/** 감시 rAF 사이가 이보다 벌어지면(숨은 탭에서 돌아옴·긴 멈춤) 그 사이는 rVFC 정지로 세지 않는다. */
const WATCH_GAP_MS = 250;

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

export async function startHandSource(deps: HandSourceDeps = {}): Promise<{ ok: true; source: HandSource } | { ok: false; reason: HandSourceError }> {
  if (typeof WebAssembly === "undefined") return { ok: false, reason: "unsupported" };
  const modelExists = deps.modelExists
    ?? (async () => {
      // SPA 폴백(CloudFront 403/404 → index.html, Vite dev)은 200 + text/html이므로 없는 모델로 본다.
      const res = await (deps.fetchImpl ?? fetch)(MODEL_PATH, { method: "HEAD" });
      return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
    });
  let exists = false;
  try { exists = await modelExists(); } catch { exists = false; }
  if (!exists) return { ok: false, reason: "model-missing" };

  const getUserMedia = deps.getUserMedia
    ?? (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
      ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
      : undefined);
  if (!getUserMedia) return { ok: false, reason: "no-camera" };

  let stream: MediaStream;
  try {
    stream = await getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" }, audio: false });
  } catch (e) {
    return { ok: false, reason: (e as { name?: string })?.name === "NotAllowedError" ? "denied" : "no-camera" };
  }

  const loadStart = performance.now();
  let recognizer: Awaited<ReturnType<typeof import("@mediapipe/tasks-vision").GestureRecognizer.createFromOptions>>;
  let delegate: "GPU" | "CPU" = "GPU";
  try {
    const vision = await (deps.loadVision ?? (() => import("@mediapipe/tasks-vision")))();
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
    const create = (d: "GPU" | "CPU") => vision.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: d }, runningMode: "VIDEO", numHands: VOTE_MAX,
    });
    try { recognizer = await create("GPU"); }
    catch { delegate = "CPU"; recognizer = await create("CPU"); }
  } catch {
    stopTracks(stream);
    return { ok: false, reason: "wasm-failed" };
  }
  const loadMs = performance.now() - loadStart;

  const video = deps.createVideo ? deps.createVideo() : document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* 자동재생 거부여도 프레임 루프는 readyState로 거른다 */ }

  const listeners = new Set<(f: HandFrame) => void>();
  const stamps: number[] = [];
  let fps = 0;
  let stopped = false;
  // 프레임 루프: rVFC가 있으면 새 영상 프레임마다, 없거나 rVFC가 멈춰 바꾼 뒤로는 rAF마다 돌며 currentTime이 바뀐 때만 처리한다.
  let viaRvfc = typeof video.requestVideoFrameCallback === "function";
  let handle: number | null = null;  // 다음 step 예약(viaRvfc면 rVFC, 아니면 rAF)
  let rvfcFrames = 0;                // rVFC가 준 프레임 수(감시용)

  const schedule = () => {
    if (stopped) return;
    handle = viaRvfc ? video.requestVideoFrameCallback(onVideoFrame) : requestAnimationFrame(onAnimationFrame);
  };
  const onVideoFrame = (now: number) => {
    if (!viaRvfc) return; // rAF로 바꾼 뒤 늦게 온 콜백: rAF 루프가 맡는다(같은 프레임 두 번·루프 둘 방지)
    handle = null;
    rvfcFrames++;
    step(now, true);
  };
  const onAnimationFrame = () => {
    handle = null;
    step(performance.now(), false);
  };
  let errors = 0;
  let warnedRecognize = false;
  const warnedListeners = new WeakSet<(f: HandFrame) => void>();
  let lastVideoTime = -1;
  const step = (now: number, newFrame: boolean) => {
    if (stopped) return;
    const fresh = newFrame || video.currentTime !== lastVideoTime;
    if (video.readyState >= 2 && fresh) {
      lastVideoTime = video.currentTime;
      let frame: HandFrame | null = null;
      try {
        frame = toHandFrame(recognizer.recognizeForVideo(video, now), now); // GestureRecognizerResult ⊂ RecognizerResultLike(tsc가 확인)
        errors = 0;
      } catch (e) {
        errors++;
        if (!warnedRecognize) { warnedRecognize = true; console.warn("[stage] recognizeForVideo 실패", e); }
      }
      if (frame) {
        stamps.push(now);
        if (stamps.length > FPS_WINDOW) stamps.shift();
        if (stamps.length > 1) {
          const span = stamps[stamps.length - 1]! - stamps[0]!;
          fps = span > 0 ? ((stamps.length - 1) * 1000) / span : 0;
        }
        for (const cb of [...listeners]) {
          try { cb(frame); }
          catch (e) {
            if (!warnedListeners.has(cb)) { warnedListeners.add(cb); console.warn("[stage] onFrame 리스너 오류", e); }
          }
        }
      }
    }
    schedule();
  };

  // rVFC 감시: 화면 프레임(rAF)마다 rVFC가 새 프레임을 줬는지 본다. 재생 중인데 RVFC_STALL_MS 동안 없으면 rAF 길로 바꾼다.
  // 숨은 탭에서는 rAF도 쉬므로 잘못 바꾸지 않고, 돌아온 직후의 긴 간격은 WATCH_GAP_MS로 거른다.
  let watchHandle: number | null = null;
  let seenFrames = 0;
  let quietSince = 0;
  let lastWatch = -Infinity;
  const watch = (t: number) => {
    watchHandle = null;
    if (stopped || !viaRvfc) return;
    const playing = video.readyState >= 2 && !video.paused;
    if (rvfcFrames !== seenFrames || !playing || t - lastWatch > WATCH_GAP_MS) { seenFrames = rvfcFrames; quietSince = t; }
    lastWatch = t;
    if (t - quietSince < RVFC_STALL_MS) { watchHandle = requestAnimationFrame(watch); return; }
    console.warn(`[stage] 영상 프레임 콜백이 ${RVFC_STALL_MS}ms 넘게 오지 않아 rAF로 바꿉니다`);
    viaRvfc = false;
    if (handle !== null) video.cancelVideoFrameCallback?.(handle);
    handle = null;
    schedule();
  };

  schedule();
  if (viaRvfc && typeof requestAnimationFrame === "function") watchHandle = requestAnimationFrame(watch);

  const source: HandSource = {
    video, loadMs, delegate,
    get fps() { return fps; },
    get errors() { return errors; },
    onFrame(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    stop() {
      if (stopped) return;
      stopped = true;
      if (handle !== null) { if (viaRvfc) video.cancelVideoFrameCallback?.(handle); else cancelAnimationFrame(handle); }
      if (watchHandle !== null) cancelAnimationFrame(watchHandle);
      listeners.clear();
      try { recognizer.close(); } catch { /* 이미 닫힘 */ }
      stopTracks(stream);
      video.srcObject = null;
    },
  };
  return { ok: true, source };
}
