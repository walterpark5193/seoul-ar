// #/host: 왼쪽 그림+QR, 오른쪽 월·자치구·지표·연결 상태. 바꾸면 즉시 publish.
// S 키나 버튼으로 슬라이드 모드(그림·QR·제목만). 늦게 들어온 관객을 위해 10초마다 현재 상태를 다시 보낸다.
// "월 가져오기"(10.5)·"해설 생성"(12.3)은 monthFetch.ts, "시간 여행"(11)은 timeTravel.ts가 상태를 맡고, 여기서는 DOM만 잇는다.
// "큰 화면 열기"는 #/3d?stage=1(13)을 새 창으로 연다.
import { forgetMonth, forgetNarration } from "../data/loader";
import { currentMonth } from "../data/months";
import type { DataIndex, Metric } from "../data/types";
import type { StateMessage } from "../realtime/types";
import type { AppState } from "../state/store";
import { fmtCount, fmtMonth, fmtNumber, NO_TRADE } from "../ui/format";
import { esc } from "../ui/html";
import { replaceKeepingFocus } from "../ui/patch";
import { drawQr } from "../ui/qr";
import {
  createMonthFetch, defaultFetchMonth, monthInputValue, narratingMonth, needsFetchRender, renderMonthFetch,
  type FetchView, type NarrationAvailability, type StorageLike,
} from "./monthFetch";
import { createTimeTravel, renderTimeTravel, type TravelView } from "./timeTravel";
import type { MountView } from "./types";
import { stageUrl, viewerUrl } from "./urls";

export { stageUrl, viewerUrl };

const HEARTBEAT_MS = 10000;
const MARKER_SRC = "/marker/target.png";

export function toMessage(s: AppState, ts: number): StateMessage {
  return { v: 1, type: "state", month: s.month, gu: s.gu, metric: s.metric, ts };
}

const pressed = (on: boolean) => `aria-pressed="${on}"`;

function connLine(conn: AppState["conn"]): string {
  if (conn === "open") return `<p class="host-conn host-conn--open"><span class="host-conn-dot" aria-hidden="true"></span>연결됨: 바꾸면 관객 폰에 바로 반영됩니다</p>`;
  if (conn === "error" || conn === "closed") return `<p class="host-conn host-conn--down"><span class="host-conn-mark" aria-hidden="true">!</span>연결 안 됨: 관객 폰에 반영되지 않을 수 있습니다</p>`;
  return `<p class="host-conn host-conn--wait">연결 중</p>`;
}

function guValue(index: DataIndex, s: AppState, gu: string): string {
  const stat = index.summary[s.month]?.[gu];
  if (!stat) return NO_TRADE;
  if (s.metric === "count") return fmtCount(stat.n);
  return stat.medPerM2 === null ? NO_TRADE : fmtNumber(stat.medPerM2);
}

export function renderHostControls(s: AppState, index: DataIndex): string {
  const months = index.months
    .map((m) => `<button type="button" class="chip" data-action="month" data-value="${esc(m)}" ${pressed(m === s.month)}>${esc(fmtMonth(m))}</button>`)
    .join("");
  const gus = index.gus
    .map((g) => `<button type="button" class="gu-btn" data-action="gu" data-value="${esc(g)}" ${pressed(g === s.gu)}>` +
      `<span class="gu-name">${esc(g)}</span><span class="gu-val">${esc(guValue(index, s, g))}</span></button>`)
    .join("");
  const metrics = (["price", "count"] as Metric[])
    .map((m) => `<button type="button" data-action="metric" data-value="${m}" ${pressed(s.metric === m)}>${m === "price" ? "㎡당 가격" : "거래 건수"}</button>`)
    .join("");
  const unit = s.metric === "price" ? "구 아래 숫자는 ㎡당 중앙값(만원)" : "구 아래 숫자는 거래 건수";
  return connLine(s.conn) +
    `<section class="host-group" aria-labelledby="h-month"><h2 id="h-month">월</h2><div class="chips">${months}</div></section>` +
    `<section class="host-group" aria-labelledby="h-metric"><h2 id="h-metric">막대 기준</h2><div class="seg">${metrics}</div></section>` +
    `<section class="host-group" aria-labelledby="h-gu"><h2 id="h-gu">자치구</h2>` +
    `<p class="host-unit">${unit}</p>` +
    `<button type="button" class="gu-all" data-action="gu" data-value="" ${pressed(s.gu === null)}>전체 보기</button>` +
    `<div class="gu-grid">${gus}</div></section>`;
}

