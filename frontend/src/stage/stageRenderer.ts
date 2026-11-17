// 무대 화면의 three 렌더러와 카메라. 지도/펼치기 두 포즈 사이를 보간한다. 자동 회전 없음.
// 조명·안개는 씬(seoulScene)이 group에 담고 있어 orbitView처럼 여기서는 더하지 않는다.
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { easeOutCubic } from "../scene/seoulScene";
import type { StageMode, Vec3 } from "./types";

export interface CameraPose { pos: Vec3; target: Vec3; fov: number; }

// 약 55° 내려다봄
export const MAP_POSE: CameraPose = { pos: [0, 1.05, 0.75], target: [0, 0, 0.02], fov: 40 };
export const SPREAD_POSE: CameraPose = { pos: [0, 0.55, 1.35], target: [0, 0.12, 0.1], fov: 40 };

/** 포즈 보간 시간(초). 본체 LAYOUT_SECONDS(0.8)와 같은 값이다. */
const CAMERA_SECONDS = 0.8;
const MAX_DT = 0.1;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** t 0~1. easeOutCubic은 호출자가 적용한다. */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return { pos: mix3(a.pos, b.pos, t), target: mix3(a.target, b.target, t), fov: mix(a.fov, b.fov, t) };
}

export interface StageRenderer {
  world: Scene; camera: PerspectiveCamera; canvas: HTMLCanvasElement;
  setMode(mode: StageMode, instant?: boolean): void;
  onFrame(cb: (dt: number) => void): () => void; resize(): void; dispose(): void;
}

function defaultMakeRenderer(): WebGLRenderer | null {
  try {
    return new WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    console.warn("[stage] WebGL을 만들 수 없음", err);
    return null;
  }
}

export function createStageRenderer(
  container: HTMLElement,
  opts: { reducedMotion: boolean; makeRenderer?: () => WebGLRenderer | null },
): StageRenderer | null {
  const renderer = (opts.makeRenderer ?? defaultMakeRenderer)();
  if (!renderer) return null;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "서울 25개 구 3D 지도");
  container.append(canvas);

  const world = new Scene();
  const camera = new PerspectiveCamera(MAP_POSE.fov, 1, 0.01, 20);

  let current: CameraPose = MAP_POSE;
  let from: CameraPose = MAP_POSE;
  let to: CameraPose = MAP_POSE;
  let elapsed = CAMERA_SECONDS; // >= CAMERA_SECONDS면 보간 끝

  const apply = (p: CameraPose) => {
    current = p;
    camera.position.set(...p.pos);
    camera.lookAt(...p.target);
    if (camera.fov !== p.fov) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
  };
  apply(MAP_POSE);

  const setMode = (mode: StageMode, instant = false) => {
    const dest = mode === "spread" ? SPREAD_POSE : MAP_POSE;
    if (instant || opts.reducedMotion) {
      from = to = dest;
      elapsed = CAMERA_SECONDS;
      apply(dest);
      return;
    }
    from = current;
    to = dest;
    elapsed = 0;
  };

  const resize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  ro?.observe(container);
  resize();

  const listeners = new Set<(dt: number) => void>();
  let last = performance.now();
  renderer.setAnimationLoop((t: number) => {
    const dt = Math.min(Math.max((t - last) / 1000, 0), MAX_DT);
    last = t;
    if (elapsed < CAMERA_SECONDS) {
      elapsed = Math.min(elapsed + dt, CAMERA_SECONDS);
      apply(lerpPose(from, to, easeOutCubic(elapsed / CAMERA_SECONDS)));
    }
    for (const cb of [...listeners]) cb(dt);
    renderer.render(world, camera);
  });

  return {
    world, camera, canvas, setMode, resize,
    onFrame(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    dispose() {
      renderer.setAnimationLoop(null);
      ro?.disconnect();
      listeners.clear();
      canvas.remove();
      renderer.dispose();
    },
  };
}
