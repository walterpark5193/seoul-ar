// 회전기: 도시를 지구본처럼 돌리는 yaw·zoom·관성 (계약 CONTRACTS-stage 13.2). 순수 모듈(DOM·three 없음).
// 시간: grab/move/release의 t는 ms(performance.now), tick의 dt는 초. release(t)는 t 이전 velocityWindowMs 창만 본다.
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
/**
 * 속도 창 앞으로 표본을 더 남겨 두는 시간(ms). release(t)의 t는 마지막 표본보다 앞설 수 있다:
 * 손은 처음 편 프레임 시각을 넘기는데 놓기 확정은 그 뒤 6프레임(30fps 약 0.2초, 느린 기기·놓친 프레임이면 더)이다.
 */
const SAMPLE_HISTORY_MS = 1000;

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
    // 보관 구간(창 + SAMPLE_HISTORY_MS) 이전 표본은 하나만 남긴다(기준점).
    const keepFrom = ts - c.velocityWindowMs - SAMPLE_HISTORY_MS;
    let drop = 0;
    while (samples.length - drop > 2 && (samples[drop + 1]?.t ?? Infinity) <= keepFrom) drop++;
    if (drop > 0) samples.splice(0, drop);
  }
  /** 시각 at의 누적 회전: 표본 사이는 직선 보간, 첫 표본 앞은 첫 값, 마지막 표본 뒤는 그 자리에 머문 것으로 본다. */
  function travelAt(at: number): number {
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i]!;
      if (s.t > at) continue;
      const n = samples[i + 1];
      return n && n.t > s.t ? s.a + ((n.a - s.a) * (at - s.t)) / (n.t - s.t) : s.a;
    }
    return samples[0]?.a ?? 0;
  }
  /**
   * end 이전 velocityWindowMs 구간의 평균 각속도(라디안/초). 그 구간의 표본만 쓴다(end 뒤 움직임은 넣지 않는다).
   * end가 마지막 표본보다 늦으면 그때까지 마지막 위치를 유지했다고 보고, 첫 표본보다 이르면(잡기 전) 0.
   */
  function velocityUntil(end: number): number {
    const first = samples[0];
    if (!first || !(end > first.t)) return 0;
    const from = Math.max(first.t, end - c.velocityWindowMs);
    const span = (end - from) / 1000;
    return span > 0 ? (travelAt(end) - travelAt(from)) / span : 0;
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
      // t 이전 창의 속도(계약 13.2): 손은 처음 편 프레임 시각을 넘긴다(놓기 확정은 그보다 늦다).
      const w = Number.isFinite(t) ? velocityUntil(t) : 0;
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
