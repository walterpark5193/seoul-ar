import { describe, expect, it } from "vitest";
import { MAP_POSE, SPREAD_POSE, createStageRenderer, lerpPose, type CameraPose } from "./stageRenderer";

const pitchDeg = (p: CameraPose) =>
  (Math.atan2(p.pos[1] - p.target[1], p.pos[2] - p.target[2]) * 180) / Math.PI;

describe("stageRenderer poses", () => {
  it("MAP_POSE looks down about 55°", () => {
    const a = pitchDeg(MAP_POSE);
    expect(a).toBeGreaterThan(50);
    expect(a).toBeLessThan(60);
  });
  it("SPREAD_POSE about 15–25°", () => {
    const a = pitchDeg(SPREAD_POSE);
    expect(a).toBeGreaterThanOrEqual(15);
    expect(a).toBeLessThanOrEqual(25);
  });
  it("lerpPose endpoints and midpoint", () => {
    expect(lerpPose(MAP_POSE, SPREAD_POSE, 0)).toEqual(MAP_POSE);
    expect(lerpPose(MAP_POSE, SPREAD_POSE, 1)).toEqual(SPREAD_POSE);
    const m = lerpPose(MAP_POSE, SPREAD_POSE, 0.5);
    expect(m.pos[1]).toBeCloseTo((MAP_POSE.pos[1] + SPREAD_POSE.pos[1]) / 2);
    expect(m.target[2]).toBeCloseTo((MAP_POSE.target[2] + SPREAD_POSE.target[2]) / 2);
    expect(m.fov).toBeCloseTo(40);
  });
});

describe("createStageRenderer", () => {
  it("returns null without WebGL", () => {
    const r = createStageRenderer({} as HTMLElement, {
      reducedMotion: false,
      makeRenderer: () => null,
    });
    expect(r).toBeNull();
  });
});
