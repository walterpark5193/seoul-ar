// 회전기: 도시를 지구본처럼 돌리는 yaw·zoom·관성 (계약 CONTRACTS-stage 13.2). 순수 모듈(DOM·three 없음).
// 시간: grab/move/release의 t는 ms(performance.now), tick의 dt는 초.
import type { Point } from "./types";

export interface RotateConfig {
  degPerScreen: number; friction: number; maxSpeedDeg: number; flickMinDegPerSec: number; velocityWindowMs: number;
  zoomMin: number; zoomMax: number; wheelStep: number; resetSeconds: number;
}
export const DEFAULT_ROTATE: RotateConfig = {
  degPerScreen: 180, friction: 2.5, maxSpeedDeg: 720, flickMinDegPerSec: 60, velocityWindowMs: 100,
  zoomMin: 0.7, zoomMax: 1.6, wheelStep: 0.1, resetSeconds: 0.6,
};
export type RotateMode = "idle" | "one" | "two" | "spinning" | "resetting";
/** yaw 라디안, (-π, π]로 정규화. */
export interface RotateState { yaw: number; zoom: number; mode: RotateMode; }
export interface Rotator {
  grabOne(p: Point, t: number): void;
  grabTwo(a: Point, b: Point, t: number): void;
  move(p: Point, t: number): void;
  moveTwo(a: Point, b: Point, t: number): void;
  release(t: number): void;
  catch(): void;
  wheel(deltaY: number): void;
  reset(instant?: boolean): void;
  tick(dt: number): RotateState;
  readonly state: RotateState;
}

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
/** 관성이 이보다 느려지면 멈춤(계약 13.2: 5°/s). */
const STOP_SPEED = 5 * DEG;
/** 두 손 사이가 이보다 가까우면 확대 기준으로 쓰지 않는다(0으로 나누기 방지). */
const MIN_TWO_DIST = 1e-3;

/** (-π, π]로 정규화. */
function normalize(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}
const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);

interface Sample { t: number; a: number; } // a: 잡은 뒤 누적 회전(라디안, 감기 전)

