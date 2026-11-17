// 무대 화면의 three 렌더러와 카메라. 지도/펼치기 두 포즈 사이를 보간한다. 자동 회전 없음.
// 조명·안개는 씬(seoulScene)이 group에 담고 있어 orbitView처럼 여기서는 더하지 않는다.
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { easeOutCubic } from "../scene/seoulScene";
import type { StageMode, Vec3 } from "./types";

export interface CameraPose { pos: Vec3; target: Vec3; fov: number; }

// 약 55° 내려다봄
export const MAP_POSE: CameraPose = { pos: [0, 1.05, 0.75], target: [0, 0, 0.02], fov: 40 };
export const SPREAD_POSE: CameraPose = { pos: [0, 0.55, 1.35], target: [0, 0.12, 0.1], fov: 40 };

/**
 * 이 가로세로비보다 좁은 화면이면 카메라를 target은 그대로 두고 뒤로 물린다(거리 × FIT/aspect).
 * 펼친 호는 양 끝이 카메라 쪽으로 휘어 가로로 넓게 보인다. 기준 포즈는 약 2:1 창에서 맞으므로
 * 16:9·16:10·4:3 프로젝터에서는 물려야 1위·25위가 잘리지 않는다(stageRenderer.test의 투영 검사).
 */
export const SPREAD_FIT_ASPECT = 2.0;
/** 지도 포즈는 4:3까지 그대로 들어온다. 더 좁은 화면(세로 창 등)에서만 물린다. */
export const MAP_FIT_ASPECT = 4 / 3;

function pullBack(p: CameraPose, k: number): CameraPose {
  if (!(k > 1)) return p;
  const [tx, ty, tz] = p.target;
  return { pos: [tx + (p.pos[0] - tx) * k, ty + (p.pos[1] - ty) * k, tz + (p.pos[2] - tz) * k], target: p.target, fov: p.fov };
}

const validAspect = (aspect: number) => Number.isFinite(aspect) && aspect > 0;

/** 화면 비율에 맞춘 펼치기 포즈. 넓은 화면(≥ SPREAD_FIT_ASPECT)이나 잘못된 값이면 SPREAD_POSE 그대로. */
export function spreadPoseFor(aspect: number): CameraPose {
  return validAspect(aspect) ? pullBack(SPREAD_POSE, SPREAD_FIT_ASPECT / aspect) : SPREAD_POSE;
}

/** 화면 비율에 맞춘 지도 포즈. 4:3 이상이거나 잘못된 값이면 MAP_POSE 그대로. */
export function mapPoseFor(aspect: number): CameraPose {
  return validAspect(aspect) ? pullBack(MAP_POSE, MAP_FIT_ASPECT / aspect) : MAP_POSE;
}

/** 포즈 보간 시간(초). 본체 LAYOUT_SECONDS(0.8)와 같은 값이다. */
const CAMERA_SECONDS = 0.8;
const MAX_DT = 0.1;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** t 0~1. easeOutCubic은 호출자가 적용한다. */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  return { pos: mix3(a.pos, b.pos, t), target: mix3(a.target, b.target, t), fov: mix(a.fov, b.fov, t) };
}

export interface StageRenderer {
  world: Scene; camera: PerspectiveCamera; canvas: HTMLCanvasElement;
  setMode(mode: StageMode, instant?: boolean): void;
  /** target에서 카메라까지 거리를 1/z배로. 0.7~1.6 클램프. 모드 보간·resize 뒤에도 유지. */
  setZoom(z: number): void;
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

  let mode: StageMode = "map";
  let current: CameraPose = MAP_POSE;
  let from: CameraPose = MAP_POSE;
  let to: CameraPose = MAP_POSE;
  let elapsed = CAMERA_SECONDS; // >= CAMERA_SECONDS면 보간 끝

  let zoom = 1;
  // current는 확대 전 기준 포즈(보간 대상). 카메라에만 확대를 얹는다.
  const apply = (p: CameraPose) => {
    current = p;
    const [tx, ty, tz] = p.target;
    camera.position.set(tx + (p.pos[0] - tx) / zoom, ty + (p.pos[1] - ty) / zoom, tz + (p.pos[2] - tz) / zoom);
    camera.lookAt(...p.target);
    if (camera.fov !== p.fov) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
  };
  apply(MAP_POSE);
  const poseFor = (m: StageMode) => (m === "spread" ? spreadPoseFor(camera.aspect) : mapPoseFor(camera.aspect));

  const setMode = (next: StageMode, instant = false) => {
    mode = next;
    const dest = poseFor(next);
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

  const setZoom = (z: number) => {
    zoom = Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1;
    apply(current);
  };

  const resize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 비율이 바뀌면 지금 모드의 포즈도 다시 맞춘다. 보간 중이면 지금 자리에서 새 목적지로 다시 보간한다(순간이동 없음).
    const dest = poseFor(mode);
    if (elapsed >= CAMERA_SECONDS) { from = to = dest; apply(dest); }
    else { from = current; to = dest; elapsed = 0; }
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
    world, camera, canvas, setMode, setZoom, resize,
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
