// 키보드·포인터 입력 (계약 CONTRACTS-stage 3.3). 순수 모듈: DOM 타입은 최소 구조만 쓴다.
import type { Point, StageEvent, StageState } from "./types";

export type UiAction = "toggleInput" | "mute" | "preview" | "diag" | "hints" | "monthPrev" | "monthNext" | "voteToggle" | "rowUp" | "rowDown";
export type KeyResult = { kind: "event"; event: StageEvent } | { kind: "ui"; action: UiAction } | null;

const UI_KEYS: Record<string, UiAction> = {
  v: "voteToggle", g: "toggleInput", m: "mute", c: "preview", d: "diag", h: "hints",
};

export function keyToAction(key: string, s: StageState, ui: { reviewRow: number; now: number }): KeyResult {
  const ev = (event: StageEvent): KeyResult => ({ kind: "event", event });
  const act = (action: UiAction): KeyResult => ({ kind: "ui", action });
  const vote = s.vote;
  const voting = vote !== null && vote.phase !== "result";
  const review = vote !== null && vote.phase === "review";

  if (key === " ") return ev({ type: "spread" });
  if (key === "Escape") return ev({ type: "victory" });
  if (/^[0-6]$/.test(key)) {
    if (!voting || !vote) return null;
    return ev({ type: "voteSet", index: review ? ui.reviewRow : vote.index, n: Number(key), now: ui.now });
  }
  if (key === "Enter") return review ? ev({ type: "voteConfirm", now: ui.now }) : null;
  if (key === "ArrowLeft") return act("monthPrev");
  if (key === "ArrowRight") return act("monthNext");
  if (key === "ArrowUp") return review ? act("rowUp") : null;
  if (key === "ArrowDown") return review ? act("rowDown") : null;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (lower === "n") {
    if (!voting || !vote) return null;
    return ev({ type: "voteMethod", method: vote.method === "camera" ? "manual" : "camera", now: ui.now });
  }
  if (lower === "p") return ev({ type: "metric", metric: s.metric === "price" ? "count" : "price" });
  return UI_KEYS[lower] ? act(UI_KEYS[lower]) : null;
}

export interface PointerHandlers { move(p: Point): void; down(): void; up(): void; leave(): void; }

export function attachPointer(el: HTMLElement, h: PointerHandlers): () => void {
  const onMove = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    h.move({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  const onDown = () => h.down();
  const onUp = () => h.up();
  const onLeave = () => h.leave();
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointerleave", onLeave);
  return () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointerleave", onLeave);
  };
}
