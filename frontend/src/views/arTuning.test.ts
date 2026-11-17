import { describe, expect, it } from "vitest";
import { describeArTuning, parseArTuning } from "./arTuning";

describe("parseArTuning", () => {
  it("maps every valid parameter to its session option", () => {
    const t = parseArTuning("cf=0.0001&beta=0.01&warm=5&miss=10&alpha=0.18&ralpha=0.2&dead=0.004&rdead=0.01&hold=800");
    expect(t).toEqual({
      filterMinCF: 0.0001,
      filterBeta: 0.01,
      warmupTolerance: 5,
      missTolerance: 10,
      smoothing: { positionAlpha: 0.18, rotationAlpha: 0.2, deadbandPos: 0.004, deadbandRotRad: 0.01, holdMs: 800 },
    });
  });

  it("returns nothing for a missing or empty query, and accepts a leading ? or a whole hash", () => {
    expect(parseArTuning("")).toEqual({});
    expect(parseArTuning("?")).toEqual({});
    expect(parseArTuning("?cf=0.001")).toEqual({ filterMinCF: 0.001 });
    expect(parseArTuning("#/ar?miss=12")).toEqual({ missTolerance: 12 });
  });

  it("ignores garbage values and unknown keys", () => {
    expect(parseArTuning("cf=abc&beta=&warm=1x&miss=0x10&alpha=Infinity&hold=1e999&dead=NaN&zoom=3")).toEqual({});
    expect(parseArTuning("cf=%3Cscript%3E&cf2=1")).toEqual({});
  });

  it("ignores negative and zero values", () => {
    expect(parseArTuning("cf=-0.001&beta=0&hold=-800&alpha=-0.1&rdead=0.0")).toEqual({});
  });

  it("keeps the valid ones when mixed with invalid ones", () => {
    expect(parseArTuning("cf=1e-4&beta=-1&alpha=.3&dead=oops&hold=500")).toEqual({
      filterMinCF: 0.0001,
      smoothing: { positionAlpha: 0.3, holdMs: 500 },
    });
  });

  it("omits smoothing entirely when no smoothing parameter is valid", () => {
    expect(parseArTuning("warm=3&alpha=no")).toEqual({ warmupTolerance: 3 });
    expect("smoothing" in parseArTuning("warm=3&alpha=no")).toBe(false);
  });
});

describe("describeArTuning", () => {
  it("lists the applied values with the query names a tester typed", () => {
    expect(describeArTuning(parseArTuning("hold=500&cf=0.0001&alpha=0.3"))).toBe("조정값 적용 중: cf=0.0001, alpha=0.3, hold=500");
  });

  it("is null when nothing is applied", () => {
    expect(describeArTuning({})).toBeNull();
    expect(describeArTuning(parseArTuning("cf=-1"))).toBeNull();
  });
});
