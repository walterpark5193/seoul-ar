// 인식기 어댑터: 카메라 + MediaPipe GestureRecognizer → HandFrame. 계약: docs/CONTRACTS-stage.md 2.4.
// 프론트에서 @mediapipe/tasks-vision을 import하는 유일한 파일이며, 동적 import만 쓴다.
import type { GestureName, HandFrame, HandObs } from "../types";
import { VOTE_MAX } from "../types";

export const MODEL_PATH = "/models/gesture_recognizer.task";
export const WASM_PATH = "/mediapipe/wasm";
export type HandSourceError = "no-camera" | "denied" | "model-missing" | "wasm-failed" | "unsupported";
export interface HandSource {
  readonly video: HTMLVideoElement; readonly fps: number; readonly loadMs: number | null; readonly delegate: "GPU" | "CPU";
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
}

const FPS_WINDOW = 30;

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

export async function startHandSource(deps: HandSourceDeps = {}): Promise<{ ok: true; source: HandSource } | { ok: false; reason: HandSourceError }> {
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

  const modelExists = deps.modelExists
    ?? (async () => (await fetch(MODEL_PATH, { method: "HEAD" })).ok);
  let exists = false;
  try { exists = await modelExists(); } catch { exists = false; }
  if (!exists) { stopTracks(stream); return { ok: false, reason: "model-missing" }; }

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
  let handle: number | null = null;
  const rvfc = typeof video.requestVideoFrameCallback === "function";

  const schedule = () => {
    if (stopped) return;
    handle = rvfc
      ? video.requestVideoFrameCallback(step)
      : requestAnimationFrame(() => step(performance.now()));
  };
  const step = (now: number) => {
    if (stopped) return;
    if (video.readyState >= 2) {
      const t = now;
      try {
        const frame = toHandFrame(recognizer.recognizeForVideo(video, t) as unknown as RecognizerResultLike, t);
        stamps.push(t);
        if (stamps.length > FPS_WINDOW) stamps.shift();
        if (stamps.length > 1) {
          const span = stamps[stamps.length - 1]! - stamps[0]!;
          fps = span > 0 ? ((stamps.length - 1) * 1000) / span : 0;
        }
        for (const cb of [...listeners]) cb(frame);
      } catch { /* 한 프레임 실패는 건너뛴다(타임스탬프 역행 등) */ }
    }
    schedule();
  };
  schedule();

  const source: HandSource = {
    video, loadMs, delegate,
    get fps() { return fps; },
    onFrame(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    stop() {
      if (stopped) return;
      stopped = true;
      if (handle !== null) { if (rvfc) video.cancelVideoFrameCallback?.(handle); else cancelAnimationFrame(handle); }
      listeners.clear();
      try { recognizer.close(); } catch { /* 이미 닫힘 */ }
      stopTracks(stream);
      video.srcObject = null;
    },
  };
  return { ok: true, source };
}
