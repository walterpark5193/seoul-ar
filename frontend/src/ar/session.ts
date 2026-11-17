// AR session wrapper around MindAR's three.js integration (CONTRACTS 5).
//
// The app view calls `createArSession({ container, targetSrc: "/marker/target.mind" })`, adds the
// Seoul scene group to `anchor`, registers `onFrame`, and calls `start()` from a tap handler
// (iOS Safari needs HTTPS and a user gesture before the camera can start).
import type { Camera, Scene, WebGLRenderer } from "three";
import { Group } from "three";
import { MindARThree } from "mind-ar/dist/mindar-image-three.prod.js";

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
}

export interface ArSessionOptions {
  container: HTMLElement;
  targetSrc: string; // "/marker/target.mind"
}

/** Longest dt handed to onFrame; after a hidden tab or a stall, animations resume instead of jumping. */
const MAX_DT = 0.1;

/**
 * start() must settle within this. MindAR 1.2.5's start() is `await _startVideo(); await _startAR()`
 * where `_startAR`/`addImageTargets` are `new Promise(async …)` wrappers that never reject: a 404,
 * an SPA fallback page, a truncated download or a msgpack error becomes an unhandled rejection and
 * the promise hangs forever — with the camera already live.
 */
export const START_TIMEOUT_MS = 15_000;

export function createArSession(opts: ArSessionOptions): ArSession {
  // MindAR's own loading/scanning/error overlays attach to document.body; the app owns UX, so
  // they are disabled and the view reacts to onFound/onLost instead.
  const mindar = new MindARThree({
    container: opts.container,
    imageTargetSrc: opts.targetSrc,
    uiLoading: "no",
    uiScanning: "no",
    uiError: "no",
  });
  const { renderer, scene, camera } = mindar;
  const anchor = mindar.addAnchor(0);

  // Coordinate systems (CONTRACTS 5, 2026-11-17 amendment): MindAR lays the target picture on the
  // anchor group's XY plane with +z toward the camera, while the Seoul scene (CONTRACTS 4) is built
  // on the XZ plane with +y up and +z = south. Rotating an inner group by +90° about x maps the
  // scene's y onto MindAR's z (the city rises out of the picture) and the scene's z onto -y
  // (south is the bottom edge of the picture, so north stays up).
  const inner = new Group();
  inner.rotation.x = Math.PI / 2;
  anchor.group.add(inner);

  const foundCbs: Array<() => void> = [];
  const lostCbs: Array<() => void> = [];
  const frameCbs: Array<(dt: number) => void> = [];
  anchor.onTargetFound = () => { for (const cb of foundCbs) cb(); };
  anchor.onTargetLost = () => { for (const cb of lostCbs) cb(); };

  let running = false;
  let pending: Promise<void> | null = null; // a start() in flight
  let generation = 0; // bumped by stop(); a start() that lands after a stop() must not leave the camera on
  let lastTime: number | null = null;
  const tick = (time: number): void => {
    const dt = lastTime === null ? 0 : Math.min(Math.max((time - lastTime) / 1000, 0), MAX_DT);
    lastTime = time;
    for (const cb of frameCbs) cb(dt);
    renderer.render(scene, camera);
  };

  /** Stop video processing, camera tracks and the <video>; tolerant of a half-started MindAR. */
  const releaseCamera = (): void => {
    try {
      mindar.stop();
      return;
    } catch {
      // MindAR throws when its controller or stream never came up; release what exists by hand.
    }
    try {
      const video = mindar.video;
      const stream = video?.srcObject as { getTracks?: () => Array<{ stop(): void }> } | null | undefined;
      stream?.getTracks?.().forEach((track) => track.stop());
      video?.remove();
    } catch {
      // nothing left to release
    }
  };

  const run = async (): Promise<void> => {
    const myGeneration = generation;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`AR을 ${START_TIMEOUT_MS / 1000}초 안에 시작하지 못했습니다. 타깃 파일(${opts.targetSrc})을 읽지 못한 것일 수 있습니다.`));
      }, START_TIMEOUT_MS);
    });
    let mindarStart: Promise<void> | null = null;
    try {
      // Check the target before touching the camera: MindAR's own loader never rejects on a bad file.
      await Promise.race([assertTargetReadable(opts.targetSrc, abort.signal), deadline]);
      mindarStart = mindar.start();
      await Promise.race([mindarStart, deadline]);
    } catch (err) {
      releaseCamera(); // on a timeout the stream is already live; on a getUserMedia failure this is a no-op
      if (mindarStart) mindarStart.then(releaseCamera, () => {}); // a late success must not leave the camera on
      // MindAR rejects with `undefined` when getUserMedia is missing or denied.
      throw err instanceof Error ? err : new Error("카메라를 시작할 수 없습니다. 카메라 권한을 허용했는지, HTTPS로 열었는지 확인해 주세요.");
    } finally {
      clearTimeout(timer);
    }
    if (myGeneration !== generation) {
      releaseCamera(); // stop() ran while the permission prompt was open
      return;
    }
    running = true;
    lastTime = null;
    renderer.setAnimationLoop(tick);
  };

  return {
    anchor: inner,
    scene,
    camera,
    renderer,
    start() {
      if (running) return Promise.resolve();
      if (!pending) pending = run().finally(() => { pending = null; });
      return pending;
    },
    stop() {
      generation++;
      renderer.setAnimationLoop(null);
      if (!running && !pending) return;
      running = false;
      releaseCamera();
    },
    onFound(cb) { foundCbs.push(cb); },
    onLost(cb) { lostCbs.push(cb); },
    onFrame(cb) { frameCbs.push(cb); },
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
