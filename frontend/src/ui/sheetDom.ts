// 바텀시트 DOM 연결: renderSheet 결과를 꽂고, 버튼·선택을 local/follow 액션으로 바꾼다.
import type { DataIndex, GuData, Metric } from "../data/types";
import type { AppState, Store } from "../state/store";
import { replaceKeepingFocus } from "./patch";
import { renderSheet, type SheetOptions } from "./sheet";

export interface SheetHandle {
  render(state: AppState, data: GuData | null): void;
  destroy(): void;
}

/** getIndex: 새 달을 가져오면 index가 바뀌므로 그릴 때마다 읽는다. */
export function mountSheet(host: HTMLElement, store: Store, getIndex: () => DataIndex | null, opts: SheetOptions = {}): SheetHandle {
  const onClick = (ev: Event) => {
    const btn = (ev.target as Element).closest<HTMLElement>("button[data-action]");
    if (!btn || !host.contains(btn)) return;
    if (btn.dataset.action === "metric") store.dispatch({ type: "local", metric: btn.dataset.value as Metric });
    if (btn.dataset.action === "follow") store.dispatch({ type: "follow" });
  };
  const onChange = (ev: Event) => {
    const sel = ev.target as HTMLSelectElement;
    if (sel.dataset.action === "gu") store.dispatch({ type: "local", gu: sel.value === "" ? null : sel.value });
    if (sel.dataset.action === "month") store.dispatch({ type: "local", month: sel.value });
  };
  host.addEventListener("click", onClick);
  host.addEventListener("change", onChange);

  return {
    render(state, data) {
      replaceKeepingFocus(host, renderSheet(state, data, getIndex(), opts));
    },
    destroy() {
      host.removeEventListener("click", onClick);
      host.removeEventListener("change", onChange);
      host.innerHTML = "";
    },
  };
}