function renderHost(url: string): string {
  return `<div class="host">` +
    `<section class="host-stage" aria-label="관객에게 보여 줄 화면">` +
    `<h1 class="host-title">서울이 선다</h1>` +
    `<img class="host-marker" src="${MARKER_SRC}" width="1024" height="1024" alt="AR 인식용 그림. 관객이 폰 카메라로 이 그림을 비춥니다">` +
    `<figure class="host-qr"><canvas data-qr role="img" aria-label="관객용 주소 QR 코드"></canvas>` +
    `<figcaption><strong>폰 카메라로 QR을 찍고</strong><span>열린 화면을 왼쪽 그림에 비춰 보세요</span>` +
    `<span class="host-url">${esc(url)}</span></figcaption></figure>` +
    `</section>` +
    `<section class="host-panel" aria-label="발표자 조정"><div data-controls></div><div data-travel></div><div data-fetch></div>` +
    `<div class="host-tools"><button type="button" class="btn btn-secondary" data-action="slide">슬라이드 모드 <kbd>S</kbd></button>` +
    `<div class="host-stage-open"><button type="button" class="btn btn-secondary" data-action="open-stage">큰 화면 열기</button>` +
    `<span class="host-tools-hint">프로젝터 쪽 창에 두세요</span></div>` +
    `<a class="host-exit" href="#/">처음으로</a></div></section>` +
    `<button type="button" class="slide-exit" data-action="slide">슬라이드 모드 끝내기 <kbd>Esc</kbd></button>` +
    `</div>`;
}

function sessionStore(): StorageLike | null {
  try { return window.sessionStorage; } catch { return null; }
}

