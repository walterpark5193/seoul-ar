// 시간 여행 재생 (CONTRACTS 11): 호스트가 월을 오름차순으로 넘기며 매 단계 평소의 StateMessage를 보낸다.
// 월을 바꾸는 일은 setMonth(호스트의 local 액션)가 하고, 발행은 호스트의 기존 store 구독이 한다(gu·metric 그대로).
// 마지막 달에서 멈춘다(반복 없음). 다른 조작이 있으면 호스트가 stop()을 부른다.
import { esc } from "../ui/html";

export const TRAVEL_INTERVALS = [2000, 4000, 8000] as const;
export const DEFAULT_TRAVEL_MS = 4000;

export interface TravelView { playing: boolean; intervalMs: number; }

const sorted = (months: readonly string[]) => [...months].sort();

/** 다음 달(오름차순). 마지막이거나 목록에 없으면 null. */
export function nextMonth(months: readonly string[], current: string): string | null {
  const list = sorted(months);
  const i = list.indexOf(current);
  return i >= 0 && i < list.length - 1 ? list[i + 1]! : null;
}

/** 재생을 시작할 달: 지금 달에서 이어 가되, 마지막 달(또는 목록에 없는 달)이면 처음부터. 두 달 미만이면 null. */
export function travelStart(months: readonly string[], current: string): string | null {
  const list = sorted(months);
  if (list.length < 2) return null;
  return nextMonth(list, current) === null ? list[0]! : current;
}

function label(yyyymm: string, prev: string | null): string {
  const y = yyyymm.slice(0, 4);
  const m = Number(yyyymm.slice(4, 6));
  return prev && prev.slice(0, 4) === y ? `${m}월` : `${y}년 ${m}월`;
}

/** "2026년 9월 → 10월 → <strong>11월</strong>": 해가 바뀔 때만 연도를 붙인다. */
export function travelLine(months: readonly string[], current: string): string {
  const list = sorted(months);
  return list.map((m, i) => {
    const text = esc(label(m, i > 0 ? list[i - 1]! : null));
    return m === current ? `<strong>${text}</strong>` : text;
  }).join(" → ");
}

export function renderTimeTravel(v: TravelView, months: readonly string[], current: string): string {
  if (months.length < 2) return "";
  const options = TRAVEL_INTERVALS
    .map((ms) => `<option value="${ms}"${ms === v.intervalMs ? " selected" : ""}>${ms / 1000}초</option>`)
    .join("");
  return `<section class="host-group host-travel" aria-labelledby="h-travel">` +
    `<h2 id="h-travel">시간 여행</h2>` +
    `<div class="fetch-row">` +
    `<button type="button" class="chip${v.playing ? " chip--primary" : ""}" data-action="travel-toggle" aria-pressed="${v.playing}">${v.playing ? "일시정지" : "재생"}</button>` +
    `<label class="travel-interval"><span class="vh">넘기는 간격</span>` +
    `<select data-action="travel-interval">${options}</select></label>` +
    `</div>` +
    `<p class="travel-line" aria-live="polite">${travelLine(months, current)}</p>` +
    `</section>`;
}

export interface TimeTravelDeps {
  months(): readonly string[];
  month(): string;
  setMonth(month: string): void;
  onChange(view: TravelView): void;
}

export interface TimeTravel {
  readonly view: TravelView;
  play(): void;
  stop(): void;
  toggle(): void;
  /** 2·4·8초만 받는다. 재생 중이면 새 간격으로 다시 잰다. */
  setIntervalMs(ms: number): void;
  dispose(): void;
}

export function createTimeTravel(d: TimeTravelDeps): TimeTravel {
  let view: TravelView = { playing: false, intervalMs: DEFAULT_TRAVEL_MS };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const set = (v: TravelView) => { view = v; d.onChange(v); };
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const stop = () => {
    clear();
    if (view.playing) set({ ...view, playing: false });
  };

  const schedule = () => {
    clear();
    timer = setTimeout(step, view.intervalMs);
  };

  function step() {
    timer = null;
    const next = nextMonth(d.months(), d.month());
    if (next === null) { stop(); return; }
    d.setMonth(next);
    if (nextMonth(d.months(), next) === null) stop(); // 마지막 달에 닿았다
    else schedule();
  }

  const play = () => {
    const start = travelStart(d.months(), d.month());
    if (start === null) return;
    set({ ...view, playing: true });
    if (start !== d.month()) d.setMonth(start);
    schedule();
  };

  return {
    get view() { return view; },
    play,
    stop,
    toggle() { if (view.playing) stop(); else play(); },
    setIntervalMs(ms) {
      if (!(TRAVEL_INTERVALS as readonly number[]).includes(ms)) return;
      set({ ...view, intervalMs: ms });
      if (view.playing) schedule();
    },
    dispose: clear,
  };
}
