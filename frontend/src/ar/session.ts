// AR session wrapper around MindAR's three.js integration (CONTRACTS 5).
//
// The app view calls `createArSession({ container, targetSrc: "/marker/target.mind" })`, adds the
// Seoul scene group to `anchor`, registers `onFrame`, and calls `start()` from a tap handler
// (iOS Safari needs HTTPS and a user gesture before the camera can start).
import type { Camera, Scene, WebGLRenderer } from "three";
import { Group, Quaternion, Vector3 } from "three";
import { MindARThree } from "mind-ar/dist/mindar-image-three.prod.js";
import {
  INITIAL_FOLLOWER,
  resolveSmoothing,
  stepFollower,
  type ArSmoothing,
  type FollowerState,
  type Pose,
} from "./smoothing";

export type { ArSmoothing } from "./smoothing";
export { SMOOTHING_DEFAULTS } from "./smoothing";

export interface ArSession {
  anchor: Group; // group pinned to the image target; add seoulScene.group here
  scene: Scene;
  camera: Camera;
  renderer: WebGLRenderer;
  start(): Promise<void>; // starts the camera; call from a user gesture
  stop(): void;
  onFound(cb: () => void): void;
  onLost(cb: () => void): void;
  onFrame(cb: (dt: number) => void): void; // render-loop tick, dt in seconds
  freeze(): void; // pause the camera video and pose updates, keep the last pose; render loop keeps running
  unfreeze(): void; // resume video and pose updates
  readonly frozen: boolean;
  onFreeze(cb: (frozen: boolean) => void): () => void;
}

export interface ArSessionOptions {
  container: HTMLElement;
  targetSrc: string; // "/marker/target.mind"
  smoothing?: ArSmoothing; // second-stage follower smoothing, defaults in SMOOTHING_DEFAULTS
  filterMinCF?: number; // MindAR One-Euro min cutoff (cycles per ms; 0.001 = 1 Hz). Default 0.0001: steadier, slower
  filterBeta?: number; // MindAR One-Euro speed coefficient. Default 0.01: barely loosens on fast motion
  warmupTolerance?: number; // consecutive detections before "found" (5)
  missTolerance?: number; // consecutive misses before "lost" (10: brief occlusions do not flicker)
}

/**
 * MindAR constructor params as consumed by its controller (`new OneEuroFilter({minCutOff: filterMinCF,
 * beta: filterBeta})`, trackCount > warmupTolerance -> showing, trackMiss > missTolerance -> hidden).
 * MindAR's own defaults are 0.001 / 1000 / 5 / 5; these are the CONTRACTS 5 values.
 */
export const FILTER_DEFAULTS = { filterMinCF: 0.0001, filterBeta: 0.01, warmupTolerance: 5, missTolerance: 10 } as const;

/** Longest dt handed to onFrame; after a hidden tab or a stall, animations resume instead of jumping. */
const MAX_DT = 0.1;

/**
 * Once the camera stream is live, MindAR's start() must settle within this. In mind-ar 1.2.5
 * `_startAR`/`addImageTargets` are `new Promise(async …)` wrappers that never reject: a truncated
 * download or a msgpack error becomes an unhandled rejection and the promise hangs forever — with the
 * camera already live.
 */
export const START_TIMEOUT_MS = 15_000;
/** Time allowed for the user to answer the camera permission prompt (stream not live yet). */
export const PERMISSION_TIMEOUT_MS = 60_000;
const STREAM_POLL_MS = 100;
const LATE_STREAM_POLL_MS = 500;
const LATE_STREAM_WATCH_MS = 10 * 60_000;

const noop = (): void => {};
const STOPPED = Symbol("ar-session-stopped");

/** The subset of HTMLVideoElement we touch; typed loosely so tests can hand in plain objects. */
interface VideoLike {
  srcObject?: unknown;
  pause?: () => void;
  play?: () => unknown;
  remove?: () => void;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
}

interface Deadline {
  promise: Promise<never>;
  clear(): void;
}

function deadline(ms: number, message: string): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  promise.catch(noop);
  return { promise, clear: () => clearTimeout(timer) };
}

/** Resolves when a camera stream lands on the video element (srcObject set / metadata / playing). */
function waitForStream(video: VideoLike | undefined, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!video) return; // nothing to observe; the permission deadline covers this
    let timer: ReturnType<typeof setInterval> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearInterval(timer);
      video.removeEventListener?.("loadedmetadata", done);
      video.removeEventListener?.("playing", done);
      signal.removeEventListener("abort", cleanup);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const check = (): void => {
      if (video.srcObject) done();
    };
    video.addEventListener?.("loadedmetadata", done);
    video.addEventListener?.("playing", done);
    signal.addEventListener("abort", cleanup);
    timer = setInterval(check, STREAM_POLL_MS);
    check();
  });
}

