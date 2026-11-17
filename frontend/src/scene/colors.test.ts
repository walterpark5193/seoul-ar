import { describe, it, expect } from "vitest";
import { PALETTE, colorFor, normalize } from "./colors";

describe("PALETTE", () => {
  it("matches CONTRACTS 4 exactly", () => {
    expect(PALETTE).toEqual({
      bg: "#0b1020",
      guBase: "#1b2340",
      guDim: "#121833",
      ramp: ["#1e3a8a", "#2563eb", "#38bdf8", "#fbbf24", "#f97316"],
      noData: "#4b5563",
      text: "#e5e7eb",
    });
  });
});

describe("colorFor", () => {
  it("colorFor(0) = ramp[0]", () => {
    expect(colorFor(0)).toBe(PALETTE.ramp[0]);
  });
  it("colorFor(1) = ramp[4]", () => {
    expect(colorFor(1)).toBe(PALETTE.ramp[4]);
  });
  it("colorFor(NaN) = noData", () => {
    expect(colorFor(Number.NaN)).toBe(PALETTE.noData);
  });
  it("hits the inner ramp stops exactly", () => {
    expect(colorFor(0.25)).toBe(PALETTE.ramp[1]);
    expect(colorFor(0.5)).toBe(PALETTE.ramp[2]);
    expect(colorFor(0.75)).toBe(PALETTE.ramp[3]);
  });
  it("interpolates linearly between stops", () => {
    // ramp[0] #1e3a8a = (30,58,138), ramp[1] #2563eb = (37,99,235); 가운데 = (33.5,78.5,186.5) → 반올림 (34,79,187)
    expect(colorFor(0.125)).toBe("#224fbb");
  });
  it("clamps out-of-range t and returns #rrggbb", () => {
    expect(colorFor(-3)).toBe(PALETTE.ramp[0]);
    expect(colorFor(7)).toBe(PALETTE.ramp[4]);
    expect(colorFor(0.6)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("normalize", () => {
  it("normalize([10,20,null]) → [0,1,null]", () => {
    expect(normalize([10, 20, null])).toEqual([0, 1, null]);
  });
  it("normalize([5,5]) → [0.5,0.5]", () => {
    expect(normalize([5, 5])).toEqual([0.5, 0.5]);
  });
  it("maps min..max to 0..1 linearly", () => {
    expect(normalize([0, 25, 100])).toEqual([0, 0.25, 1]);
  });
  it("handles all-null and empty input", () => {
    expect(normalize([null, null])).toEqual([null, null]);
    expect(normalize([])).toEqual([]);
  });
  it("treats non-finite numbers as missing", () => {
    expect(normalize([Number.NaN, 1, 3])).toEqual([null, 0, 1]);
  });
});
