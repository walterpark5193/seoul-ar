import { describe, it, expect } from "vitest";
import { keyToAction, attachPointer } from "./keys";
import type { StageState, VoteState } from "./types";

function vote(p: Partial<VoteState> = {}): VoteState {
  return { round: 1, candidates: ["강남구", "마포구", "송파구"], index: 1, phase: "counting", method: "camera",
    counts: [null, null, null], sources: [null, null, null], reviewEdited: false, winner: null, allZero: false, endsAt: null, ...p };
}
function st(v: VoteState | null = null, p: Partial<StageState> = {}): StageState {
  return { mode: "map", hover: null, lifted: null, focus: null, input: "hands", vote: v, month: "202510", metric: "price", round: 0, rotate: "none", spinning: false, ...p };
}
const ui = { reviewRow: 2, now: 1000 };
const k = (key: string, s = st()) => keyToAction(key, s, ui);

describe("keyToAction", () => {
  it("simple events", () => {
    expect(k(" ")).toEqual({ kind: "event", event: { type: "spread" } });
    expect(k("Escape")).toEqual({ kind: "event", event: { type: "victory" } });
  });
  it("ui keys, both cases", () => {
    const m: Record<string, string> = { v: "voteToggle", g: "toggleInput", m: "mute", c: "preview", d: "diag", h: "hints", ArrowLeft: "monthPrev", ArrowRight: "monthNext" };
    for (const [key, action] of Object.entries(m)) {
      expect(k(key)).toEqual({ kind: "ui", action });
      expect(k(key.toUpperCase().length === 1 ? key.toUpperCase() : key)).toEqual({ kind: "ui", action });
    }
  });
  it("p toggles metric", () => {
    expect(k("p")).toEqual({ kind: "event", event: { type: "metric", metric: "count" } });
    expect(k("P", st(null, { metric: "count" }))).toEqual({ kind: "event", event: { type: "metric", metric: "price" } });
  });
  it("digits only during vote", () => {
    expect(k("3")).toBeNull();
    expect(k("3", st(vote()))).toEqual({ kind: "event", event: { type: "voteSet", index: 1, n: 3, now: 1000 } });
    expect(k("0", st(vote()))).toEqual({ kind: "event", event: { type: "voteSet", index: 1, n: 0, now: 1000 } });
    expect(k("6", st(vote()))).toEqual({ kind: "event", event: { type: "voteSet", index: 1, n: 6, now: 1000 } });
    expect(k("7", st(vote()))).toBeNull();
    expect(k("3", st(vote({ phase: "result" })))).toBeNull();
  });
  it("digit targets review row in review", () => {
    expect(k("4", st(vote({ phase: "review" })))).toEqual({ kind: "event", event: { type: "voteSet", index: 2, n: 4, now: 1000 } });
  });
  it("enter only in review", () => {
    expect(k("Enter")).toBeNull();
    expect(k("Enter", st(vote()))).toBeNull();
    expect(k("Enter", st(vote({ phase: "review" })))).toEqual({ kind: "event", event: { type: "voteConfirm", now: 1000 } });
  });
  it("n toggles method only during vote", () => {
    expect(k("n")).toBeNull();
    expect(k("n", st(vote()))).toEqual({ kind: "event", event: { type: "voteMethod", method: "manual", now: 1000 } });
    expect(k("N", st(vote({ method: "manual" })))).toEqual({ kind: "event", event: { type: "voteMethod", method: "camera", now: 1000 } });
  });
  it("arrow up/down only in review", () => {
    expect(k("ArrowUp")).toBeNull();
    expect(k("ArrowDown", st(vote()))).toBeNull();
    expect(k("ArrowUp", st(vote({ phase: "review" })))).toEqual({ kind: "ui", action: "rowUp" });
    expect(k("ArrowDown", st(vote({ phase: "review" })))).toEqual({ kind: "ui", action: "rowDown" });
  });
  it("unknown key null", () => {
    expect(k("x")).toBeNull();
    expect(k("F5")).toBeNull();
  });
});

