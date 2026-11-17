import { describe, it, expect } from "vitest";
import {
  alphaForDt,
  applyDeadband,
  INITIAL_FOLLOWER,
  quatAngle,
  resolveSmoothing,
  slerp,
  smoothPose,
  stepFollower,
  SMOOTHING_DEFAULTS,
  type Pose,
  type Quat,
  type Vec3,
} from "./smoothing";

const Q_ID: Quat = [0, 0, 0, 1];
const rotX = (rad: number): Quat => [Math.sin(rad / 2), 0, 0, Math.cos(rad / 2)];
const pose = (position: Vec3, quaternion: Quat = Q_ID): Pose => ({ position, quaternion });
const cfg = SMOOTHING_DEFAULTS;
const DT60 = 1 / 60;

describe("SMOOTHING_DEFAULTS / resolveSmoothing (CONTRACTS 5)", () => {
  it("has the contract defaults", () => {
    expect(SMOOTHING_DEFAULTS).toEqual({ positionAlpha: 0.18, rotationAlpha: 0.18, deadbandPos: 0.004, deadbandRotRad: 0.01, holdMs: 800 });
  });
  it("fills missing fields and keeps overrides", () => {
    expect(resolveSmoothing()).toEqual(SMOOTHING_DEFAULTS);
    expect(resolveSmoothing({ holdMs: 300, positionAlpha: 0.5 })).toEqual({ ...SMOOTHING_DEFAULTS, holdMs: 300, positionAlpha: 0.5 });
  });
});

describe("alphaForDt: per-frame alpha referenced to 60 fps", () => {
  it("is exactly alpha at 1/60 s", () => expect(alphaForDt(0.18, DT60)).toBeCloseTo(0.18, 10));
  it("covers the same ground over two 30 fps frames as over four 60 fps frames... i.e. 1-(1-a)^2 at 1/30", () => {
    expect(alphaForDt(0.18, 1 / 30)).toBeCloseTo(1 - 0.82 ** 2, 10);
  });
  it("is 0 for dt <= 0 and never exceeds 1", () => {
    expect(alphaForDt(0.18, 0)).toBe(0);
    expect(alphaForDt(0.18, -1)).toBe(0);
    expect(alphaForDt(0.18, 10)).toBeLessThanOrEqual(1);
    expect(alphaForDt(1, DT60)).toBe(1);
  });
});

describe("quaternion helpers", () => {
  it("quatAngle measures the rotation between two orientations (and treats q and -q as equal)", () => {
    expect(quatAngle(Q_ID, rotX(0.5))).toBeCloseTo(0.5, 10);
    expect(quatAngle(Q_ID, [0, 0, 0, -1])).toBeCloseTo(0, 10);
    expect(quatAngle(rotX(0.2), rotX(0.2))).toBe(0);
  });
  it("slerp takes the shortest path and stays normalized", () => {
    const half = slerp(Q_ID, rotX(0.5), 0.5);
    expect(quatAngle(Q_ID, half)).toBeCloseTo(0.25, 10);
    const len = Math.hypot(...half);
    expect(len).toBeCloseTo(1, 10);
    // target expressed as -q: no spin through the long way round
    const toNeg = slerp(Q_ID, [0, 0, 0, -1], 0.3);
    expect(quatAngle(Q_ID, toNeg)).toBeCloseTo(0, 10);
    expect(slerp(Q_ID, rotX(0.5), 0)).toEqual(Q_ID);
    expect(quatAngle(slerp(Q_ID, rotX(0.5), 1), rotX(0.5))).toBeCloseTo(0, 10);
  });
});

describe("smoothPose: lerp position / slerp rotation toward the target", () => {
  it("moves 18% of the way per 60 fps frame with the default alphas", () => {
    const next = smoothPose(pose([0, 0, 0]), pose([100, -50, 10], rotX(0.5)), DT60, cfg);
    expect(next.position[0]).toBeCloseTo(18, 6);
    expect(next.position[1]).toBeCloseTo(-9, 6);
    expect(next.position[2]).toBeCloseTo(1.8, 6);
    expect(quatAngle(Q_ID, next.quaternion)).toBeCloseTo(0.09, 6);
  });
  it("does not move when dt is 0 and is exactly stationary when already at the target", () => {
    const p = pose([3, 4, 5], rotX(0.3));
    expect(smoothPose(p, pose([100, 0, 0]), 0, cfg)).toEqual(p);
    const still = smoothPose(p, p, DT60, cfg);
    expect(still.position).toEqual(p.position);
    expect(still.quaternion).toEqual(p.quaternion);
  });
  it("converges onto the target over time", () => {
    let p = pose([0, 0, 0]);
    const target = pose([100, 0, 0], rotX(1.0));
    for (let i = 0; i < 120; i++) p = smoothPose(p, target, DT60, cfg);
    expect(p.position[0]).toBeCloseTo(100, 2);
    expect(quatAngle(p.quaternion, target.quaternion)).toBeLessThan(1e-3);
  });
});