export const mountHostView: MountView = (root, ctx) => {
  // 발표자는 원본이다: 다른 화면의 원격 상태를 따라가지 않는다.
  ctx.store.dispatch({ type: "local" });

  const url = viewerUrl(ctx.config.appUrl, location);
  root.innerHTML = renderHost(url);
  const hostEl = root.querySelector<HTMLElement>(".host")!;
  const controls = root.querySelector<HTMLElement>("[data-controls]")!;
  const qr = root.querySelector<HTMLCanvasElement>("[data-qr]")!;
  drawQr(qr, url).catch((err) => console.warn("[host] QR을 그리지 못함", err));

  let failing = false;
  const publish = () => {
    ctx.realtime.publish(toMessage(ctx.store.getState(), Date.now())).then(
      () => { failing = false; },
      (err) => {
        console.warn("[host] 발행 실패", err);
        if (!failing) ctx.toast("관객 화면에 보내지 못했습니다. 연결 상태를 확인해 주세요.");
        failing = true;
      },
    );
  };

  // 그리는 함수들은 보여 줄 상태를 인자로 받는다. 컨트롤러보다 먼저 선언해 앞에서 쓰는 일이 없게 한다.
  const render = (s: AppState) => replaceKeepingFocus(controls, renderHostControls(s, ctx.index));

  const travelHost = root.querySelector<HTMLElement>("[data-travel]")!;
  const paintTravel = (v: TravelView) =>
    replaceKeepingFocus(travelHost, renderTimeTravel(v, ctx.index.months, ctx.store.getState().month));

  // 월 가져오기: 진행 표시가 바뀌어도 입력한 월이 지워지지 않게 값을 따로 들고 있는다.
  const fetchHost = root.querySelector<HTMLElement>("[data-fetch]")!;
  let fetchValue = monthInputValue(defaultFetchMonth(ctx.index, Date.now()));
  let fetchView: FetchView = { phase: "idle" };
  let lastPhase: FetchView["phase"] = "idle";
  // 고른 달(월 칩)의 해설 유무: "해설 생성" 버튼은 없을 때만 켠다.
  let narration: NarrationAvailability = { month: ctx.store.getState().month, state: "unknown" };
  /** cause "context"(월·index·해설 유무가 바뀜)는 암호를 입력하는 중이면 건너뛴다(입력이 지워지지 않게). */
  const paintFetch = (v: FetchView, cause: "view" | "context") => {
    if (!needsFetchRender(v.phase, cause)) return;
    replaceKeepingFocus(fetchHost, renderMonthFetch(v, { value: fetchValue, max: monthInputValue(currentMonth(Date.now())), narration }));
    if (v.phase === "key" && lastPhase !== "key") fetchHost.querySelector<HTMLInputElement>("#presenter-key")?.focus();
    lastPhase = v.phase;
  };
  let narrationToken = 0;
  const checkNarration = async (month: string) => {
    const mine = ++narrationToken;
    narration = { month, state: "unknown" };
    paintFetch(fetchView, "context");
    const n = ctx.loadNarration ? await ctx.loadNarration(month).catch(() => null) : null;
    if (mine !== narrationToken) return;
    // 그 달의 해설 작업이 도는 중이면(수집 뒤 자동 생성 포함) "없음"으로 보지 않는다. 버튼을 켜면 409가 나고 쓸데없이 다시 만든다.
    const running = narratingMonth(fetchView) === month;
    narration = { month, state: !ctx.loadNarration ? "unknown" : n ? "present" : running ? "running" : "absent" };
    paintFetch(fetchView, "context");
  };

  // 시간 여행: 월만 바꾸고(local), 발행은 아래 store 구독이 평소처럼 한다.
  const travel = createTimeTravel({
    months: () => ctx.index.months,
    month: () => ctx.store.getState().month,
    setMonth: (m) => ctx.store.dispatch({ type: "local", month: m }),
    onChange: paintTravel,
  });
  const monthFetch = createMonthFetch({
    fetch: (input, init) => window.fetch(input, init),
    storage: sessionStore(),
    subscribeJobs: (h) => ctx.realtime.subscribeJobs(h),
    refreshIndex: () => ctx.indexSource.refresh(),
    reloadNarration: async (m) => {
      forgetNarration(m);
      await checkNarration(ctx.store.getState().month);
    },
    forgetMonth: (m) => forgetMonth(m),
    toast: ctx.toast,
    onChange: (v) => {
      const wasNarrating = narratingMonth(fetchView) !== null;
      fetchView = v;
      paintFetch(v, "view");
      // 해설 작업이 실패나 포기로 끝나면 버튼을 다시 판단한다(성공은 reloadNarration이 다시 확인한다).
      if (wasNarrating && v.phase === "idle" && v.error) void checkNarration(ctx.store.getState().month);
    },
  });

  render(ctx.store.getState());
  publish();
  paintTravel(travel.view);
  paintFetch(fetchView, "view");
  void checkNarration(ctx.store.getState().month);

  // 새 달을 가져와 index가 바뀌면 월 칩·시간 여행·해설 유무를 다시 그린다.
  const offIndex = ctx.indexSource.subscribe(() => {
    render(ctx.store.getState());
    paintTravel(travel.view);
    void checkNarration(ctx.store.getState().month);
  });

  const onSubmit = (ev: Event) => {
    const form = ev.target as HTMLFormElement;
    if (form.dataset.form === "fetch") {
      ev.preventDefault();
      travel.stop();
      const input = form.elements.namedItem("month") as HTMLInputElement | null;
      fetchValue = input?.value ?? fetchValue;
      void monthFetch.submit(fetchValue);
    } else if (form.dataset.form === "key") {
      ev.preventDefault();
      const input = form.elements.namedItem("key") as HTMLInputElement | null;
      void monthFetch.submitKey(input?.value ?? "");
    }
  };
  const onInput = (ev: Event) => {
    const t = ev.target as HTMLInputElement;
    if (t.id === "fetch-month") fetchValue = t.value;
  };
  const onChange = (ev: Event) => {
    const t = ev.target as HTMLSelectElement;
    if (t.dataset.action === "travel-interval") travel.setIntervalMs(Number(t.value));
  };
  hostEl.addEventListener("submit", onSubmit);
  hostEl.addEventListener("input", onInput);
  hostEl.addEventListener("change", onChange);

  const off = ctx.store.subscribe((s, prev) => {
    render(s);
    if (s.month !== prev.month || s.gu !== prev.gu || s.metric !== prev.metric) publish();
    if (s.month !== prev.month) {
      paintTravel(travel.view);
      void checkNarration(s.month);
    }
  });
  const beat = setInterval(publish, HEARTBEAT_MS);

  const setSlide = (on: boolean) => {
    hostEl.classList.toggle("is-slide", on);
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  const onClick = (ev: Event) => {
    const btn = (ev.target as Element).closest<HTMLElement>("button[data-action]");
    if (!btn) return;
    const { action, value } = btn.dataset;
    // 발표자가 직접 고르면 시간 여행은 멈춘다.
    if (action === "gu" || action === "month" || action === "metric" || action === "narrate") travel.stop();
    if (action === "travel-toggle") travel.toggle();
    if (action === "narrate") void monthFetch.narrate(ctx.store.getState().month);
    if (action === "open-stage") window.open(stageUrl(location), "_blank", "noopener");
    if (action === "gu") ctx.store.dispatch({ type: "local", gu: value ? value : null });
    if (action === "month" && value) ctx.store.dispatch({ type: "local", month: value });
    if (action === "metric" && (value === "price" || value === "count")) ctx.store.dispatch({ type: "local", metric: value });
    if (action === "slide") setSlide(!hostEl.classList.contains("is-slide"));
    if (action === "fetch-cancel") monthFetch.cancelKey();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (ev.key === "s" || ev.key === "S" || ev.key === "ㄴ") setSlide(!hostEl.classList.contains("is-slide"));
    if (ev.key === "Escape") setSlide(false);
  };
  // 전체 화면을 Esc로 빠져나오면 슬라이드 모드도 함께 끝낸다.
  const onFullscreen = () => { if (!document.fullscreenElement) hostEl.classList.remove("is-slide"); };

  hostEl.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFullscreen);

  return () => {
    off();
    offIndex();
    travel.dispose();
    narrationToken++;
    monthFetch.dispose();
    hostEl.removeEventListener("change", onChange);
    hostEl.removeEventListener("submit", onSubmit);
    hostEl.removeEventListener("input", onInput);
    clearInterval(beat);
    hostEl.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFullscreen);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    root.innerHTML = "";
  };
};
