// #/ar: 시작 버튼(iOS는 사용자 제스처 필요) → 카메라 → 그림 인식 시 그 위에 서울 → 바텀시트.
// 카메라를 못 쓰면 #/3d로 보내고 이유를 토스트로 알린다.
import type { ArSession, ArSessionOptions } from "../ar/session";
import type { SeoulScene } from "../scene/seoulScene";
import type { AppState } from "../state/store";
import type { GuData } from "../data/types";
import { mountSheet } from "../ui/sheetDom";
import type { MountView } from "./types";
import { isStageMessage } from "../stage/net/messages";
import { bindStageFollow } from "./stageFollow";
import { bindViewer, drawCity } from "./viewerSync";

export const TARGET_SRC = "/marker/target.mind";
export const STAGE_BANNER_TEXT = "무대 진행 중 · 3D로 따라가기";
export const VOTE_LINE_MS = 6000;
export const UNSUPPORTED_MESSAGE = "이 브라우저에서는 카메라 AR을 쓸 수 없어 3D 화면으로 바꿨습니다.";

export function fallbackMessage(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "카메라 권한이 없어 3D 화면으로 바꿨습니다. 설정에서 카메라를 허용하면 다시 쓸 수 있습니다.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "카메라를 찾지 못해 3D 화면으로 바꿨습니다.";
  return "카메라를 켜지 못해 3D 화면으로 바꿨습니다.";
}

export interface BeginArOptions {
  container: HTMLElement;
  createArSession(opts: ArSessionOptions): ArSession;
  createScene(): SeoulScene;
  onFound(): void;
  onLost(): void;
  onFail(err: unknown): void;
}

export interface RunningAr { session: ArSession; city: SeoulScene; stop(): void; }

/**
 * 세션은 이 뷰가 만들고 끝내므로 세션의 WebGL 렌더러도 여기서 반납한다.
 * #/ar ↔ #/3d를 여러 번 오가도 브라우저의 WebGL 컨텍스트 상한에 걸리지 않게 한다.
 */
function releaseRenderer(session: ArSession): void {
  try {
    session.renderer.dispose();
    session.renderer.forceContextLoss();
  } catch (err) {
    console.warn("[ar] 렌더러 반납 실패", err);
  }
}

/**
 * 씬 그룹을 세션 앵커에 그대로 붙인다. 좌표 변환(XZ 씬 → MindAR XY 그림, X축 +90°)은
 * CONTRACTS 5절 보강대로 ArSession.anchor가 이미 하고 있다.
 */
export async function beginAr(o: BeginArOptions): Promise<RunningAr | null> {
  const city = o.createScene();
  let session: ArSession | null = null;
  try {
    const s = o.createArSession({ container: o.container, targetSrc: TARGET_SRC });
    session = s;
    s.anchor.add(city.group);
    s.onFrame((dt) => city.update(dt, s.camera));
    s.onFound(o.onFound);
    s.onLost(o.onLost);
    await s.start();
    return {
      session: s,
      city,
      stop() {
        s.stop();
        city.dispose();
        releaseRenderer(s);
      },
    };
  } catch (err) {
    try { session?.stop(); } catch { /* 시작 전 실패면 멈출 것이 없다 */ }
    if (session) releaseRenderer(session);
    city.dispose();
    o.onFail(err);
    return null;
  }
}

