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

/** down(p): 누른 자리(화면 정규 좌표). 터치는 누르기 전에 pointermove가 없을 수 있어 누른 이벤트에서 위치를 준다. */
export interface PointerHandlers { move(p: Point): void; down(p?: Point): void; up(): void; leave(): void; wheel?(deltaY: number): void; }

/** 창 이벤트(blur) 받기. 테스트에서 주입하고, 없으면(노드) 건너뛴다. */
export interface WindowLike { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void; }

const defaultWindow = (): WindowLike | null => (typeof window !== "undefined" ? window : null);

export function attachPointer(el: HTMLElement, h: PointerHandlers, win: WindowLike | null = defaultWindow()): () => void {
  let pressed = false;
  const pointOf = (e: PointerEvent): Point | undefined => {
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return undefined;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return undefined;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  // 두 번째 손가락(isPrimary false)은 아무 일도 하지 않는다: 한 손가락 돌리기를 가로채 지도가 튀고,
  // 그 손가락을 떼는 순간 세게 놓이며 돌던 문제(P-1). 마우스·첫 손가락만 받는다.
  const secondary = (e: PointerEvent) => e.isPrimary === false;
  const release = () => {
    if (!pressed) return;
    pressed = false;
    h.up();
  };
  const onMove = (e: PointerEvent) => {
    if (secondary(e)) return;
    // 떼기(pointerup)를 놓쳤으면(창 밖에서 뗌 등) 버튼이 하나도 눌려 있지 않은 이동에서 놓는다(M-3).
    if (pressed && e.buttons === 0) release();
    const p = pointOf(e);
    if (p) h.move(p);
  };
  const onDown = (e: PointerEvent) => {
    if (secondary(e)) return;
    if (e.pointerType === "mouse" && typeof e.button === "number" && e.button !== 0) return; // 오른쪽·가운데 버튼은 누르기가 아니다(M-2)
    // 폰: 길게 누르면 브라우저가 글자 선택·복사 메뉴를 띄우거나 화면을 끌어 스크롤한다. 손가락 누르기는 기본 동작을 막는다.
    if (e.pointerType === "touch") e.preventDefault?.();
    // 손가락이 조금 미끄러져도 떼기(pointerup)가 이 층으로 오게 붙잡는다.
    if (typeof e.pointerId === "number") {
      try { el.setPointerCapture?.(e.pointerId); } catch { /* 이미 끝난 포인터 */ }
    }
    pressed = true;
    h.down(pointOf(e));
  };
  const onUp = (e: PointerEvent) => {
    if (e && secondary(e)) return;
    pressed = false;
    h.up();
  };
  const onLeave = (e: PointerEvent) => {
    if (e && secondary(e)) return;
    h.leave();
  };
  const onMenu = (e: Event) => e.preventDefault(); // 길게 누르기의 복사·저장 메뉴
  const onBlur = () => release(); // 누른 채 다른 창으로 가면 떼기가 오지 않는다(M-3)
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("contextmenu", onMenu);
  win?.addEventListener("blur", onBlur);
  const onWheel = h.wheel ? (e: WheelEvent) => { e.preventDefault(); h.wheel!(e.deltaY); } : null;
  if (onWheel) el.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    if (onWheel) el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("contextmenu", onMenu);
    win?.removeEventListener("blur", onBlur);
  };
}