describe("applyDeadband: micro-changes never reach the accepted pose", () => {
  const accepted = pose([10, 20, 30], rotX(0.2));
  const deadPos = 0.004 * 1024; // deadbandPos in target-width units, converted with the MindAR scale (1024 px)
  it("ignores a position change below the deadband (edge inclusive) and a rotation below deadbandRotRad", () => {
    const jitter = pose([10 + 2, 20 - 3, 30 + 1], rotX(0.2 + 0.005));
    expect(applyDeadband(accepted, jitter, deadPos, cfg.deadbandRotRad)).toEqual(accepted);
  });
  it("accepts a position change above the deadband while still ignoring a rotation below it (independent per component)", () => {
    const moved = pose([10 + 5, 20, 30], rotX(0.2 + 0.005));
    const next = applyDeadband(accepted, moved, deadPos, cfg.deadbandRotRad);
    expect(next.position).toEqual([15, 20, 30]);
    expect(next.quaternion).toEqual(accepted.quaternion);
  });
  it("accepts a rotation change above deadbandRotRad", () => {
    const turned = pose([10, 20, 30], rotX(0.2 + 0.02));
    const next = applyDeadband(accepted, turned, deadPos, cfg.deadbandRotRad);
    expect(next.quaternion).toEqual(turned.quaternion);
    expect(next.position).toEqual(accepted.position);
  });
});

describe("stepFollower: snap / smooth / deadband / hold state machine", () => {
  const obs = (over: Partial<{ visible: boolean; pose: Pose | null; time: number; dt: number }>) => ({
    visible: true,
    pose: pose([0, 0, -1500]),
    scale: 1024,
    time: 0,
    dt: DT60,
    ...over,
  });

  it("stays hidden while nothing has ever been seen", () => {
    const s = stepFollower(INITIAL_FOLLOWER, obs({ visible: false, pose: null, time: 100 }), cfg);
    expect(s).toEqual(INITIAL_FOLLOWER);
  });

  it("snaps onto the first acquisition", () => {
    const target = pose([100, 5, -1500], rotX(0.3));
    const s = stepFollower(INITIAL_FOLLOWER, obs({ pose: target, time: 100 }), cfg);
    expect(s.visible).toBe(true);
    expect(s.pose).toEqual(target);
    expect(s.accepted).toEqual(target);
    expect(s.lostAt).toBeNull();
  });

  it("keeps the pose bit-identical through sub-deadband jitter (position < 0.004*scale, rotation < 0.01 rad)", () => {
    const target = pose([100, 5, -1500], rotX(0.3));
    let s = stepFollower(INITIAL_FOLLOWER, obs({ pose: target, time: 0 }), cfg);
    for (let i = 1; i <= 60; i++) {
      const sign = i % 2 ? 1 : -1;
      const noisy = pose([100 + sign * 1.5, 5 - sign * 2, -1500 + sign * 1], rotX(0.3 + sign * 0.004));
      s = stepFollower(s, obs({ pose: noisy, time: i * 16.667 }), cfg);
      expect(s.pose).toEqual(target);
      expect(s.accepted).toEqual(target);
    }
  });

  it("follows a motion above the deadband and converges on it", () => {
    let s = stepFollower(INITIAL_FOLLOWER, obs({ pose: pose([0, 0, -1500]), time: 0 }), cfg);
    const target = pose([100, 0, -1500], rotX(0.4));
    s = stepFollower(s, obs({ pose: target, time: 16.667 }), cfg);
    expect(s.accepted).toEqual(target);
    expect(s.pose!.position[0]).toBeCloseTo(18, 5);
    for (let i = 2; i < 120; i++) s = stepFollower(s, obs({ pose: target, time: i * 16.667 }), cfg);
    expect(s.pose!.position[0]).toBeCloseTo(100, 2);
    expect(quatAngle(s.pose!.quaternion, target.quaternion)).toBeLessThan(1e-3);
  });

  it("holds the last pose for holdMs after the target is lost, then hides (pose retained for reference)", () => {
    const target = pose([100, 5, -1500]);
    let s = stepFollower(INITIAL_FOLLOWER, obs({ pose: target, time: 1000 }), cfg);
    s = stepFollower(s, obs({ visible: false, pose: null, time: 1016 }), cfg);
    expect(s.visible).toBe(true);
    expect(s.lostAt).toBe(1016);
    s = stepFollower(s, obs({ visible: false, pose: null, time: 1016 + 799 }), cfg);
    expect(s.visible).toBe(true);
    expect(s.pose).toEqual(target);
    s = stepFollower(s, obs({ visible: false, pose: null, time: 1016 + 800 }), cfg);
    expect(s.visible).toBe(false);
    expect(s.pose).toEqual(target);
    // staying lost keeps it hidden
    const later = stepFollower(s, obs({ visible: false, pose: null, time: 5000 }), cfg);
    expect(later.visible).toBe(false);
  });

  it("re-acquiring within the hold keeps it visible and lerps (no snap), clearing lostAt", () => {
    let s = stepFollower(INITIAL_FOLLOWER, obs({ pose: pose([0, 0, -1500]), time: 0 }), cfg);
    s = stepFollower(s, obs({ visible: false, pose: null, time: 100 }), cfg);
    s = stepFollower(s, obs({ pose: pose([50, 0, -1500]), time: 400 }), cfg);
    expect(s.visible).toBe(true);
    expect(s.lostAt).toBeNull();
    expect(s.pose!.position[0]).toBeGreaterThan(0);
    expect(s.pose!.position[0]).toBeLessThan(50); // lerping, not snapping
  });

  it("re-acquiring after it was hidden snaps to the new pose", () => {
    let s = stepFollower(INITIAL_FOLLOWER, obs({ pose: pose([0, 0, -1500]), time: 0 }), cfg);
    s = stepFollower(s, obs({ visible: false, pose: null, time: 100 }), cfg);
    s = stepFollower(s, obs({ visible: false, pose: null, time: 2000 }), cfg);
    expect(s.visible).toBe(false);
    const target = pose([300, 0, -1200], rotX(0.7));
    s = stepFollower(s, obs({ pose: target, time: 2016 }), cfg);
    expect(s.visible).toBe(true);
    expect(s.pose).toEqual(target);
  });
});
