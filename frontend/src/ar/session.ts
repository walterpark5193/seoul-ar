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
  let generation = 0; // bumped by stop(); a start() that lands after a stop() must not leave the camera on
  let lastTime: number | null = null;
  const tick = (time: number): void => {
    const dt = lastTime === null ? 0 : Math.min(Math.max((time - lastTime) / 1000, 0), MAX_DT);
    lastTime = time;
    for (const cb of frameCbs) cb(dt);
    renderer.render(scene, camera);
  };

  return {
    anchor: inner,
    scene,
    camera,
    renderer,
    async start() {
      if (running) return;
      const myGeneration = generation;
      try {
        await mindar.start();
      } catch (err) {
        // MindAR rejects with `undefined` when getUserMedia is missing or denied.
        throw err instanceof Error ? err : new Error("카메라를 시작할 수 없습니다. 카메라 권한을 허용했는지, HTTPS로 열었는지 확인해 주세요.");
      }
      if (myGeneration !== generation) {
        // stop() ran while the permission prompt was open: release what MindAR just acquired.
        try { mindar.stop(); } catch { /* nothing was acquired */ }
        return;
      }
      running = true;
      lastTime = null;
      renderer.setAnimationLoop(tick);
    },
    stop() {
      generation++;
      renderer.setAnimationLoop(null);
      if (!running) return;
      running = false;
      try {
        mindar.stop(); // stops video processing and camera tracks, removes the <video>
      } catch {
        // MindAR throws if the video element never came up; nothing left to release.
      }
    },
    onFound(cb) { foundCbs.push(cb); },
    onLost(cb) { lostCbs.push(cb); },
    onFrame(cb) { frameCbs.push(cb); },
  };
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
