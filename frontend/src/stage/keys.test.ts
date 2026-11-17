import { describe, it, expect } from "vitest";
import { keyToAction, attachPointer } from "./keys";
import type { StageState, VoteState } from "./types";

function vote(p: Partial<VoteState> = {}): VoteState {
  return { round: 1, candidates: ["강남구", "마포구", "송파구"], index: 1, phase: "counting", method: "camera",
    counts: [null, null, null], sources: [null, null, null], reviewEdited: false, winner: null, allZero: false, endsAt: null, ...p };
}
function st(v: VoteState | null = null, p: Partial<StageState> = {}): StageState {
  return { mode: "map", hover: null, lifted: null, focus: null, input: "hands", vote: v, month: "202510", metric: "price", round: 0, ...p };
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
    expect([...l.keys()].sort()).toEqual(["pointerdown", "pointerleave", "pointermove", "pointerup"]);
    l.get("pointermove")!({ clientX: 200, clientY: 100 });
    expect(pts).toEqual([{ x: 0.5, y: 0.5 }]);
    l.get("pointerdown")!({}); l.get("pointerup")!({}); l.get("pointerleave")!({});
    expect(calls).toEqual(["down", "up", "leave"]);
    off();
    expect(l.size).toBe(0);
    expect(removed.length).toBe(4);
  });
});
