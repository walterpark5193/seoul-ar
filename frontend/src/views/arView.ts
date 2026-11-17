// #/ar: 시작 버튼(iOS는 사용자 제스처 필요) → 카메라 → 그림 인식 시 그 위에 서울 → 바텀시트.
// 카메라를 못 쓰면 #/3d로 보내고 이유를 토스트로 알린다.
import type { ArSession, ArSessionOptions } from "../ar/session";
import type { SeoulScene } from "../scene/seoulScene";
import type { AppState } from "../state/store";
import type { GuData } from "../data/types";
import { mountSheet } from "../ui/sheetDom";
import { describeArTuning, parseArTuning, type ArTuning } from "./arTuning";
import type { MountView } from "./types";
import { bindViewer, drawCity } from "./viewerSync";

export const TARGET_SRC = "/marker/target.mind";
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
  /** "화면 고정" 버튼 상태. 처음 한 번(비활성)과, 타깃 첫 인식·고정·해제 때마다 부른다. */
  onFreezeState?(state: FreezeState): void;
  /** 해시 쿼리에서 읽은 조정값(views/arTuning.ts). container와 targetSrc는 덮어쓸 수 없다. */
  tuning?: ArTuning;
}

export interface RunningAr {
  session: ArSession;
  city: SeoulScene;
  /** 고정 ↔ 추적. 타깃을 한 번도 못 찾았거나 세션이 고정을 지원하지 않으면 아무 일도 하지 않는다. */
  toggleFreeze(): void;
  /** 고정 중이면 풀고, 구독을 끊고, 세션을 멈추고, 씬과 렌더러를 반납한다. */
  stop(): void;
}

export interface FreezeState { enabled: boolean; frozen: boolean; }

/** 버튼 글자와 상태 표시(순수 함수). 고정 중에는 "고정됨" 상태와 "다시 추적" 버튼. */
export function freezeView(s: FreezeState): { label: string; status: string | null; disabled: boolean } {
  return s.frozen
    ? { label: "다시 추적", status: "고정됨", disabled: !s.enabled }
    : { label: "화면 고정", status: null, disabled: !s.enabled };
}

/** CONTRACTS 5절 고정 기능이 있는 세션인지. 계약 이행 전의 세션에서도 AR 자체는 돌아가게 한다. */
function canFreeze(s: ArSession): boolean {
  const x = s as Partial<Pick<ArSession, "freeze" | "unfreeze" | "onFreeze">>;
  return typeof x.freeze === "function" && typeof x.unfreeze === "function" && typeof x.onFreeze === "function";
}

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
  let offFreeze: () => void = () => {};
  try {
    const s = o.createArSession({ ...o.tuning, container: o.container, targetSrc: TARGET_SRC });
    session = s;
    const freezable = canFreeze(s);
    let foundOnce = false;
    const emitFreeze = () => o.onFreezeState?.({ enabled: freezable && foundOnce, frozen: freezable && s.frozen === true });

    s.anchor.add(city.group);
    s.onFrame((dt) => city.update(dt, s.camera));
    s.onFound(() => {
      if (!foundOnce) { foundOnce = true; emitFreeze(); }
      o.onFound();
    });
    s.onLost(o.onLost);
    if (freezable) offFreeze = s.onFreeze(() => emitFreeze());
    emitFreeze();
    await s.start();
    return {
      session: s,
      city,
      toggleFreeze() {
        if (!freezable || !foundOnce) return;
        if (s.frozen) s.unfreeze();
        else s.freeze();
        emitFreeze();
      },
      stop() {
        offFreeze();
        if (freezable && s.frozen) s.unfreeze();
        s.stop();
        city.dispose();
        releaseRenderer(s);
      },
    };
  } catch (err) {
    offFreeze();
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
    `<div class="ar-tools" data-tools hidden>` +
    `<p class="freeze-state" data-freeze-state role="status"></p>` +
    `<button type="button" class="btn-freeze" data-freeze disabled title="그림을 한 번 인식하면 쓸 수 있습니다">화면 고정</button>` +
    `</div>` +
    `<div class="sheet-host" data-sheet hidden></div>` +
    `</div>`;

  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const intro = root.querySelector<HTMLElement>("[data-intro]")!;
  const scan = root.querySelector<HTMLElement>("[data-scan]")!;
  const sheetHost = root.querySelector<HTMLElement>("[data-sheet]")!;
  const startBtn = root.querySelector<HTMLButtonElement>("[data-start]")!;
  const tools = root.querySelector<HTMLElement>("[data-tools]")!;
  const freezeBtn = root.querySelector<HTMLButtonElement>("[data-freeze]")!;
  const freezeState = root.querySelector<HTMLElement>("[data-freeze-state]")!;

  const tuning = parseArTuning(ctx.query ?? "");
  const sheet = mountSheet(sheetHost, ctx.store, () => ctx.index, {
    altView: { href: "#/3d", label: "3D로 보기" },
    tuningNote: describeArTuning(tuning),
  });
  let alive = true;
  let running: RunningAr | null = null;
  let pending: [AppState, GuData | null] | null = null;
  let started = false;
  let tracking = false;
  let frozen = false;

  // 스캔 안내는 카메라가 돈 뒤, 타깃을 놓쳤고, 고정 중이 아닐 때만(고정 중에는 onFound/onLost가 오지 않는다).
  const updateScan = () => { scan.hidden = !started || tracking || frozen; };
  const applyFreeze = (s: FreezeState) => {
    frozen = s.frozen;
    const v = freezeView(s);
    freezeBtn.textContent = v.label;
    freezeBtn.disabled = v.disabled;
    freezeBtn.title = v.disabled ? "그림을 한 번 인식하면 쓸 수 있습니다" : "";
    freezeState.textContent = v.status ?? "";
    freezeState.hidden = v.status === null;
    tools.classList.toggle("is-frozen", s.frozen);
    updateScan();
  };
  freezeBtn.addEventListener("click", () => running?.toggleFreeze());

  const unbind = bindViewer({
    store: ctx.store,
    loadGu: ctx.loadGu,
    onScene: (s, d) => {
      pending = [s, d];
      if (running) drawCity(running.city, ctx.index, s, d);
    },
    onSheet: (s, d, n) => sheet.render(s, d, n),
    loadNarration: ctx.loadNarration,
  });

  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    startBtn.textContent = "카메라 켜는 중";
    const r = await beginAr({
      container: stage,
      createArSession: ctx.ar.createArSession,
      createScene: ctx.createScene,
      tuning,
      onFound: () => { tracking = true; updateScan(); },
      onLost: () => { tracking = false; updateScan(); },
      onFreezeState: applyFreeze,
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
    started = true;
    updateScan();
    tools.hidden = false;
    sheetHost.hidden = false;
  }, { once: true });

  return () => {
    alive = false;
    unbind();
    sheet.destroy();
    running?.stop(); // 고정 중이면 먼저 풀고 멈춘다
    running = null;
    root.innerHTML = "";
  };
};