describe("attachPointer", () => {
  it("normalizes to element rect and detaches", () => {
    const l = new Map<string, (e: any) => void>();
    const removed: string[] = [];
    const el: any = {
      addEventListener: (t: string, f: any) => l.set(t, f),
      removeEventListener: (t: string, f: any) => { if (l.get(t) === f) { l.delete(t); removed.push(t); } },
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
    };
    const calls: string[] = [];
    const pts: any[] = [];
    const off = attachPointer(el, { move: (p) => pts.push(p), down: () => calls.push("down"), up: () => calls.push("up"), leave: () => calls.push("leave") });
    expect([...l.keys()].sort()).toEqual(["contextmenu", "pointercancel", "pointerdown", "pointerleave", "pointermove", "pointerup"]);
    l.get("pointermove")!({ clientX: 200, clientY: 100 });
    expect(pts).toEqual([{ x: 0.5, y: 0.5 }]);
    l.get("pointerdown")!({}); l.get("pointerup")!({}); l.get("pointerleave")!({});
    expect(calls).toEqual(["down", "up", "leave"]);
    off();
    expect(l.size).toBe(0);
    expect(removed.length).toBe(6);
  });
});

describe("attachPointer on a phone (Task 14)", () => {
  const mk = () => {
    const l = new Map<string, (e: any) => void>();
    const captured: number[] = [];
    const el: any = {
      addEventListener: (t: string, f: any) => l.set(t, f),
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
      setPointerCapture: (id: number) => captured.push(id),
    };
    return { l, el, captured };
  };
  const ev = (o: Record<string, unknown>) => {
    const e = { prevented: false, preventDefault() { e.prevented = true; }, ...o };
    return e;
  };

  it("down receives the pointerdown point itself (a touch has no pointermove before it)", () => {
    const { l, el } = mk();
    const downs: unknown[] = [];
    attachPointer(el, { move() {}, down: (p) => downs.push(p), up() {}, leave() {} });
    l.get("pointerdown")!(ev({ clientX: 250, clientY: 75, pointerType: "touch", pointerId: 3 }));
    expect(downs).toEqual([{ x: 0.75, y: 0.25 }]);
  });

  it("touch pointerdown prevents the browser default (selection, callout, scroll) and captures the pointer; mouse does not prevent", () => {
    const { l, el, captured } = mk();
    attachPointer(el, { move() {}, down() {}, up() {}, leave() {} });
    const touch = ev({ clientX: 150, clientY: 60, pointerType: "touch", pointerId: 7 });
    l.get("pointerdown")!(touch);
    expect(touch.prevented).toBe(true);
    expect(captured).toEqual([7]);
    const mouse = ev({ clientX: 150, clientY: 60, pointerType: "mouse", pointerId: 1 });
    l.get("pointerdown")!(mouse);
    expect(mouse.prevented).toBe(false);
    expect(captured).toEqual([7, 1]);
  });

  it("blocks the long-press context menu and treats pointercancel as up", () => {
    const { l, el } = mk();
    const calls: string[] = [];
    attachPointer(el, { move() {}, down() {}, up: () => calls.push("up"), leave() {} });
    const menu = ev({});
    l.get("contextmenu")!(menu);
    expect(menu.prevented).toBe(true);
    l.get("pointercancel")!(ev({}));
    expect(calls).toEqual(["up"]);
  });
});

