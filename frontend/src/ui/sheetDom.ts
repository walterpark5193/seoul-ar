// 바텀시트 DOM 연결: renderSheet 결과를 꽂고, 버튼·선택을 local/follow 액션으로 바꾼다.
// 접힘(peek)과 펼침 상태는 여기(뷰 상태)가 들고 있다. DOM에 두지 않으므로 다시 그려도 유지되고, 마운트마다 접힘으로 시작한다.
// 높이 전환은 늘 남아 있는 틀(.sheet-frame)에 걸어야 애니메이션이 된다(시트 내용은 매번 새로 그려진다).
import type { Narration } from "../data/narration";
import type { DataIndex, GuData, Metric } from "../data/types";
import type { AppState, Store } from "../state/store";
import { replaceKeepingFocus } from "./patch";
import { renderSheet, type SheetOptions } from "./sheet";

export interface SheetHandle {
  render(state: AppState, data: GuData | null, narration?: Narration | null): void;
  /** 지금 펼쳐져 있는지 */
  readonly expanded: boolean;
  destroy(): void;
}

export interface SheetMountOptions extends Omit<SheetOptions, "expanded" | "narration"> {
  /** 그리는 방법(테스트에서 주입). 주지 않으면 틀 요소를 만들고 포커스를 지키며 innerHTML로 그린다. */
  paint?: (target: HTMLElement, html: string) => void;
}

/** getIndex: 새 달을 가져오면 index가 바뀌므로 그릴 때마다 읽는다. */
export function mountSheet(host: HTMLElement, store: Store, getIndex: () => DataIndex | null, opts: SheetMountOptions = {}): SheetHandle {
  const { paint, ...sheetOpts } = opts;
  let frame: HTMLElement | null = null;
  if (!paint) {
    host.innerHTML = `<div class="sheet-frame"></div>`;
    frame = host.firstElementChild as HTMLElement;
  }
  const target = frame ?? host;
  const draw = paint ?? replaceKeepingFocus;

  let expanded = false; // 마운트마다 접힌 상태에서 시작
  let last: { state: AppState; data: GuData | null; narration: Narration | null } | null = null;

  const repaint = () => {
    frame?.classList.toggle("is-open", expanded);
    if (!last) return;
    draw(target, renderSheet(last.state, last.data, getIndex(), { ...sheetOpts, narration: last.narration, expanded }));
  };
  const toggle = () => {
    expanded = !expanded;
    repaint();
  };

  const onClick = (ev: Event) => {
    const t = ev.target as Element;
    const btn = t.closest<HTMLElement>("button[data-action]");
    if (btn && host.contains(btn)) {
      const action = btn.dataset.action;
      if (action === "metric") store.dispatch({ type: "local", metric: btn.dataset.value as Metric });
      if (action === "follow") store.dispatch({ type: "follow" });
      if (action === "sheet-toggle") toggle();
      return;
    }
    // 머리(구 이름·월) 줄을 눌러도 접고 편다. 그 안의 버튼·링크·입력은 제 일을 한다.
    if (t.closest(".sheet-head") && !t.closest("a, button, select, input, label")) toggle();
  };
  const onChange = (ev: Event) => {
    const sel = ev.target as HTMLSelectElement;
    if (sel.dataset.action === "gu") store.dispatch({ type: "local", gu: sel.value === "" ? null : sel.value });
    if (sel.dataset.action === "month") store.dispatch({ type: "local", month: sel.value });
  };
  host.addEventListener("click", onClick);
  host.addEventListener("change", onChange);

  return {
    render(state, data, narration) {
      last = { state, data, narration: narration ?? null };
      repaint();
    },
    get expanded() { return expanded; },
    destroy() {
      host.removeEventListener("click", onClick);
      host.removeEventListener("change", onChange);
      host.innerHTML = "";
    },
  };
}
