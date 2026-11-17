// #/3d: 같은 씬을 손가락으로 돌려 본다. 천천히 자동 회전(reduced-motion이면 멈춤), 바텀시트.
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mountSheet } from "../ui/sheetDom";
import type { MountView } from "./types";
import { bindViewer, drawCity } from "./viewerSync";

export const AUTO_ROTATE_RAD_PER_S = 0.3;
const RESUME_AFTER_MS = 4000;

/** OrbitControls.update(dt초)는 autoRotateSpeed × 2π/60 rad/s로 돈다. */
export function autoRotateSpeedFor(radPerSec: number): number {
  return (radPerSec * 60) / (2 * Math.PI);
}

function tryRenderer(): WebGLRenderer | null {
  try {
    return new WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    console.warn("[3d] WebGL을 만들 수 없음", err);
    return null;
  }
}

export const mountOrbitView: MountView = (root, ctx) => {
  root.innerHTML = `<div class="viewer viewer--3d">` +
    `<div class="stage" data-stage></div>` +
    `<a class="back" href="#/">처음으로</a>` +
    `<p class="stage-hint">한 손가락으로 돌리고, 두 손가락으로 확대합니다</p>` +
    `<div class="sheet-host" data-sheet></div>` +
    `</div>`;
  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const sheetHost = root.querySelector<HTMLElement>("[data-sheet]")!;
  const sheet = mountSheet(sheetHost, ctx.store, ctx.index, { altView: { href: "#/ar", label: "카메라로 보기" } });

  const renderer = tryRenderer();
  if (!renderer) {
    stage.innerHTML = `<p class="stage-fail">이 기기에서는 3D를 그릴 수 없습니다. 아래 수치는 그대로 볼 수 있습니다.</p>`;
    const unbind = bindViewer({ store: ctx.store, loadGu: ctx.loadGu, onScene: () => {}, onSheet: (s, d) => sheet.render(s, d) });
    return () => { unbind(); sheet.destroy(); root.innerHTML = ""; };
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "서울 25개 구 3D 지도. 수치는 아래 요약에 있습니다");
  stage.append(canvas);

  const world = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.01, 20);
  camera.position.set(0, 0.95, 1.1);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.04, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.45;
  controls.maxDistance = 2.6;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.autoRotate = !ctx.reducedMotion;
  controls.autoRotateSpeed = autoRotateSpeedFor(AUTO_ROTATE_RAD_PER_S);
  controls.update();

  // 손으로 돌리는 동안은 자동 회전을 멈추고, 손을 뗀 뒤 잠시 후 다시 돈다.
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const hint = root.querySelector<HTMLElement>(".stage-hint");
  const onStart = () => {
    if (hint) hint.hidden = true;
    controls.autoRotate = false;
    if (resumeTimer) clearTimeout(resumeTimer);
  };
  const onEnd = () => {
    if (ctx.reducedMotion) return;
    resumeTimer = setTimeout(() => { controls.autoRotate = true; }, RESUME_AFTER_MS);
  };
  controls.addEventListener("start", onStart);
  controls.addEventListener("end", onEnd);

  const city = ctx.createScene();
  world.add(city.group);

  // 바텀시트가 화면 아래를 덮으므로, 보이는 영역 가운데에 도시가 오도록 시야를 시트 높이의 절반만큼 올린다.
  const resize = () => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    const covered = Math.min(sheetHost.getBoundingClientRect().height, h * 0.6);
    camera.setViewOffset(w, h, 0, covered / 2, w, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  ro.observe(sheetHost);
  resize();

  let last = performance.now();
  renderer.setAnimationLoop((t: number) => {
    const dt = Math.min(Math.max((t - last) / 1000, 0), 0.1);
    last = t;
    controls.update(dt);
    city.update(dt, camera);
    renderer.render(world, camera);
  });

  const unbind = bindViewer({
    store: ctx.store,
    loadGu: ctx.loadGu,
    onScene: (s, d) => drawCity(city, ctx.index, s, d),
    onSheet: (s, d) => sheet.render(s, d),
  });

  return () => {
    unbind();
    sheet.destroy();
    if (resumeTimer) clearTimeout(resumeTimer);
    renderer.setAnimationLoop(null);
    ro.disconnect();
    controls.removeEventListener("start", onStart);
    controls.removeEventListener("end", onEnd);
    controls.dispose();
    city.dispose();
    renderer.dispose();
    root.innerHTML = "";
  };
};
