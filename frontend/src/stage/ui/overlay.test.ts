import { describe, it, expect } from "vitest";
import { nextPreviewMode, HAND_CONNECTIONS, drawSkeleton, cursorClass, renderDiag, type Ctx2DLike } from "./overlay";
import type { HandFrame, HandObs } from "../types";

function fakeCtx() {
  const calls: { op: string; args: unknown[] }[] = [];
  const ctx: Ctx2DLike = {
    clearRect: (...a) => void calls.push({ op: "clearRect", args: a }),
    beginPath: () => void calls.push({ op: "beginPath", args: [] }),
    moveTo: (x, y) => void calls.push({ op: "moveTo", args: [x, y] }),
    lineTo: (x, y) => void calls.push({ op: "lineTo", args: [x, y] }),
    stroke: () => void calls.push({ op: "stroke", args: [] }),
    arc: (x, y, r, a, b) => void calls.push({ op: "arc", args: [x, y, r, a, b] }),
    fill: () => void calls.push({ op: "fill", args: [] }),
    strokeStyle: "", fillStyle: "", lineWidth: 0,
  };
  return { ctx, calls };
}
const hand = (x: number): HandObs => ({
  landmarks: Array.from({ length: 21 }, (_, i) => [x + i * 0.001, 0.5, 0] as [number, number, number]),
  gesture: "None", score: 1, handedness: "Right",
});

describe("overlay", () => {
  it("nextPreviewMode cycles", () => {
    expect(nextPreviewMode("video")).toBe("skeleton");
    expect(nextPreviewMode("skeleton")).toBe("hidden");
    expect(nextPreviewMode("hidden")).toBe("video");
  });
  it("HAND_CONNECTIONS has 21 pairs in 0..20", () => {
    expect(HAND_CONNECTIONS).toHaveLength(21);
    for (const [a, b] of HAND_CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0); expect(b).toBeLessThanOrEqual(20);
      expect(a).not.toBe(b);
    }
    expect(new Set(HAND_CONNECTIONS.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`)).size).toBe(21);
  });
  it("drawSkeleton: two hands -> 42 lines, 42 dots", () => {
    const { ctx, calls } = fakeCtx();
    drawSkeleton(ctx, { t: 0, hands: [hand(0.2), hand(0.6)] } as HandFrame, 200, 100, false);
    expect(calls.filter((c) => c.op === "lineTo")).toHaveLength(42);
    expect(calls.filter((c) => c.op === "arc")).toHaveLength(42);
    expect(calls[0]!.op).toBe("clearRect");
  });
  it("drawSkeleton mirror flips x", () => {
    const a = fakeCtx(), b = fakeCtx();
    const f = { t: 0, hands: [hand(0.25)] } as HandFrame;
    drawSkeleton(a.ctx, f, 200, 100, false);
    drawSkeleton(b.ctx, f, 200, 100, true);
    const x0 = a.calls.find((c) => c.op === "arc")!.args[0] as number;
    const m0 = b.calls.find((c) => c.op === "arc")!.args[0] as number;
    expect(x0).toBeCloseTo(0.25 * 200);
    expect(m0).toBeCloseTo(200 - 0.25 * 200);
  });
  it("cursorClass combos", () => {
    expect(cursorClass({ visible: false, fist: false, hovering: false })).toBe("stage-cursor is-hidden");
    expect(cursorClass({ visible: true, fist: false, hovering: false })).toBe("stage-cursor");
    expect(cursorClass({ visible: true, fist: false, hovering: true })).toBe("stage-cursor is-hover");
    expect(cursorClass({ visible: true, fist: true, hovering: true })).toBe("stage-cursor is-fist is-hover");
  });
  it("renderDiag shows values", () => {
    const h = renderDiag({ fps: 29.6, hands: 2, gesture: "Open_Palm", score: 0.87, cursor: null, loadMs: 1234, delegate: "GPU", input: "hands" });
    expect(h).toContain("30");
    expect(h).not.toContain("29.6");
    expect(h).toContain("—");
    expect(h).toContain("Open_Palm");
    expect(h).toContain("GPU");
    const h2 = renderDiag({ fps: 10, hands: 0, gesture: "None", score: 0, cursor: { x: 0.5, y: 0.25 }, loadMs: null, delegate: null, input: "mouse" });
    expect(h2).toContain("0.50");
    expect(h2).toContain("0.25");
  });
});