export const mountArView: MountView = (root, ctx) => {
  if (!ctx.ar.arSupported()) {
    ctx.toast(UNSUPPORTED_MESSAGE);
    ctx.navigate("#/3d");
    return () => {};
  }

  root.innerHTML = `<div class="viewer viewer--ar">` +
    `<div class="stage" data-stage></div>` +
    `<a class="back" href="#/">처음으로</a>` +
    `<section class="ar-intro" data-intro aria-labelledby="ar-intro-title">` +
    `<h1 class="ar-intro-title" id="ar-intro-title">카메라를 켜면<br>그림 위에 서울이 섭니다</h1>` +
    `<p class="ar-intro-body">발표 화면에 뜬 그림이 폰 화면에 들어오게 들어 주세요. 카메라 영상은 이 폰 밖으로 보내지 않습니다.</p>` +
    `<button type="button" class="btn btn-primary" data-start>카메라 켜기</button>` +
    `<a class="btn btn-quiet" href="#/3d">카메라 없이 3D로 보기</a>` +
    `</section>` +
    `<div class="scan" data-scan hidden><div class="scan-frame" aria-hidden="true"></div>` +
    `<p class="scan-text" role="status">슬라이드의 그림을 비춰 주세요</p></div>` +
    `<button type="button" class="stage-banner" data-banner hidden>${STAGE_BANNER_TEXT}</button>` +
    `<p class="vote-line" data-vote role="status" hidden></p>` +
    `<div class="sheet-host" data-sheet hidden></div>` +
    `</div>`;

  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const intro = root.querySelector<HTMLElement>("[data-intro]")!;
  const scan = root.querySelector<HTMLElement>("[data-scan]")!;
  const sheetHost = root.querySelector<HTMLElement>("[data-sheet]")!;
  const startBtn = root.querySelector<HTMLButtonElement>("[data-start]")!;

  const sheet = mountSheet(sheetHost, ctx.store, ctx.index, { altView: { href: "#/3d", label: "3D로 보기" } });
  let alive = true;
  let running: RunningAr | null = null;
  let pending: [AppState, GuData | null] | null = null;

  const unbind = bindViewer({
    store: ctx.store,
    loadGu: ctx.loadGu,
    onScene: (s, d) => {
      pending = [s, d];
      if (running) drawCity(running.city, ctx.index, s, d);
    },
    onSheet: (s, d) => sheet.render(s, d),
  });

  // AR에서는 씬을 직접 움직이지 않는다. 무대 메시지를 처음 받으면 배너로 3D 따라가기를 권한다.
  const banner = root.querySelector<HTMLButtonElement>("[data-banner]")!;
  const voteEl = root.querySelector<HTMLElement>("[data-vote]")!;
  banner.addEventListener("click", () => ctx.navigate("#/3d"));
  let voteTimer: ReturnType<typeof setTimeout> | null = null;
  const offBanner = ctx.stageChannel.subscribe((m) => {
    if (isStageMessage(m)) banner.hidden = false; // follow와 무관하게 처음 받으면 보인다
  });
  const offVote = bindStageFollow({
    channel: ctx.stageChannel,
    store: ctx.store,
    index: ctx.index,
    onLayout: () => {},
    onLift: () => {},
    onVote: (text) => {
      voteEl.textContent = text;
      voteEl.hidden = false;
      if (voteTimer) clearTimeout(voteTimer);
      voteTimer = setTimeout(() => { voteEl.hidden = true; }, VOTE_LINE_MS);
    },
  });

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "카메라 켜는 중";
    const r = await beginAr({
      container: stage,
      createArSession: ctx.ar.createArSession,
      createScene: ctx.createScene,
      onFound: () => { scan.hidden = true; },
      onLost: () => { scan.hidden = false; },
      onFail: (err) => {
        console.warn("[ar] 카메라 시작 실패", err);
        if (!alive) return;
        ctx.toast(fallbackMessage(err));
        ctx.navigate("#/3d");
      },
    });
    if (!r) return;
    if (!alive) { r.stop(); return; }
    running = r;
    if (pending) drawCity(r.city, ctx.index, pending[0], pending[1]);
    intro.hidden = true;
    scan.hidden = false;
    sheetHost.hidden = false;
  }, { once: true });

  return () => {
    alive = false;
    offBanner();
    offVote();
    if (voteTimer) clearTimeout(voteTimer);
    unbind();
    sheet.destroy();
    running?.stop();
    running = null;
    root.innerHTML = "";
  };
};
