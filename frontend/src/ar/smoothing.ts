// Second-stage pose smoothing for the AR follower (CONTRACTS 5, "안정화와 고정").
//
// MindAR already runs a One-Euro filter on the tracked matrix; this layer sits on top so a hand-held
// phone's residual micro-jitter never reaches the city. Everything here works on plain arrays so the
// deadband / lerp / hold logic is unit-testable without three's scene graph (see smoothing.test.ts).

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w
export interface Pose {
  position: Vec3;
  quaternion: Quat;
}

export interface ArSmoothing {
  positionAlpha?: number; // lerp factor per 60 fps frame toward the accepted position (0.18)
  rotationAlpha?: number; // slerp factor per 60 fps frame toward the accepted rotation (0.18)
  deadbandPos?: number; // ignore target moves below this, in target-width units (0.004)
  deadbandRotRad?: number; // ignore target rotations below this, in radians (0.01)
  holdMs?: number; // keep the last pose visible this long after the target is lost (800)
}

export const SMOOTHING_DEFAULTS: Required<ArSmoothing> = {
  positionAlpha: 0.18,
  rotationAlpha: 0.18,
  deadbandPos: 0.004,
  deadbandRotRad: 0.01,
  holdMs: 800,
};

export function resolveSmoothing(s?: ArSmoothing): Required<ArSmoothing> {
  const out: Required<ArSmoothing> = { ...SMOOTHING_DEFAULTS };
  if (s) {
    for (const key of Object.keys(SMOOTHING_DEFAULTS) as Array<keyof ArSmoothing>) {
      const v = s[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

/** Per-frame blend factor so `alpha` means "per 60 fps frame" whatever the real frame rate is. */
export function alphaForDt(alpha: number, dt: number): number {
  if (!(dt > 0)) return 0;
  const a = Math.min(Math.max(alpha, 0), 1);
  return 1 - Math.pow(1 - a, dt * 60);
}

const dot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const sameQuat = (a: Quat, b: Quat): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

function normalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return len > 0 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [0, 0, 0, 1];
}

/** Rotation angle (radians) between two orientations; q and -q are the same rotation. */
export function quatAngle(a: Quat, b: Quat): number {
  if (sameQuat(a, b)) return 0;
  const d = Math.min(1, Math.abs(dot(a, b)));
  return 2 * Math.acos(d);
}

/** Shortest-path spherical interpolation; returns a normalized quaternion. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  if (t <= 0 || sameQuat(a, b)) return [a[0], a[1], a[2], a[3]];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cosom = dot(a, b);
  if (cosom < 0) {
    cosom = -cosom;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (t >= 1) return normalize([bx, by, bz, bw]);
  let s0: number, s1: number;
  if (cosom > 0.9995) {
    s0 = 1 - t; // nearly parallel: linear blend avoids the sin(omega) ~ 0 division
    s1 = t;
  } else {
    const omega = Math.acos(cosom);
    const sinom = Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) / sinom;
    s1 = Math.sin(t * omega) / sinom;
  }
  return normalize([a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1]);
}

/** One smoothing step: lerp position / slerp rotation from `prev` toward `target`. */
export function smoothPose(prev: Pose, target: Pose, dt: number, cfg: Pick<Required<ArSmoothing>, "positionAlpha" | "rotationAlpha">): Pose {
  const kp = alphaForDt(cfg.positionAlpha, dt);
  const kr = alphaForDt(cfg.rotationAlpha, dt);
  const p = prev.position, q = target.position;
  return {
    position: [p[0] + (q[0] - p[0]) * kp, p[1] + (q[1] - p[1]) * kp, p[2] + (q[2] - p[2]) * kp],
    quaternion: kr > 0 ? slerp(prev.quaternion, target.quaternion, kr) : [...prev.quaternion],
  };
}

/**
 * Deadband: the accepted pose only moves when the raw target differs from it by more than the
 * thresholds (position in world units — pass deadbandPos * MindAR scale — rotation in radians).
 * Components are judged independently.
 */
export function applyDeadband(accepted: Pose, target: Pose, deadbandPosWorld: number, deadbandRotRad: number): Pose {
  const [ax, ay, az] = accepted.position;
  const [tx, ty, tz] = target.position;
  const moved = Math.hypot(tx - ax, ty - ay, tz - az) > deadbandPosWorld;
  const turned = quatAngle(accepted.quaternion, target.quaternion) > deadbandRotRad;
  return {
    position: moved ? [tx, ty, tz] : accepted.position,
    quaternion: turned ? [...target.quaternion] : accepted.quaternion,
  };
}

export interface FollowerState {
  pose: Pose | null; // what is applied to the follower group
  accepted: Pose | null; // last raw target that passed the deadband
  visible: boolean;
  lostAt: number | null; // time (ms) the target was first reported lost while visible
}

export const INITIAL_FOLLOWER: FollowerState = { pose: null, accepted: null, visible: false, lostAt: null };

export interface Observation {
  visible: boolean; // MindAR currently tracks the target
  pose: Pose | null; // decomposed MindAR anchor matrix (world) when visible
  scale: number; // MindAR anchor scale = target width in world units (converts deadbandPos)
  time: number; // frame timestamp, ms
  dt: number; // seconds since the previous frame
}

const copy = (p: Pose): Pose => ({ position: [...p.position], quaternion: [...p.quaternion] });

/**
 * Follower state machine: snap on (re-)acquisition after being hidden, deadband + smoothing while
 * tracked, hold the last pose for `holdMs` after loss, then hide.
 */
export function stepFollower(state: FollowerState, obs: Observation, cfg: Required<ArSmoothing>): FollowerState {
  if (!obs.visible || !obs.pose) {
    if (!state.visible) return state;
    const lostAt = state.lostAt ?? obs.time;
    if (obs.time - lostAt >= cfg.holdMs) return { ...state, visible: false, lostAt, accepted: null };
    return state.lostAt === lostAt ? state : { ...state, lostAt };
  }
  const target = obs.pose;
  if (!state.visible || !state.pose || !state.accepted) {
    return { pose: copy(target), accepted: copy(target), visible: true, lostAt: null };
  }
  const accepted = applyDeadband(state.accepted, target, cfg.deadbandPos * obs.scale, cfg.deadbandRotRad);
  const pose = smoothPose(state.pose, accepted, obs.dt, cfg);
  return { pose, accepted, visible: true, lostAt: null };
}
