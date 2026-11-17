// #/3d: 같은 씬을 손가락으로 돌려 본다. 천천히 자동 회전(reduced-motion이면 멈춤), 바텀시트.
// #/3d?stage=1: 큰 화면 모드(CONTRACTS 13). 같은 씬·같은 라이브 따라가기지만 따라가기 고정, 직접 조작 없음,
// 바텀시트 대신 왼쪽 위 큰 제목·수치·AI 해설(views/stage.ts), 오른쪽 아래 관객용 QR, 잠시 움직임이 없으면 커서를 숨긴다.
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Narration } from "../data/narration";
import type { GuData } from "../data/types";
import type { AppState } from "../state/store";
import { drawQr } from "../ui/qr";
import { mountSheet } from "../ui/sheetDom";
import { STAGE_QR_HINT, isStageQuery, renderStage } from "./stage";
import type { MountView, ViewContext } from "./types";
import { viewerUrl } from "./urls";
import { bindViewer, drawCity } from "./viewerSync";

export const AUTO_ROTATE_RAD_PER_S = 0.3;
const RESUME_AFTER_MS = 4000;
const CURSOR_IDLE_MS = 2500;

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

/** 수치를 보여 주는 면: 보통은 바텀시트, 큰 화면 모드는 왼쪽 위 패널. */
interface InfoSurface {
  render(s: AppState, d: GuData | null, n: Narration | null): void;
  /** 정보 면이 덮는 만큼 시야를 옮긴다(px). 시트는 위로, 큰 화면 패널은 오른쪽으로. */
  offset(w: number, h: number): { x: number; y: number };
  observe(ro: ResizeObserver): void;
  destroy(): void;
}

function sheetSurface(root: HTMLElement, ctx: ViewContext): InfoSurface {
  root.insertAdjacentHTML("beforeend",
    `<a class="back" href="#/">처음으로</a>` +
    `<p class="stage-hint">한 손가락으로 돌리고, 두 손가락으로 확대합니다</p>` +
    `<div class="sheet-host" data-sheet></div>`);
  const host = root.querySelector<HTMLElement>("[data-sheet]")!;
  const sheet = mountSheet(host, ctx.store, () => ctx.index, { altView: { href: "#/ar", label: "카메라로 보기" } });
  return {
    render: (s, d, n) => sheet.render(s, d, n),
    offset: (_w, h) => ({ x: 0, y: Math.min(host.getBoundingClientRect().height, h * 0.6) / 2 }),
    observe: (ro) => ro.observe(host),
    destroy: () => sheet.destroy(),
  };
}

function stageSurface(root: HTMLElement, ctx: ViewContext): InfoSurface {
  const url = viewerUrl(ctx.config.appUrl, location);
  root.insertAdjacentHTML("beforeend",
    `<section class="stage-info" data-stage-info aria-live="polite"></section>` +
    `<figure class="stage-qr"><canvas data-qr role="img" aria-label="관객용 주소 QR 코드"></canvas>` +
    `<figcaption>${STAGE_QR_HINT}</figcaption></figure>`);
  const info = root.querySelector<HTMLElement>("[data-stage-info]")!;
  drawQr(root.querySelector<HTMLCanvasElement>("[data-qr]")!, url, 220).catch((err) => console.warn("[stage] QR을 그리지 못함", err));

  // 따라가기 고정: 큰 화면은 언제나 발표자를 따라간다.
  ctx.store.dispatch({ type: "follow" });
  const offFollow = ctx.store.subscribe((s) => { if (!s.follow) ctx.store.dispatch({ type: "follow" }); });

  // 커서 숨김: 잠시 움직임이 없으면.
  const viewer = root.querySelector<HTMLElement>(".viewer")!;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    viewer.classList.remove("is-idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => viewer.classList.add("is-idle"), CURSOR_IDLE_MS);
  };
  viewer.addEventListener("pointermove", wake);
  wake();

  return {
    render: (s, d, n) => { info.innerHTML = renderStage(s, d, ctx.index, n); },
    offset: (w) => ({ x: -w * 0.14, y: 0 }), // 왼쪽 위 큰 글씨를 피해 도시를 조금 오른쪽에
    observe: () => {},
    destroy: () => {
      offFollow();
      viewer.removeEventListener("pointermove", wake);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

export const mountOrbitView: MountView = (root, ctx) => {
  const stageMode = isStageQuery(ctx.query);
  root.innerHTML = `<div class="viewer viewer--3d${stageMode ? " viewer--stage" : ""}"><div class="stage" data-stage></div></div>`;
  const viewerEl = root.querySelector<HTMLElement>(".viewer")!;
  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const surface = stageMode ? stageSurface(viewerEl, ctx) : sheetSurface(viewerEl, ctx);
  const sync = (onScene: (s: AppState, d: GuData | null) => void) => bindViewer({
    store: ctx.store,
    loadGu: ctx.loadGu,
    loadNarration: ctx.loadNarration,
    onScene,
    onSheet: (s, d, n) => surface.render(s, d, n),
  });

  const renderer = tryRenderer();
  if (!renderer) {
    stage.innerHTML = `<p class="stage-fail">이 기기에서는 3D를 그릴 수 없습니다. 수치는 그대로 볼 수 있습니다.</p>`;
    const unbind = sync(() => {});
    return () => { unbind(); surface.destroy(); root.innerHTML = ""; };
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", stageMode ? "서울 25개 구 3D 지도" : "서울 25개 구 3D 지도. 수치는 아래 요약에 있습니다");
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
  controls.enabled = !stageMode; // 큰 화면은 직접 조작하지 않는다(자동 회전은 enabled와 무관하게 돈다)
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

  // 정보 면(바텀시트나 큰 화면 패널)을 피해, 보이는 영역 가운데에 도시가 오도록 시야를 옮긴다.
  const resize = () => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    const off = surface.offset(w, h);
    camera.setViewOffset(w, h, off.x, off.y, w, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  surface.observe(ro);
  resize();

  let last = performance.now();
  renderer.setAnimationLoop((t: number) => {
    const dt = Math.min(Math.max((t - last) / 1000, 0), 0.1);
    last = t;
    controls.update(dt);
    city.update(dt, camera);
    renderer.render(world, camera);
  });

  const unbind = sync((s, d) => drawCity(city, ctx.index, s, d));

  return () => {
    unbind();
    surface.destroy();
    if (resumeTimer) clearTimeout(resumeTimer);
    renderer.setAnimationLoop(null);
    ro.disconnect();
    controls.removeEventListener("start", onStart);
    controls.removeEventListener("end", onEnd);
    controls.dispose();
    city.dispose();
    renderer.dispose();
    // #/ar ↔ #/3d를 여러 번 오가도 브라우저의 WebGL 컨텍스트 상한에 걸리지 않게 즉시 반납한다.
    renderer.forceContextLoss();
    root.innerHTML = "";
  };
};
