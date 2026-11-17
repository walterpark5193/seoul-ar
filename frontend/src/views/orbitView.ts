// #/3d: 같은 씬을 손가락으로 돌려 본다. 천천히 자동 회전(reduced-motion이면 멈춤), 바텀시트.
// #/3d?stage=1: 큰 화면 모드(CONTRACTS 13). 같은 씬·같은 라이브 따라가기지만 따라가기 고정, 직접 조작 없음,
// 무대가 살아 있는 동안은 자동 회전을 멈추고 정면에서 무대의 회전·확대를 그대로 보인다(CONTRACTS-stage 13.6),
// 바텀시트 대신 왼쪽 위 큰 제목·수치·AI 해설(views/stage.ts), 오른쪽 아래 관객용 QR, 잠시 움직임이 없으면 커서를 숨긴다.
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Narration } from "../data/narration";
import type { GuData } from "../data/types";
import type { AppState } from "../state/store";
import { drawQr } from "../ui/qr";
import { mountSheet } from "../ui/sheetDom";
import { STAGE_QR_HINT, isStageQuery, renderStage, stageAnnouncement } from "./stage";
import { bindStageFollow, createVoteLine, followLayout } from "./stageFollow";
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

/** 큰 화면이 무대의 yaw·zoom을 따라가는 속도(1/초). 값이 5Hz로 오므로 그 사이를 부드럽게 메운다. */
export const VIEW_FOLLOW_RATE = 8;

interface ViewTarget { rotation: { y: number }; scale: { setScalar(n: number): unknown } }

const TWO_PI = 2 * Math.PI;
/** (-π, π] 근처로 감싼다(가까운 쪽 각도 차이). */
const wrapAngle = (a: number) => a - TWO_PI * Math.round(a / TWO_PI);

export interface ViewFollowerOptions {
  /** 따라가는 속도(1/초). 기본 VIEW_FOLLOW_RATE. */
  rate?: number;
  /** 동작 줄이기: 보간 없이 다음 프레임에 목표 그대로. */
  reducedMotion?: boolean;
}

/**
 * 무대가 보낸 yaw·zoom을 도시 group에 부드럽게 적용한다(CONTRACTS-stage 13.6).
 * enabled가 false(일반 관객 폰)면 set은 아무 일도 하지 않아 group은 그대로다.
 * 새 목표 yaw는 직전 목표 기준으로 이어 붙인다(unwrap): 목표 사이가 180° 미만이면(5Hz 발행이면 900°/s 미만)
 * 표시가 목표를 늦게 따라가는 중이라도 무대가 돈 방향 그대로 돈다(거꾸로 짧은 쪽으로 돌지 않는다).
 */
export function createViewFollower(group: ViewTarget, enabled: boolean, opts: ViewFollowerOptions = {}) {
  const rate = opts.rate ?? VIEW_FOLLOW_RATE;
  // tYaw는 받은 yaw를 이어 붙인 연속 각도, lastYaw는 마지막으로 받은 원래 값.
  let yaw = 0, zoom = 1, tYaw = 0, tZoom = 1, lastYaw = 0;
  return {
    set(y: number, z: number): void {
      if (!enabled || !Number.isFinite(y) || !Number.isFinite(z)) return;
      tYaw += wrapAngle(y - lastYaw);
      lastYaw = y;
      tZoom = z;
    },
    /** 한 프레임. 표시 yaw는 연속 목표를 그대로 따라간다(여기서는 감싸지 않는다). */
    step(dt: number): void {
      if (!enabled) return;
      const k = opts.reducedMotion ? 1 : 1 - Math.exp(-rate * Math.max(dt, 0));
      const dy = tYaw - yaw;
      yaw = Math.abs(dy) < 1e-4 ? tYaw : yaw + dy * k;
      zoom = Math.abs(tZoom - zoom) < 1e-4 ? tZoom : zoom + (tZoom - zoom) * k;
      // 여러 바퀴 돌아도 수가 커지지 않게 표시와 목표를 함께 한 바퀴 단위로 되접는다(보이는 각도는 같다).
      const turns = TWO_PI * Math.round(yaw / TWO_PI);
      if (turns !== 0) { yaw -= turns; tYaw -= turns; }
      group.rotation.y = yaw;
      group.scale.setScalar(zoom);
    },
  };
}

/** createStageOrbit가 쓰는 OrbitControls 부분. */
interface OrbitLike {
  autoRotate: boolean;
  getAzimuthalAngle(): number;
  rotateLeft(angle: number): void;
}

/**
 * 큰 화면 카메라(CONTRACTS-stage 13.6). 무대 view를 따르는 동안(live: 최근 StageMessage가 살아 있는 동안) 자동 회전을 멈추고
 * 카메라를 정면(방위 0, 무대 카메라와 같은 +z 쪽)으로 가까운 쪽으로 되돌려, 도시 각도가 무대 yaw 그대로 보이게 한다.
 * 무대가 끊기면(stale) 자동 회전을 다시 켠다. reduced-motion이면 자동 회전은 늘 꺼져 있고 정면 복귀는 즉시다.
 * rotateLeft가 바로 반영되도록 감쇠(enableDamping)를 끈 컨트롤에 쓴다(큰 화면은 직접 조작이 없어 감쇠가 필요 없다).
 */