/** Stop the tracks of a stream on this element (if any) and detach the element. Never touches MindAR state. */
function manualRelease(video: VideoLike | undefined): void {
  if (!video) return;
  try {
    const stream = video.srcObject as { getTracks?: () => Array<{ stop(): void }> } | null | undefined;
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // no stream
  }
  try {
    video.remove?.();
  } catch {
    // already detached
  }
}

interface Attempt {
  generation: number; // stop() count when the attempt began
  seq: number; // monotonically increasing attempt id
  video: VideoLike | undefined; // the <video> MindAR created for this attempt
  abort: AbortController; // aborted by stop() and when the attempt settles
  promise: Promise<void>;
}

export function createArSession(opts: ArSessionOptions): ArSession {
  // MindAR's own loading/scanning/error overlays attach to document.body; the app owns UX, so
  // they are disabled and the view reacts to onFound/onLost instead.
  const mindar = new MindARThree({
    container: opts.container,
    imageTargetSrc: opts.targetSrc,
    uiLoading: "no",
    uiScanning: "no",
    uiError: "no",
    filterMinCF: opts.filterMinCF ?? FILTER_DEFAULTS.filterMinCF,
    filterBeta: opts.filterBeta ?? FILTER_DEFAULTS.filterBeta,
    warmupTolerance: opts.warmupTolerance ?? FILTER_DEFAULTS.warmupTolerance,
    missTolerance: opts.missTolerance ?? FILTER_DEFAULTS.missTolerance,
  });
  const { renderer, scene, camera } = mindar;
  const mindarAnchor = mindar.addAnchor(0);
  const smoothing = resolveSmoothing(opts.smoothing);
  const videoOf = (): VideoLike | undefined => mindar.video as VideoLike | undefined;

  // Scene graph: MindAR's anchor group is only read, never parented. A follower group under `scene`
  // chases its pose with deadband + smoothing (CONTRACTS 5 "안정화와 고정"); inside it, the inner
  // group rotated +90° about x maps the scene's XZ/y-up frame onto the picture (scene y rises out
  // of the picture toward the camera, scene +z (south) is the bottom edge, so north stays up).
  const follower = new Group();
  follower.name = "ar-follower";
  follower.visible = false;
  const inner = new Group();
  inner.name = "ar-anchor";
  inner.rotation.x = Math.PI / 2;
  follower.add(inner);
  scene.add(follower);

  const foundCbs: Array<() => void> = [];
  const lostCbs: Array<() => void> = [];
  const frameCbs: Array<(dt: number) => void> = [];
  const freezeCbs: Array<(frozen: boolean) => void> = [];

  let running = false;
  let frozen = false;
  let generation = 0; // bumped by stop(); attempts compare against it
  let attemptSeq = 0;
  let attempt: Attempt | null = null;
  let lastTime: number | null = null;
  let followerState: FollowerState = INITIAL_FOLLOWER;
  let announcedFound = false;

  // ---- follower update (per frame) ----
  const tmpPos = new Vector3();
  const tmpQuat = new Quaternion();
  const tmpScale = new Vector3();
  const readMindArPose = (): { pose: Pose; scale: number } | null => {
    if (mindarAnchor.visible !== true) return null;
    mindarAnchor.group.matrix.decompose(tmpPos, tmpQuat, tmpScale);
    const scale = tmpScale.x;
    if (!Number.isFinite(scale) || scale <= 0) return null; // MindAR's all-zero "invisible" matrix
    return {
      pose: { position: [tmpPos.x, tmpPos.y, tmpPos.z], quaternion: [tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w] },
      scale,
    };
  };
  const applyFollower = (state: FollowerState, scale: number | null): void => {
    follower.visible = state.visible;
    if (state.pose) {
      follower.position.set(state.pose.position[0], state.pose.position[1], state.pose.position[2]);
      follower.quaternion.set(state.pose.quaternion[0], state.pose.quaternion[1], state.pose.quaternion[2], state.pose.quaternion[3]);
    }
    if (scale !== null) follower.scale.setScalar(scale);
  };
  const resetFollower = (): void => {
    followerState = INITIAL_FOLLOWER;
    follower.visible = false;
    announcedFound = false;
  };

  const tick = (time: number): void => {
    const dt = lastTime === null ? 0 : Math.min(Math.max((time - lastTime) / 1000, 0), MAX_DT);
    lastTime = time;
    if (!frozen) {
      const seen = readMindArPose();
      followerState = stepFollower(
        followerState,
        { visible: seen !== null, pose: seen?.pose ?? null, scale: seen?.scale ?? 1, time, dt },
        smoothing,
      );
      applyFollower(followerState, seen?.scale ?? null);
      // found/lost follow the follower (debounced by the hold), and are suppressed while frozen.
      if (announcedFound !== followerState.visible) {
        announcedFound = followerState.visible;
        for (const cb of announcedFound ? foundCbs : lostCbs) cb();
      }
    }
    for (const cb of frameCbs) cb(dt);
    renderer.render(scene, camera);
  };

  // ---- camera release ----
  /** Release an attempt's camera. For an older attempt's element never call mindar.stop() (that would kill the live one). */
  const releaseAttempt = (video: VideoLike | undefined): void => {
    const current = videoOf();
    if (video && current && video !== current) {
      manualRelease(video);
      return;
    }
    try {
      mindar.stop(); // stops processing, camera tracks, removes the <video>
    } catch {
      manualRelease(video ?? current); // MindAR throws when its controller or stream never came up
    }
  };
  /** After a failed attempt, a stream granted late must not stay live on the detached element. */
  const watchLateStream = (video: VideoLike | undefined): void => {
    if (!video) return;
    const until = Date.now() + LATE_STREAM_WATCH_MS;
    const timer = setInterval(() => {
      if (videoOf() === video && running) {
        clearInterval(timer); // it is the live session's element after all
        return;
      }
      if (video.srcObject) {
        clearInterval(timer);
        manualRelease(video);
        return;
      }
      if (Date.now() > until) clearInterval(timer);
    }, LATE_STREAM_POLL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  // ---- target preflight (starts at construction so it is usually done before the tap) ----
  let preflight: { promise: Promise<void>; abort: AbortController } | null = null;
  const ensurePreflight = (): Promise<void> => {
    if (!preflight) {
      const abort = new AbortController();
      const rec = { promise: assertTargetReadable(opts.targetSrc, abort.signal), abort };
      rec.promise.then(noop, () => {
        if (preflight === rec) preflight = null; // failures are not cached: the next start() re-fetches
      });
      preflight = rec;
    }
    return preflight.promise;
  };
  ensurePreflight();

  // ---- start attempt ----
  const runAttempt = async (rec: Attempt): Promise<void> => {
    const g = rec.generation;
    try {
      await ensurePreflight(); // MindAR's own loader never rejects on a bad file; check it before the camera
    } catch (err) {
      if (generation !== g) return; // stop() aborted the preflight: settle quietly
      throw err;
    }
    if (generation !== g) return; // stopped between the preflight and the camera

    const mindarStart = mindar.start();
    mindarStart.catch(noop); // observed through the races below
    const video = (rec.video = videoOf());
    const stopped = new Promise<never>((_, reject) => {
      rec.abort.signal.addEventListener("abort", () => reject(STOPPED), { once: true });
    });
    stopped.catch(noop);
    const permission = deadline(
      PERMISSION_TIMEOUT_MS,
      `카메라 권한 응답을 ${PERMISSION_TIMEOUT_MS / 1000}초 동안 받지 못했습니다. 브라우저의 카메라 허용 요청에 응답했는지 확인해 주세요.`,
    );
    let arDeadline: Deadline | null = null;
    const onLateSettle = (): void => {
      // MindAR's start() landed after we gave up on this attempt (timeout or stop()).
      const superseded = attemptSeq !== rec.seq || running;
      if (superseded) manualRelease(video); // only this attempt's orphan stream, never the live session
      else releaseAttempt(video);
    };
    try {
      const first = await Promise.race([
        mindarStart.then(() => "done" as const),
        waitForStream(video, rec.abort.signal).then(() => "stream" as const),
        permission.promise,
        stopped,
      ]);
      if (first === "stream") {
        permission.clear();
        arDeadline = deadline(
          START_TIMEOUT_MS,
          `AR을 ${START_TIMEOUT_MS / 1000}초 안에 시작하지 못했습니다. 타깃 파일(${opts.targetSrc})을 읽지 못한 것일 수 있습니다.`,
        );
        await Promise.race([mindarStart, arDeadline.promise, stopped]);
      }
    } catch (err) {
      if (err === STOPPED || generation !== g) {
        mindarStart.then(onLateSettle, noop); // stop() released what existed; release again if the stream lands later
        return;
      }
      releaseAttempt(video); // on a deadline the stream may already be live
      mindarStart.then(onLateSettle, noop);
      watchLateStream(video);
      // MindAR rejects with `undefined` when getUserMedia is missing or denied.
      throw err instanceof Error ? err : new Error("카메라를 시작할 수 없습니다. 카메라 권한을 허용했는지, HTTPS로 열었는지 확인해 주세요.");
    } finally {
      permission.clear();
      arDeadline?.clear();
      rec.abort.abort(); // tears down waitForStream and the `stopped` promise
    }
    if (generation !== g) {
      releaseAttempt(video); // stop() ran while MindAR was finishing (permission prompt case)
      return;
    }
    running = true;
    lastTime = null;
    resetFollower();
    renderer.setAnimationLoop(tick);
  };

  const emitFreeze = (value: boolean): void => {
    for (const cb of [...freezeCbs]) cb(value);
  };

  return {
    anchor: inner,
    scene,
    camera,
    renderer,
    start() {
      if (running) return Promise.resolve();
      if (attempt && attempt.generation === generation) return attempt.promise; // share the in-flight attempt
      const rec: Attempt = { generation, seq: ++attemptSeq, video: undefined, abort: new AbortController(), promise: Promise.resolve() };
      attempt = rec;
      rec.promise = runAttempt(rec).finally(() => {
        if (attempt === rec) attempt = null;
      });
      return rec.promise;
    },
    stop() {
      generation++;
      renderer.setAnimationLoop(null);
      if (preflight) {
        preflight.abort.abort();
        preflight = null;
      }
      const rec = attempt;
      attempt = null; // a start() after stop() must build a fresh attempt, not reuse the doomed one
      rec?.abort.abort();
      const wasRunning = running;
      running = false;
      frozen = false; // a stopped session is not frozen; the view resets its own UI
      resetFollower();
      if (wasRunning) releaseAttempt(undefined);
      else if (rec?.video) releaseAttempt(rec.video); // camera prompt may be open: release what exists now
    },
    onFound(cb) { foundCbs.push(cb); },
    onLost(cb) { lostCbs.push(cb); },
    onFrame(cb) { frameCbs.push(cb); },
    freeze() {
      if (frozen) return;
      frozen = true;
      try {
        videoOf()?.pause?.();
      } catch {
        // no video yet
      }
      emitFreeze(true);
    },
    unfreeze() {
      if (!frozen) return;
      frozen = false;
      if (followerState.lostAt !== null) followerState = { ...followerState, lostAt: null }; // restart the hold
      try {
        const played = videoOf()?.play?.();
        if (played && typeof (played as Promise<void>).catch === "function") (played as Promise<void>).catch(noop);
      } catch {
        // no video yet
      }
      emitFreeze(false);
    },
    get frozen() {
      return frozen;
    },
    onFreeze(cb) {
      freezeCbs.push(cb);
      return () => {
        const i = freezeCbs.indexOf(cb);
        if (i >= 0) freezeCbs.splice(i, 1);
      };
    },
  };
}

/** Fetch the .mind up front and reject early with a clear message; the browser cache makes MindAR's own fetch cheap. */
async function assertTargetReadable(url: string, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    throw new Error(`타깃 파일을 가져오지 못했습니다: ${url} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new Error(`타깃 파일을 가져오지 못했습니다: ${url} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`타깃 파일이 비어 있습니다: ${url}`);
  const b0 = bytes[0]!;
  const isMsgpackMap = (b0 >= 0x80 && b0 <= 0x8f) || b0 === 0xde || b0 === 0xdf; // .mind = msgpack map { v, dataList }
  if (!isMsgpackMap) {
    throw new Error(`타깃 파일이 .mind 형식이 아닙니다: ${url} (첫 바이트 0x${b0.toString(16)}; SPA 폴백으로 index.html이 내려온 것일 수 있습니다)`);
  }
}

// ---- capability check (pure; dependencies injectable for tests) ----

interface NavigatorLike { mediaDevices?: { getUserMedia?: unknown } }
interface CanvasLike { getContext(kind: string): unknown }
export interface ArSupportDeps {
  nav?: NavigatorLike | undefined;
  createCanvas?: (() => CanvasLike | null) | undefined;
}

function defaultDeps(): ArSupportDeps {
  const g = globalThis as { navigator?: NavigatorLike; document?: { createElement(tag: string): unknown } };
  return {
    nav: g.navigator,
    createCanvas: g.document ? () => g.document!.createElement("canvas") as CanvasLike : undefined,
  };
}

/** navigator.mediaDevices.getUserMedia exists AND a WebGL (2 or 1) context can be created. */
export function arSupported(deps: ArSupportDeps = defaultDeps()): boolean {
  if (typeof deps.nav?.mediaDevices?.getUserMedia !== "function") return false;
  try {
    const canvas = deps.createCanvas?.();
    if (!canvas) return false;
    for (const kind of ["webgl2", "webgl", "experimental-webgl"]) {
      if (canvas.getContext(kind)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