export function createRotator(cfg: Partial<RotateConfig> = {}): Rotator {
  const c: RotateConfig = { ...DEFAULT_ROTATE, ...cfg };
  const radPerScreen = c.degPerScreen * DEG;
  const clampZoom = (z: number) => Math.min(c.zoomMax, Math.max(c.zoomMin, z));

  let yaw = 0;
  let zoom = 1;
  let mode: RotateMode = "idle";
  let omega = 0;          // 관성 각속도(라디안/초)
  // 잡기
  let lastX = 0;          // one: 마지막 손 x, two: 마지막 중점 x
  let travel = 0;         // 잡은 뒤 누적 회전
  let samples: Sample[] = [];
  // 두 손 확대 기준
  let dist0: number | null = null;
  let zoom0 = 1;
  let lastDist = 0;
  // 리셋 보간
  let resetFromYaw = 0;
  let resetFromZoom = 1;
  let resetElapsed = 0;

  const snapshot = (): RotateState => ({ yaw, zoom, mode });

  function stopMotion(): void {
    omega = 0;
    if (mode === "spinning" || mode === "resetting") mode = "idle";
  }
  function startSamples(t: number): void {
    travel = 0;
    samples = [{ t, a: 0 }];
  }
  function lastT(): number {
    return samples[samples.length - 1]?.t ?? -Infinity;
  }
  /** x 변화만큼 돌리고 속도 표본을 남긴다. */
  function turn(x: number, t: number): void {
    const d = (x - lastX) * radPerScreen;
    lastX = x;
    travel += d;
    yaw = normalize(yaw + d);
    const ts = Math.max(t, lastT());
    samples.push({ t: ts, a: travel });
    // 창 시작 이전 표본은 하나만 남긴다(기준점).
    const from = ts - c.velocityWindowMs;
    while (samples.length > 2 && (samples[1]?.t ?? Infinity) <= from) samples.shift();
  }
  /** 최근 velocityWindowMs의 평균 각속도(라디안/초). now까지 마지막 위치를 유지했다고 본다. */
  function recentVelocity(now: number): number {
    const first = samples[0];
    if (!first) return 0;
    const end = Math.max(now, lastT());
    const from = end - c.velocityWindowMs;
    let t0 = first.t;
    let a0 = first.a;
    if (from > first.t) {
      let i = 0;
      while (i + 1 < samples.length && (samples[i + 1]?.t ?? Infinity) <= from) i++;
      const s = samples[i] ?? first;
      const n = samples[i + 1];
      a0 = n && n.t > s.t ? s.a + ((n.a - s.a) * (from - s.t)) / (n.t - s.t) : s.a;
      t0 = from;
    }
    const span = (end - t0) / 1000;
    return span > 0 ? (travel - a0) / span : 0;
  }
  function twoDist(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  return {
    grabOne(p, t) {
      if (!finitePoint(p) || !Number.isFinite(t)) return;
      stopMotion();
      mode = "one";
      lastX = p.x;
      startSamples(t);
    },
    grabTwo(a, b, t) {
      if (!finitePoint(a) || !finitePoint(b) || !Number.isFinite(t)) return;
      const wasHeld = mode === "one" || mode === "two";
      stopMotion();
      mode = "two";
      lastX = (a.x + b.x) / 2;
      const d = twoDist(a, b);
      lastDist = d;
      dist0 = d >= MIN_TWO_DIST ? d : null;
      zoom0 = zoom;
      // 한 손에서 이어지면 속도 표본을 이어 쓴다(각도는 연속).
      if (!wasHeld) startSamples(t);
    },
    move(p, t) {
      if (mode !== "one" || !finitePoint(p) || !Number.isFinite(t)) return;
      turn(p.x, t);
    },
    moveTwo(a, b, t) {
      if (mode !== "two" || !finitePoint(a) || !finitePoint(b) || !Number.isFinite(t)) return;
      turn((a.x + b.x) / 2, t);
      const d = twoDist(a, b);
      lastDist = d;
      if (dist0 === null) {
        if (d >= MIN_TWO_DIST) { dist0 = d; zoom0 = zoom; }
        return;
      }
      zoom = clampZoom(zoom0 * (d / dist0));
    },
    release(t) {
      if (mode !== "one" && mode !== "two") return;
      const w = Number.isFinite(t) ? recentVelocity(t) : 0;
      const speed = Math.abs(w);
      if (speed >= c.flickMinDegPerSec * DEG && speed > 0) {
        omega = Math.sign(w) * Math.min(speed, c.maxSpeedDeg * DEG);
        mode = "spinning";
      } else {
        omega = 0;
        mode = "idle";
      }
      samples = [];
      dist0 = null;
    },
    catch() {
      stopMotion();
    },
    wheel(deltaY) {
      if (!Number.isFinite(deltaY) || deltaY === 0 || mode === "resetting") return;
      const k = 1 + c.wheelStep;
      zoom = clampZoom(deltaY < 0 ? zoom * k : zoom / k);
      // 두 손으로 잡고 있으면 휠 결과를 새 기준으로.
      if (mode === "two" && lastDist >= MIN_TWO_DIST) { dist0 = lastDist; zoom0 = zoom; }
    },
    reset(instant = false) {
      omega = 0;
      samples = [];
      dist0 = null;
      if (instant || !(c.resetSeconds > 0) || (yaw === 0 && zoom === 1)) {
        yaw = 0;
        zoom = 1;
        mode = "idle";
        return;
      }
      resetFromYaw = yaw; // 이미 (-π, π]라 0으로 곧장 가는 것이 최단 방향
      resetFromZoom = zoom;
      resetElapsed = 0;
      mode = "resetting";
    },
    tick(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return snapshot();
      if (mode === "spinning") {
        const k = Math.exp(-c.friction * dt);
        // ω(t) = ω0·e^(−f·t)의 정확 적분: 프레임률과 무관
        const d = c.friction > 0 ? (omega * (1 - k)) / c.friction : omega * dt;
        yaw = normalize(yaw + d);
        omega *= k;
        if (Math.abs(omega) < STOP_SPEED) { omega = 0; mode = "idle"; }
      } else if (mode === "resetting") {
        resetElapsed += dt;
        const u = Math.min(1, resetElapsed / c.resetSeconds);
        if (u >= 1) {
          yaw = 0;
          zoom = 1;
          mode = "idle";
        } else {
          const e = easeOutCubic(u);
          yaw = resetFromYaw * (1 - e);
          zoom = resetFromZoom + (1 - resetFromZoom) * e;
        }
      }
      return snapshot();
    },
    get state() {
      return snapshot();
    },
  };
}