export function createStageOrbit(controls: OrbitLike, reducedMotion: boolean, rate = VIEW_FOLLOW_RATE) {
  let live = false;
  return {
    setLive(active: boolean): void {
      live = active;
      controls.autoRotate = !active && !reducedMotion;
    },
    /** 한 프레임(controls.update 뒤). 따르는 동안에만 남은 방위를 줄인다. */
    step(dt: number): void {
      if (!live) return;
      const a = wrapAngle(controls.getAzimuthalAngle());
      if (Math.abs(a) < 1e-6) return; // 이미 정면
      const k = reducedMotion || Math.abs(a) < 1e-4 ? 1 : 1 - Math.exp(-rate * Math.max(dt, 0));
      controls.rotateLeft(a * k);
    },
  };
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
    offset: (_w, h) => {
      const sheetH = host.getBoundingClientRect().height;
      // 무대 투표 결과 한 줄(.vote-line)이 시트 바로 위에 뜨게 시트 높이를 CSS 변수로 둔다(CONTRACTS-stage 10).
      root.style.setProperty("--sheet-h", `${Math.round(sheetH)}px`);
      return { x: 0, y: Math.min(sheetH, h * 0.6) / 2 };
    },
    observe: (ro) => ro.observe(host),
    destroy: () => sheet.destroy(),
  };
}

function stageSurface(root: HTMLElement, ctx: ViewContext): InfoSurface {
  const url = viewerUrl(ctx.config.appUrl, location);
  root.insertAdjacentHTML("beforeend",
    `<section class="stage-info" data-stage-info></section>` +
    // 화면 읽기 프로그램에는 패널 전체가 아니라 "구, 월"이 바뀔 때만 알린다.
    `<p class="vh" aria-live="polite" data-stage-announce></p>` +
    `<figure class="stage-qr"><canvas data-qr role="img" aria-label="관객용 주소 QR 코드"></canvas>` +
    `<figcaption>${STAGE_QR_HINT}</figcaption></figure>`);
  const info = root.querySelector<HTMLElement>("[data-stage-info]")!;
  const announce = root.querySelector<HTMLElement>("[data-stage-announce]")!;
  drawQr(root.querySelector<HTMLCanvasElement>("[data-qr]")!, url, 220).catch((err) => console.warn("[stage] QR을 그리지 못함", err));

  // 따라가기 고정: 큰 화면은 언제나 발표자를 따라간다.
  ctx.store.dispatch({ type: "follow" });
  const offFollow = ctx.store.subscribe((s) => { if (!s.follow) ctx.store.dispatch({ type: "follow" }); });

  // 커서 숨김: 잠시 움직임이 없으면.
  const viewer = root; // mountOrbitView가 .viewer 요소 자체를 넘긴다(자손이 아니다)
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    viewer.classList.remove("is-idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => viewer.classList.add("is-idle"), CURSOR_IDLE_MS);
  };
  viewer.addEventListener("pointermove", wake);
  wake();

  return {
    render: (s, d, n) => {
      info.innerHTML = renderStage(s, d, ctx.index, n);
      const text = stageAnnouncement(s);
      if (announce.textContent !== text) announce.textContent = text;
    },
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
  // 무대 투표 결과 한 줄은 바텀시트·큰 화면 모드 모두에 둔다(따라가기와 무관하게 6초 보인다).
  root.innerHTML = `<div class="viewer viewer--3d${stageMode ? " viewer--stage" : ""}"><div class="stage" data-stage></div>` +
    `<p class="vote-line" data-vote role="status" hidden></p></div>`;
  const viewerEl = root.querySelector<HTMLElement>(".viewer")!;
  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const surface = stageMode ? stageSurface(viewerEl, ctx) : sheetSurface(viewerEl, ctx);
  const sync = (onScene: (s: AppState, d: GuData | null) => void) => bindViewer({
    store: ctx.store,
    loadGu: ctx.loadGu,
    loadNarration: ctx.loadNarration,
    forgetNarration: ctx.forgetNarration,
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
  // 큰 화면은 직접 조작이 없어 감쇠가 쓸모없고, 정면 복귀(rotateLeft)가 바로 반영돼야 한다(createStageOrbit).
  controls.enableDamping = !stageMode;
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
  // 무대의 회전·확대는 큰 화면만 따른다. 일반 관객 폰은 값을 받아도 무시한다.
  const view = createViewFollower(city.group, stageMode, { reducedMotion: ctx.reducedMotion });
  // 큰 화면은 무대가 살아 있는 동안 자동 회전을 멈추고 정면에서 무대 각도를 그대로 보인다(일반 #/3d는 없음).
  const orbit = stageMode ? createStageOrbit(controls, ctx.reducedMotion) : null;

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
    orbit?.step(dt);
    view.step(dt);
    city.update(dt, camera);
    renderer.render(world, camera);
  });

  const unbind = sync((s, d) => drawCity(city, ctx.index, s, d));

  // 무대를 따라가기: 펼침·들어올림은 follow가 true일 때만, 투표 결과 한 줄은 늘 6초.
  const voteEl = root.querySelector<HTMLElement>("[data-vote]")!;
  const voteLine = createVoteLine(voteEl);
  const unbindFollow = bindStageFollow({
    channel: ctx.stageChannel,
    store: ctx.store,
    index: ctx.index,
    // 펼치기는 지표와 무관하게 늘 ㎡당 가격순(무대와 같다). 막대 색·시트는 현재 지표 그대로.
    onLayout: (mode) => followLayout(city, ctx.index, ctx.store.getState().month, mode),
    onLift: (gu) => city.lift(gu),
    onVote: (text) => voteLine.show(text),
    onView: stageMode ? (yaw, zoom) => view.set(yaw, zoom) : undefined,
    // StageMessage마다 true, 30초 무소식(stale)이면 false: 그동안 자동 회전을 멈춘다.
    onStage: orbit ? (active) => orbit.setLive(active) : undefined,
  });

  return () => {
    unbindFollow();
    voteLine.dispose();
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
