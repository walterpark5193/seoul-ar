import { describe, it, expect } from "vitest";
import { nextPreviewMode, HAND_CONNECTIONS, drawSkeleton, cursorClass, renderDiag, type Ctx2DLike } from "./overlay";
import type { HandFrame, HandObs } from "../types";
import { readFileSync } from "node:fs";

// vitest는 CSS import(?raw 포함)를 빈 문자열로 바꾸므로 파일을 직접 읽는다.
const overlayCss = readFileSync(new URL("./overlay.css", import.meta.url), "utf8");
const stageCss = readFileSync(new URL("../stage.css", import.meta.url), "utf8");

/** 평평한 CSS(@규칙 없음)를 선택자 하나씩 펼친 규칙 목록으로. */
function cssRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1]!.split(",")) out.push({ selector: selector.trim().replace(/\s+/g, " "), body: m[2]! });
  }
  return out;
}
const HIDES_RENDERING = /display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden/;

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

// 미리보기 video가 렌더 트리에서 빠지면(display:none 등) 브라우저가 requestVideoFrameCallback을 멈추고,
// 무대는 1.5초 뒤 "카메라 영상이 끊겨" 마우스 모드로 떨어진다. 숨김·골격 모드도 video는 그려지는 채로 둔다.
describe("preview css keeps the camera video rendered", () => {
  const rules = [...cssRules(overlayCss), ...cssRules(stageCss)];
  const previewRules = rules.filter((r) => r.selector.includes("stage-preview"));

  it("reads both stylesheets", () => {
    expect(previewRules.length).toBeGreaterThan(3);
  });
  it("no rule on the preview box or its video uses display:none / visibility:hidden (the skeleton canvas may)", () => {
    for (const r of previewRules) {
      if (/\bcanvas$/.test(r.selector)) continue;
      expect(`${r.selector} {${r.body}}`).not.toMatch(HIDES_RENDERING);
    }
  });
  it("hidden mode is visually hidden: opacity 0, 1px, no pointer events, kept on screen", () => {
    const hidden = previewRules.filter((r) => /\.stage-preview\.is-hidden$/.test(r.selector));
    expect(hidden.map((r) => r.selector)).toContain(".stage-view .stage-preview.is-hidden"); // stage.css의 크기 규칙보다 구체적
    const body = hidden.map((r) => r.body).join(";");
    expect(body).toMatch(/opacity\s*:\s*0\s*(;|$)/);
    expect(body).toMatch(/width\s*:\s*1px/);
    expect(body).toMatch(/height\s*:\s*1px/);
    expect(body).toMatch(/pointer-events\s*:\s*none/);
    expect(body).not.toMatch(/-\d+(px|%|vw|vh)|clip|transform|position\s*:/); // 화면 밖으로 밀거나 잘라 내지 않는다
  });
  it("skeleton mode hides the video by opacity only", () => {
    const skel = previewRules.filter((r) => /\.stage-preview\.is-skeleton video$/.test(r.selector));
    expect(skel.length).toBeGreaterThan(0);
    expect(skel.map((r) => r.body).join(";")).toMatch(/opacity\s*:\s*0\s*(;|$)/);
  });
});