describe("attachPointer wheel", () => {
  const mkEl = () => {
    const l = new Map<string, (e: any) => void>();
    const opts = new Map<string, any>();
    const el: any = {
      addEventListener: (t: string, f: any, o: any) => { l.set(t, f); opts.set(t, o); },
      removeEventListener: (t: string, f: any) => { if (l.get(t) === f) l.delete(t); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    };
    return { l, opts, el };
  };
  const base = { move() {}, down() {}, up() {}, leave() {} };
  it("attachPointer wheel calls handler with deltaY and prevents default", () => {
    const { l, opts, el } = mkEl();
    const got: number[] = [];
    attachPointer(el, { ...base, wheel: (d) => got.push(d) });
    let prevented = false;
    l.get("wheel")!({ deltaY: -120, preventDefault: () => { prevented = true; } });
    expect(got).toEqual([-120]);
    expect(prevented).toBe(true);
    expect(opts.get("wheel")).toEqual({ passive: false });
  });
  it("wheel listener removed on detach", () => {
    const { l, el } = mkEl();
    const off = attachPointer(el, { ...base, wheel: () => {} });
    expect(l.has("wheel")).toBe(true);
    off();
    expect(l.size).toBe(0);
  });
  it("no wheel listener without handler", () => {
    const { l, el } = mkEl();
    attachPointer(el, base);
    expect(l.has("wheel")).toBe(false);
  });
});

describe("attachPointer pointer filtering (Task 15)", () => {
  const mk = () => {
    const l = new Map<string, (e: any) => void>();
    const wl = new Map<string, () => void>();
    const captured: number[] = [];
    const el: any = {
      addEventListener: (t: string, f: any) => l.set(t, f),
      removeEventListener: (t: string, f: any) => { if (l.get(t) === f) l.delete(t); },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      setPointerCapture: (id: number) => captured.push(id),
    };
    const win = {
      addEventListener: (t: string, f: () => void) => wl.set(t, f),
      removeEventListener: (t: string, f: () => void) => { if (wl.get(t) === f) wl.delete(t); },
    };
    const calls: string[] = [];
    const h = { move: (p: any) => calls.push(`move ${p.x}`), down: () => calls.push("down"), up: () => calls.push("up"), leave: () => calls.push("leave") };
    return { l, wl, el, win, calls, captured, h };
  };
  const pe = (o: Record<string, unknown>) => ({ preventDefault() {}, pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 10, clientY: 10, ...o });

  it("P-1: a second finger never moves, presses or releases (only the primary pointer counts)", () => {
    const { l, el, win, calls, h } = mk();
    attachPointer(el, h, win);
    l.get("pointerdown")!(pe({ pointerId: 1, clientX: 10 }));
    l.get("pointerdown")!(pe({ pointerId: 2, isPrimary: false, clientX: 90 }));
    l.get("pointermove")!(pe({ pointerId: 2, isPrimary: false, clientX: 80, buttons: 1 }));
    l.get("pointerup")!(pe({ pointerId: 2, isPrimary: false }));
    l.get("pointercancel")!(pe({ pointerId: 2, isPrimary: false }));
    l.get("pointerleave")!(pe({ pointerId: 2, isPrimary: false }));
    l.get("pointermove")!(pe({ pointerId: 1, clientX: 20, buttons: 1 }));
    l.get("pointerup")!(pe({ pointerId: 1 }));
    expect(calls).toEqual(["down", "move 0.2", "up"]);
  });

  it("M-2: right and middle mouse buttons do not press (and are not captured)", () => {
    const { l, el, win, calls, captured, h } = mk();
    attachPointer(el, h, win);
    l.get("pointerdown")!(pe({ pointerType: "mouse", button: 2, pointerId: 5 }));
    l.get("pointerdown")!(pe({ pointerType: "mouse", button: 1, pointerId: 5 }));
    expect(calls).toEqual([]);
    expect(captured).toEqual([]);
    l.get("pointerdown")!(pe({ pointerType: "mouse", button: 0, pointerId: 5 }));
    expect(calls).toEqual(["down"]);
  });

  it("M-3: a move with no buttons held while pressed releases once (missed pointerup backstop)", () => {
    const { l, el, win, calls, h } = mk();
    attachPointer(el, h, win);
    l.get("pointermove")!(pe({ pointerType: "mouse", buttons: 0, clientX: 30 })); // 누르지 않은 이동은 그냥 이동
    l.get("pointerdown")!(pe({ pointerType: "mouse", button: 0 }));
    l.get("pointermove")!(pe({ pointerType: "mouse", buttons: 0, clientX: 40 }));
    l.get("pointermove")!(pe({ pointerType: "mouse", buttons: 0, clientX: 50 }));
    expect(calls).toEqual(["move 0.3", "down", "up", "move 0.4", "move 0.5"]);
  });

  it("M-3: window blur releases an active press, and is detached", () => {
    const { l, wl, el, win, calls, h } = mk();
    const off = attachPointer(el, h, win);
    wl.get("blur")!();
    expect(calls).toEqual([]);
    l.get("pointerdown")!(pe({}));
    wl.get("blur")!();
    expect(calls).toEqual(["down", "up"]);
    off();
    expect(wl.size).toBe(0);
  });
});

