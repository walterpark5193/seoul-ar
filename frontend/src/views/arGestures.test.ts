import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POSE, DRAG_RAD_PER_PX, MAX_SCALE, MIN_SCALE, RESET_SECONDS,
  applyDrag, applyPinch, createCityGestures, isDefaultPose, lerpPose, wrapAngle,
} from "./arGestures";

const target = (ignored = false) => ({ closest: (sel: string) => (ignored && sel.length > 0 ? {} : null) });

function fakeGroup() {
  return { rotation: { y: 0 }, scale: { x: 1, setScalar(s: number) { this.x = s; } } };
}

describe("pure gesture math", () => {
  it("drag turns by dx × 0.012 rad and wraps into (-π, π]", () => {
    expect(DRAG_RAD_PER_PX).toBe(0.012);
    expect(applyDrag(DEFAULT_POSE, 100).rotY).toBeCloseTo(1.2);
    expect(applyDrag({ rotY: 3, scale: 1 }, 100).rotY).toBeCloseTo(4.2 - 2 * Math.PI);
    expect(applyDrag({ rotY: -3, scale: 1 }, -100).rotY).toBeCloseTo(-4.2 + 2 * Math.PI);
    expect(applyDrag({ rotY: 0, scale: 1.3 }, 10).scale).toBe(1.3);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(7 * Math.PI)).toBeCloseTo(Math.PI);
  });

  it("pinch scales by the ratio and clamps to 0.6..1.6; bad ratios do nothing", () => {
    expect([MIN_SCALE, MAX_SCALE]).toEqual([0.6, 1.6]);
    expect(applyPinch(DEFAULT_POSE, 1.25).scale).toBeCloseTo(1.25);
    expect(applyPinch(DEFAULT_POSE, 3).scale).toBe(1.6);
    expect(applyPinch(DEFAULT_POSE, 0.1).scale).toBe(0.6);
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) expect(applyPinch(DEFAULT_POSE, bad)).toEqual(DEFAULT_POSE);
  });

  it("isDefaultPose and lerpPose (shortest way round)", () => {
    expect(isDefaultPose(DEFAULT_POSE)).toBe(true);
    expect(isDefaultPose({ rotY: 0.01, scale: 1 })).toBe(false);
    expect(isDefaultPose({ rotY: 0, scale: 1.01 })).toBe(false);
    const half = lerpPose({ rotY: 3, scale: 1.4 }, DEFAULT_POSE, 0.5);
    expect(half.rotY).toBeCloseTo(1.5);
    expect(half.scale).toBeCloseTo(1.2);
    // 3.1 → -3.1 is 0.083 rad the short way, not 6.2 rad back across zero.
    expect(Math.abs(lerpPose({ rotY: 3.1, scale: 1 }, { rotY: -3.1, scale: 1 }, 0.5).rotY)).toBeGreaterThan(3.1);
  });
});

describe("createCityGestures", () => {
  it("one-finger horizontal drag turns the group; vertical movement does nothing", () => {
    const group = fakeGroup();
    const onChange = vi.fn();
    const g = createCityGestures({ group, reducedMotion: false, onChange });
    expect(g.pointerDown(1, 100, 200, target())).toBe(true);
    g.pointerMove(1, 150, 400);
    expect(group.rotation.y).toBeCloseTo(0.6);
    g.pointerMove(1, 150, 100);
    expect(group.rotation.y).toBeCloseTo(0.6);
    g.pointerUp(1);
    g.pointerMove(1, 400, 100);
    expect(group.rotation.y).toBeCloseTo(0.6);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rotY: expect.any(Number) }), false);
  });

  it("two-finger pinch scales uniformly within the clamp, then one finger keeps dragging", () => {
    const group = fakeGroup();
    const g = createCityGestures({ group, reducedMotion: false });
    g.pointerDown(1, 0, 0, target());
    g.pointerDown(2, 100, 0, target());
    g.pointerMove(2, 400, 0);
    expect(group.scale.x).toBe(1.6);
    g.pointerMove(2, 10, 0);
    expect(group.scale.x).toBe(0.6);
    expect(group.rotation.y).toBe(0);
    g.pointerUp(2);
    g.pointerMove(1, 50, 0);
    expect(group.rotation.y).toBeCloseTo(0.6);
  });

  it("ignores pointers that start on the sheet, tools, links or buttons", () => {
    const group = fakeGroup();
    const g = createCityGestures({ group, reducedMotion: false });
    expect(g.pointerDown(1, 0, 0, target(true))).toBe(false);
    g.pointerMove(1, 300, 0);
    expect(group.rotation.y).toBe(0);
  });

  it("reset eases back to the default in 0.6 s, or at once with reduced motion", () => {
    const group = fakeGroup();
    const onChange = vi.fn();
    const g = createCityGestures({ group, reducedMotion: false, onChange });
    g.pointerDown(1, 0, 0, target());
    g.pointerMove(1, 100, 0);
    g.pointerUp(1);
    g.reset();
    expect(RESET_SECONDS).toBe(0.6);
    g.tick(0.3);
    expect(group.rotation.y).toBeGreaterThan(0);
    expect(group.rotation.y).toBeLessThan(1.2);
    g.tick(0.4);
    expect(group.rotation.y).toBe(0);
    expect(group.scale.x).toBe(1);
    expect(g.isDefault()).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_POSE, true);

    const still = fakeGroup();
    const r = createCityGestures({ group: still, reducedMotion: true });
    r.pointerDown(1, 0, 0, target());
    r.pointerMove(1, 100, 0);
    r.reset();
    expect(still.rotation.y).toBe(0);
  });

  it("a new touch cancels a running reset", () => {
    const group = fakeGroup();
    const g = createCityGestures({ group, reducedMotion: false });
    g.pointerDown(1, 0, 0, target());
    g.pointerMove(1, 100, 0);
    g.pointerUp(1);
    g.reset();
    g.tick(0.1);
    const mid = group.rotation.y;
    g.pointerDown(2, 0, 0, target());
    g.tick(1);
    expect(group.rotation.y).toBeCloseTo(mid);
  });
});
