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

/** The .mind preflight fetch must answer within this (it usually finished long before the tap). */
export const PREFLIGHT_TIMEOUT_MS = 15_000;
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
  error: Error;
  clear(): void;
}

function deadline(ms: number, message: string): Deadline {
  const error = new Error(message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  promise.catch(noop);
  return { promise, error, clear: () => clearTimeout(timer) };
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

/**
 * One MindAR `start()` in flight. MindAR keeps `this.video` / `this.controller` as instance fields and
 * its getUserMedia handler writes the stream to the *current* `this.video`, so two overlapping starts
 * would orphan a stream and leak a controller. We therefore never call `mindar.start()` while an
 * earlier one is unsettled: a retry adopts the pending start (fresh deadlines) or, if we already
 * killed its stream, waits (bounded) for it to settle before starting anew.
 */
interface PendingStart {
  promise: Promise<void>;
  video: VideoLike | undefined; // MindAR's <video> for this start
  settled: boolean;
  adopter: number | null; // seq of the attempt currently waiting on it; null = abandoned
  killed: boolean; // we stopped its stream / detached its element; cannot be adopted any more
  watch: AbortController | null; // late-stream watcher while abandoned and stream-less
}

interface Attempt {
  generation: number; // stop() count when the attempt began
  seq: number; // monotonically increasing attempt id
  pending: PendingStart | null; // the MindAR start this attempt is waiting on
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
  let pendingStart: PendingStart | null = null;
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
    tmpQuat.normalize();
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
  /** MindAR's stop() leaves the anchor flags and matrix as they were; a fresh start must not replay them. */
  const resetMindArAnchor = (): void => {
    mindarAnchor.visible = false;
    mindarAnchor.group.visible = false;
    mindarAnchor.group.matrix.identity();
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

  // ---- camera / MindAR start bookkeeping ----
  /** Full release of whatever MindAR currently holds (processing loop, stream tracks, <video>). */
  const releaseCamera = (): void => {
    try {
      mindar.stop();
    } catch {
      manualRelease(videoOf()); // MindAR throws when its controller or stream never came up
    }
  };

  const createPendingStart = (): PendingStart => {
    const promise = mindar.start();
    const ps: PendingStart = { promise, video: videoOf(), settled: false, adopter: null, killed: false, watch: null };
    const settle = (ok: boolean): void => {
      ps.settled = true;
      ps.watch?.abort();
      ps.watch = null;
      if (pendingStart === ps) pendingStart = null;
      if (ps.adopter !== null || running) return; // somebody is using it
      if (ok) releaseCamera(); // landed with nobody waiting: camera off
      else manualRelease(ps.video); // denied: just drop the element
    };
    promise.then(() => settle(true), () => settle(false));
    pendingStart = ps;
    return ps;
  };

  const adopt = (ps: PendingStart, seq: number): void => {
    ps.adopter = seq;
    ps.watch?.abort();
    ps.watch = null;
  };

  /** Stop the stream of an abandoned, still-unsettled start; it can no longer be adopted. */
  const kill = (ps: PendingStart): void => {
    ps.killed = true;
    ps.watch?.abort();
    ps.watch = null;
    try {
      mindar.stop();
    } catch {
      manualRelease(ps.video);
    }
  };

  /** Attempt `seq` gives up on `ps`: release now if there is a stream, otherwise catch a late one. */
  const abandon = (ps: PendingStart, seq: number): void => {
    if (ps.adopter !== seq) return; // not ours (already abandoned or re-adopted by a newer attempt)
    ps.adopter = null;
    if (ps.settled) {
      if (!running) releaseCamera();
      return;
    }
    if (ps.video?.srcObject) {
      kill(ps); // stream live, start unsettled (user left or _startAR hangs): camera off now
      return;
    }
    // Permission prompt still open: a stream granted later must not stay live with nobody using it.
    const ctrl = new AbortController();
    ps.watch = ctrl;
    const until = Date.now() + LATE_STREAM_WATCH_MS;
    const timer = setInterval(() => {
      if (ctrl.signal.aborted || ps.settled) {
        clearInterval(timer);
        return;
      }
      if (ps.video?.srcObject) {
        clearInterval(timer);
        kill(ps);
        return;
      }
      if (Date.now() > until) clearInterval(timer);
    }, LATE_STREAM_POLL_MS);
    ctrl.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  // ---- target preflight (starts at construction so it is usually done before the tap) ----
  let preflight: { promise: Promise<void>; abort: AbortController } | null = null;
  const ensurePreflight = (): { promise: Promise<void>; abort: AbortController } => {
    if (!preflight) {
      const abort = new AbortController();
      const rec = { promise: assertTargetReadable(opts.targetSrc, abort.signal), abort };
      rec.promise.then(noop, () => {
        if (preflight === rec) preflight = null; // failures are not cached: the next start() re-fetches
      });
      preflight = rec;
    }
    return preflight;
  };
  ensurePreflight();

  const AR_TIMEOUT_MESSAGE = `AR을 ${START_TIMEOUT_MS / 1000}초 안에 시작하지 못했습니다. 타깃 파일(${opts.targetSrc})을 읽지 못한 것일 수 있습니다.`;

  // ---- start attempt ----
  const runAttempt = async (rec: Attempt): Promise<void> => {
    const g = rec.generation;
    const isStopped = (): boolean => generation !== g;
    const stopped = new Promise<never>((_, reject) => {
      rec.abort.signal.addEventListener("abort", () => reject(STOPPED), { once: true });
    });
    stopped.catch(noop);

    // 1. Target preflight, bounded. MindAR's own loader never rejects on a bad file.
    const pf = ensurePreflight();
    const pfDeadline = deadline(PREFLIGHT_TIMEOUT_MS, `타깃 파일을 ${PREFLIGHT_TIMEOUT_MS / 1000}초 안에 가져오지 못했습니다: ${opts.targetSrc}`);
    try {
      await Promise.race([pf.promise, pfDeadline.promise, stopped]);
    } catch (err) {
      if (err === STOPPED || isStopped()) return; // stop() during the preflight: settle quietly
      if (err === pfDeadline.error) {
        pf.abort.abort(); // drop the stalled fetch so a retry can start a fresh one
        if (preflight === pf) preflight = null;
      }
      throw err;
    } finally {
      pfDeadline.clear();
    }
    if (isStopped()) return; // stopped between the preflight and the camera

    // 2. MindAR start: never two in flight.
    let ps = pendingStart;
    if (ps && !ps.settled && ps.killed) {
      // Its stream is dead but MindAR is still inside start(); wait (bounded) for it to settle.
      const wait = deadline(START_TIMEOUT_MS, AR_TIMEOUT_MESSAGE);
      try {
        await Promise.race([ps.promise.then(noop, noop), wait.promise, stopped]);
      } catch (err) {
        if (err === STOPPED || isStopped()) return;
        throw err;
      } finally {
        wait.clear();
      }
      if (isStopped()) return;
    }
    ps = pendingStart && !pendingStart.settled ? pendingStart : createPendingStart(); // adopt or start fresh
    adopt(ps, rec.seq);
    rec.pending = ps;
    const video = ps.video;

    // 3. Permission deadline until the stream is live, then the AR-start deadline.
    const permission = deadline(
      PERMISSION_TIMEOUT_MS,
      `카메라 권한 응답을 ${PERMISSION_TIMEOUT_MS / 1000}초 동안 받지 못했습니다. 브라우저의 카메라 허용 요청에 응답했는지 확인해 주세요.`,
    );
    let arDeadline: Deadline | null = null;
    try {
      const phase = video?.srcObject
        ? ("stream" as const) // adopted a start whose camera is already live
        : await Promise.race([
            ps.promise.then(() => "done" as const),
            waitForStream(video, rec.abort.signal).then(() => "stream" as const),
            permission.promise,
            stopped,
          ]);
      if (phase === "stream") {
        permission.clear();
        arDeadline = deadline(START_TIMEOUT_MS, AR_TIMEOUT_MESSAGE);
        await Promise.race([ps.promise, arDeadline.promise, stopped]);
      }
    } catch (err) {
      abandon(ps, rec.seq); // kills a live stream now, or when it lands; the settle handler finishes the job
      if (err === STOPPED || isStopped()) return;
      // MindAR rejects with `undefined` when getUserMedia is missing or denied.
      throw err instanceof Error ? err : new Error("카메라를 시작할 수 없습니다. 카메라 권한을 허용했는지, HTTPS로 열었는지 확인해 주세요.");
    } finally {
      permission.clear();
      arDeadline?.clear();
      rec.abort.abort(); // tears down waitForStream and the `stopped` promise
    }
    if (isStopped()) {
      abandon(ps, rec.seq); // stop() ran while MindAR was finishing: release what it acquired
      return;
    }
    resetMindArAnchor();
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
      const rec: Attempt = { generation, seq: ++attemptSeq, pending: null, abort: new AbortController(), promise: Promise.resolve() };
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
      if (wasRunning) releaseCamera();
      else if (rec?.pending) abandon(rec.pending, rec.seq); // prompt open or MindAR finishing: release now or when the stream lands
      resetFollower();
      resetMindArAnchor();
      if (frozen) {
        frozen = false; // a stopped session is not frozen
        emitFreeze(false);
      }
    },
    onFound(cb) { foundCbs.push(cb); },
    onLost(cb) { lostCbs.push(cb); },
    onFrame(cb) { frameCbs.push(cb); },
    freeze() {
      if (frozen || !running) return; // nothing to freeze before the camera runs
      frozen = true;
      try {
        videoOf()?.pause?.();
      } catch {
        // no video
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
        // no video
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
