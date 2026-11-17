import { describe, it, expect } from "vitest";
import { createRotator, DEFAULT_ROTATE } from "./rotate";
import type { Rotator } from "./rotate";
import type { Point } from "./types";

const DEG = Math.PI / 180;
const deg = (rad: number) => rad / DEG;
const P = (x: number, y = 0.5): Point => ({ x, y });
/** a→b 최단 부호 각도 차(라디안). */
function dAng(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
const inRange = (yaw: number) => yaw > -Math.PI && yaw <= Math.PI;

/** 한 손으로 x0→x1을 t0→t1(ms) 동안 steps번 나눠 끈다(grab 포함, release 없음). */
function drag(r: Rotator, x0: number, x1: number, t0: number, t1: number, steps = 5): void {
  r.grabOne(P(x0), t0);
  for (let i = 1; i <= steps; i++) r.move(P(x0 + ((x1 - x0) * i) / steps), t0 + ((t1 - t0) * i) / steps);
}
/** 360°/s로 오른쪽 튕기기: 0.1초에 화면 0.2(=36°). */
function flick(r: Rotator, t0 = 0): number {
  drag(r, 0.3, 0.5, t0, t0 + 100, 5);
  r.release(t0 + 100);
  return t0 + 100;
}
/** 회전기 모드가 바뀔 때까지(최대 n틱) dt로 돌린다. 틱마다 부호 각도 변화를 모은다. */
function spinOut(r: Rotator, dt: number, n: number): { deltas: number[]; ticks: number } {
  const deltas: number[] = [];
  let ticks = 0;
  while (r.state.mode === "spinning" && ticks < n) {
    const before = r.state.yaw;
    const s = r.tick(dt);
    deltas.push(dAng(before, s.yaw));
    ticks++;
  }
  return { deltas, ticks };
}

describe("DEFAULT_ROTATE", () => {
  it("contract values", () => {
    expect(DEFAULT_ROTATE).toEqual({
      degPerScreen: 180, friction: 2.5, maxSpeedDeg: 720, flickMinDegPerSec: 60, velocityWindowMs: 100,
      zoomMin: 0.7, zoomMax: 1.6, wheelStep: 0.1, resetSeconds: 0.6,
    });
  });
  it("initial state", () => {
    expect(createRotator().state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
});

describe("one hand", () => {
  it("drag right increases yaw", () => {
    const r = createRotator();
    r.grabOne(P(0.4), 0);
    expect(r.state.mode).toBe("one");
    r.move(P(0.5, 0.2), 16);
    r.move(P(0.6, 0.9), 33); // y는 무시
    expect(deg(r.state.yaw)).toBeCloseTo(36, 6);
  });
  it("drag left decreases yaw", () => {
    const r = createRotator();
    drag(r, 0.6, 0.5, 0, 50);
    expect(deg(r.state.yaw)).toBeCloseTo(-18, 6);
  });
  it("move before grab ignored", () => {
    const r = createRotator();
    r.move(P(0.9), 0);
    r.moveTwo(P(0.1), P(0.9), 0);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
    // 잡은 점이 기준: 잡기 전 커서 위치에서 튀지 않음
    r.grabOne(P(0.2), 10);
    expect(r.state.yaw).toBe(0);
    r.move(P(0.25), 20);
    expect(deg(r.state.yaw)).toBeCloseTo(9, 6);
  });
  it("move after release ignored", () => {
    const r = createRotator();
    drag(r, 0.4, 0.41, 0, 500, 10);
    r.release(500);
    const yaw = r.state.yaw;
    r.move(P(0.9), 520);
    expect(r.state.yaw).toBe(yaw);
    expect(r.state.mode).toBe("idle");
  });
  it("custom degPerScreen", () => {
    const r = createRotator({ degPerScreen: 90 });
    drag(r, 0.4, 0.6, 0, 33);
    expect(deg(r.state.yaw)).toBeCloseTo(18, 6);
  });
});

describe("release and inertia", () => {
  it("slow release no spin", () => {
    const r = createRotator();
    drag(r, 0.4, 0.41, 0, 500, 10); // 1.8° / 0.5초 = 3.6°/s
    r.release(500);
    expect(r.state.mode).toBe("idle");
    const yaw = r.state.yaw;
    expect(r.tick(1).yaw).toBe(yaw);
    expect(deg(yaw)).toBeCloseTo(1.8, 6);
  });
  it("stop then release: no spin (hand held still)", () => {
    const r = createRotator();
    drag(r, 0.3, 0.5, 0, 100, 5); // 360°/s로 밀다가
    r.move(P(0.5), 200);          // 멈춰서 0.2초 들고 있음
    r.release(300);
    expect(r.state.mode).toBe("idle");
    const yaw = r.state.yaw;
    expect(r.tick(0.5).yaw).toBe(yaw);
  });
  it("release(t) earlier than the last sample: velocity of the window ending at t (hand opened mid-flick)", () => {
    const r = createRotator();
    drag(r, 0.3, 0.5, 0, 100, 5);                 // 360°/s로 밀다가
    for (let t = 133; t <= 300; t += 33) r.move(P(0.5), t); // 멈춘 채 놓기 확정을 기다린다(약 0.2초)
    r.release(100);                                // 손을 처음 편 시각
    expect(r.state.mode).toBe("spinning");
    const yaw0 = r.state.yaw;
    const f = DEFAULT_ROTATE.friction;
    const dt = 1 / 60;
    expect(deg(dAng(yaw0, r.tick(dt).yaw))).toBeCloseTo((360 / f) * (1 - Math.exp(-f * dt)), 6);
    expect(deg(yaw0)).toBeCloseTo(36, 6); // 각도는 지금 자리(놓기 확정 때)에서 이어진다
  });
  it("release(t) between samples interpolates; a window after the hand stopped is still", () => {
    // 0~100ms 360°/s, 100~200ms 정지 → release(150): [50, 150] 중 50~100만 움직임 = 18°/0.1초 = 180°/s
    const r = createRotator();
    drag(r, 0.3, 0.5, 0, 100, 5);
    r.move(P(0.5), 200);
    r.move(P(0.5), 300);
    r.release(150);
    expect(r.state.mode).toBe("spinning");
    const f = DEFAULT_ROTATE.friction;
    const dt = 1 / 60;
    const yaw0 = r.state.yaw;
    expect(deg(dAng(yaw0, r.tick(dt).yaw))).toBeCloseTo((180 / f) * (1 - Math.exp(-f * dt)), 6);
    // 멈추고 0.1초 넘게 들고 있다가 편 손(release(200)): 창 [100, 200]이 정지라 관성 없음
    const s = createRotator();
    drag(s, 0.3, 0.5, 0, 100, 5);
    s.move(P(0.5), 200);
    s.move(P(0.5), 400);
    s.release(200);
    expect(s.state.mode).toBe("idle");
    // 잡기보다 앞선 t: 표본이 없으니 관성 없음
    const e = createRotator();
    drag(e, 0.3, 0.5, 1000, 1100, 5);
    e.release(900);
    expect(e.state.mode).toBe("idle");
  });
  it("speed just below threshold: no spin", () => {
    const r = createRotator();
    drag(r, 0.5, 0.5 + 5 / 180, 0, 100, 5); // 5° / 0.1초 = 50°/s < 60
    r.release(100);
    expect(r.state.mode).toBe("idle");
  });
  it("flick spins and decays", () => {
    const r = createRotator();
    flick(r);
    expect(r.state.mode).toBe("spinning");
    const dt = 1 / 60;
    const f = DEFAULT_ROTATE.friction;
    const yaw0 = r.state.yaw;
    const first = r.tick(dt);
    // 놓기 직전 0.1초 속도 360°/s, 지수 감속을 정확 적분
    expect(deg(dAng(yaw0, first.yaw))).toBeCloseTo((360 / f) * (1 - Math.exp(-f * dt)), 6);
    const { deltas, ticks } = spinOut(r, dt, 1000);
    expect(r.state.mode).toBe("idle");
    // 360°/s → 5°/s: ln(72)/2.5 ≈ 1.71초
    const seconds = (ticks + 1) * dt;
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(2);
    // 감속 단조: 같은 방향, 매 틱 줄어듦
    let prev = dAng(yaw0, first.yaw);
    for (const d of deltas) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
    // 총 이동 ≈ (360 − 5)/2.5 = 142°
    const total = deg(dAng(yaw0, first.yaw) + deltas.reduce((a, b) => a + b, 0));
    expect(total).toBeCloseTo(142, 0);
    // 멈춘 뒤 그대로
    const rest = r.state.yaw;
    expect(r.tick(1).yaw).toBe(rest);
    expect(r.tick(1).mode).toBe("idle");
  });
  it("flick left spins negative", () => {
    const r = createRotator();
    drag(r, 0.5, 0.3, 0, 100, 5);
    r.release(100);
    expect(r.state.mode).toBe("spinning");
    const before = r.state.yaw;
    expect(dAng(before, r.tick(1 / 60).yaw)).toBeLessThan(0);
  });
  it("max speed clamp", () => {
    const f = DEFAULT_ROTATE.friction;
    const dt = 0.01;
    const expected = (720 / f) * (1 - Math.exp(-f * dt));
    for (const [x0, x1] of [[0, 1], [1, 0]] as const) {
      const r = createRotator();
      drag(r, x0, x1, 0, 10, 1); // 180° / 10ms = 18000°/s
      r.release(10);
      expect(r.state.mode).toBe("spinning");
      const before = r.state.yaw;
      const d = deg(dAng(before, r.tick(dt).yaw));
      expect(Math.abs(d)).toBeCloseTo(expected, 6);
      expect(Math.sign(d)).toBe(x1 > x0 ? 1 : -1);
    }
  });
  it("catch stops spin keeping yaw", () => {
    const r = createRotator();
    flick(r);
    r.tick(0.1);
    r.tick(0.1);
    const yaw = r.state.yaw;
    expect(yaw).not.toBe(0);
    r.catch();
    expect(r.state).toEqual({ yaw, zoom: 1, mode: "idle", panX: 0 });
    expect(r.tick(1).yaw).toBe(yaw);
  });
  it("catch when idle or held is a no-op", () => {
    const r = createRotator();
    r.catch();
    expect(r.state.mode).toBe("idle");
    drag(r, 0.4, 0.5, 0, 50);
    r.catch();
    expect(r.state.mode).toBe("one");
    r.move(P(0.6), 60);
    expect(deg(r.state.yaw)).toBeCloseTo(36, 6);
  });
  it("grabOne while spinning catches", () => {
    const r = createRotator();
    const t = flick(r);
    r.tick(0.1);
    const yaw = r.state.yaw;
    r.grabOne(P(0.7), t + 100);
    expect(r.state).toEqual({ yaw, zoom: 1, mode: "one", panX: 0 });
    expect(r.tick(0.5).yaw).toBe(yaw); // 관성 없음
    r.move(P(0.8), t + 150);           // 그대로 끌면 이어서 돌림
    expect(deg(dAng(yaw, r.state.yaw))).toBeCloseTo(18, 6);
    r.move(P(0.8), t + 400);
    r.release(t + 500);
    expect(r.state.mode).toBe("idle");
  });
  it("release when not held is a no-op", () => {
    const r = createRotator();
    r.release(0);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
    flick(r);
    r.release(200);
    expect(r.state.mode).toBe("spinning");
  });
});

describe("two hands", () => {
  it("two-hand midpoint rotates and distance zooms", () => {
    const r = createRotator();
    r.grabTwo(P(0.4), P(0.6), 0); // 중점 0.5, 거리 0.2
    expect(r.state.mode).toBe("two");
    r.moveTwo(P(0.45), P(0.75), 16); // 중점 0.6(+18°), 거리 0.3(1.5배)
    expect(deg(r.state.yaw)).toBeCloseTo(18, 6);
    expect(r.state.zoom).toBeCloseTo(1.5, 9);
    r.moveTwo(P(0.4), P(0.8), 33); // 거리 0.4 → 2배 → 1.6 클램프
    expect(deg(r.state.yaw)).toBeCloseTo(18, 6);
    expect(r.state.zoom).toBe(1.6);
    r.moveTwo(P(0.55), P(0.65), 50); // 거리 0.1 → 0.5배 → 0.7 클램프
    expect(r.state.zoom).toBe(0.7);
    r.moveTwo(P(0.5, 0.4), P(0.7, 0.6), 66); // 대각 거리 √0.08 ≈ 0.283
    expect(r.state.zoom).toBeCloseTo(Math.sqrt(0.08) / 0.2, 9);
  });
  it("zoom is relative to zoom at grab", () => {
    const r = createRotator();
    r.wheel(-1); // 1.1
    r.grabTwo(P(0.4), P(0.6), 0);
    expect(r.state.zoom).toBeCloseTo(1.1, 9);
    r.moveTwo(P(0.38), P(0.62), 16); // 1.2배
    expect(r.state.zoom).toBeCloseTo(1.32, 9);
  });
  it("one to two keeps yaw, release ends", () => {
    const r = createRotator();
    drag(r, 0.4, 0.5, 0, 50);
    r.grabTwo(P(0.3), P(0.5), 60);
    expect(r.state.mode).toBe("two");
    expect(deg(r.state.yaw)).toBeCloseTo(18, 6);
    r.moveTwo(P(0.3), P(0.5), 400);
    expect(deg(r.state.yaw)).toBeCloseTo(18, 6);
    expect(r.state.zoom).toBe(1);
    r.release(500);
    expect(r.state.mode).toBe("idle");
    r.moveTwo(P(0.1), P(0.9), 520);
    expect(r.state.zoom).toBe(1);
  });
  it("two-hand flick spins", () => {
    const r = createRotator();
    r.grabTwo(P(0.2), P(0.4), 0);
    for (let i = 1; i <= 5; i++) r.moveTwo(P(0.2 + 0.04 * i), P(0.4 + 0.04 * i), 20 * i); // 중점 0.2/0.1초 = 360°/s
    r.release(100);
    expect(r.state.mode).toBe("spinning");
  });
  it("degenerate start distance does not blow up zoom", () => {
    const r = createRotator();
    r.grabTwo(P(0.5), P(0.5), 0);
    r.moveTwo(P(0.4), P(0.6), 16);
    expect(Number.isFinite(r.state.zoom)).toBe(true);
    expect(r.state.zoom).toBeGreaterThanOrEqual(0.7);
    expect(r.state.zoom).toBeLessThanOrEqual(1.6);
  });
});

describe("wheel", () => {
  it("wheel zoom in/out clamp", () => {
    const r = createRotator();
    r.wheel(-100);
    expect(r.state.zoom).toBeCloseTo(1.1, 9);
    r.wheel(100);
    expect(r.state.zoom).toBeCloseTo(1, 9);
    r.wheel(0);
    expect(r.state.zoom).toBeCloseTo(1, 9);
    for (let i = 0; i < 20; i++) r.wheel(-1);
    expect(r.state.zoom).toBe(1.6);
    for (let i = 0; i < 40; i++) r.wheel(3);
    expect(r.state.zoom).toBe(0.7);
    r.wheel(-1);
    expect(r.state.zoom).toBeCloseTo(0.77, 9);
  });
  it("wheel keeps yaw and spin", () => {
    const r = createRotator();
    flick(r);
    r.wheel(-1);
    expect(r.state.mode).toBe("spinning");
    expect(r.state.zoom).toBeCloseTo(1.1, 9);
  });
});

describe("reset", () => {
  /** yaw를 +170°로 만들고 손을 뗀다(관성 없음). */
  function at170(): Rotator {
    const r = createRotator();
    drag(r, 0, 170 / 180, 0, 1000, 20);
    r.move(P(170 / 180), 1300);
    r.release(1400);
    return r;
  }
  it("reset shortest path and instant", () => {
    // +170° → 0: 양수 쪽으로 줄어듦
    const a = at170();
    expect(deg(a.state.yaw)).toBeCloseTo(170, 6);
    a.wheel(-1); // 1.1
    a.reset();
    expect(a.state.mode).toBe("resetting");
    let prevYaw = a.state.yaw;
    let prevZoom = a.state.zoom;
    for (let i = 0; i < 5; i++) {
      const s = a.tick(0.1);
      expect(s.yaw).toBeGreaterThan(0);
      expect(s.yaw).toBeLessThan(prevYaw);
      expect(s.zoom).toBeLessThan(prevZoom);
      expect(s.zoom).toBeGreaterThan(1);
      prevYaw = s.yaw;
      prevZoom = s.zoom;
    }
    expect(a.tick(0.1)).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 }); // 0.6초
    expect(a.tick(0.1)).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });

    // 170° + 18° = 188° = −172° → 0: 음수 쪽으로(±180°를 넘지 않음)
    const b = at170();
    drag(b, 0.2, 0.3, 2000, 2050);
    b.move(P(0.3), 2400);
    b.release(2500);
    expect(deg(b.state.yaw)).toBeCloseTo(-172, 6);
    b.reset();
    prevYaw = b.state.yaw;
    for (let i = 0; i < 5; i++) {
      const s = b.tick(0.1);
      expect(s.yaw).toBeLessThan(0);
      expect(s.yaw).toBeGreaterThan(prevYaw);
      prevYaw = s.yaw;
    }
    expect(b.tick(0.2).yaw).toBe(0);

    // instant
    const c = at170();
    c.wheel(1);
    c.reset(true);
    expect(c.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
    expect(c.tick(0.1)).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
  it("reset at rest is immediately idle", () => {
    const r = createRotator();
    r.reset();
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
  it("reset while spinning stops spin", () => {
    const r = createRotator();
    flick(r);
    r.tick(0.1);
    r.reset();
    expect(r.state.mode).toBe("resetting");
    for (let i = 0; i < 7; i++) r.tick(0.1);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
    expect(r.tick(0.5).yaw).toBe(0); // 남은 관성 없음

    const q = createRotator();
    flick(q);
    q.tick(0.1);
    q.reset(true);
    expect(q.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
    expect(q.tick(0.5).yaw).toBe(0);
  });
  it("reset drops hold", () => {
    const r = createRotator();
    drag(r, 0.4, 0.5, 0, 50);
    r.reset(true);
    r.move(P(0.9), 60);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
  it("catch during reset keeps angle", () => {
    const r = createRotator();
    drag(r, 0.4, 0.6, 0, 50);
    r.move(P(0.6), 300);
    r.release(400);
    r.reset();
    r.tick(0.2);
    const mid = r.state.yaw;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(36 * DEG);
    r.catch();
    expect(r.state.mode).toBe("idle");
    expect(r.tick(1).yaw).toBe(mid);
  });
  it("grabOne during reset stops it and grabs", () => {
    const r = createRotator();
    drag(r, 0.4, 0.6, 0, 50);
    r.move(P(0.6), 300);
    r.release(400);
    r.reset();
    r.tick(0.2);
    const mid = r.state.yaw;
    r.grabOne(P(0.5), 600);
    expect(r.state.mode).toBe("one");
    expect(r.tick(1).yaw).toBe(mid);
  });
});

describe("yaw normalization", () => {
  it("yaw normalized to (-π, π]", () => {
    const left = createRotator();
    drag(left, 1, 0, 0, 100, 1); // −180°
    expect(left.state.yaw).toBe(Math.PI);

    const right = createRotator();
    drag(right, 0, 1, 0, 100, 1); // +180°
    expect(right.state.yaw).toBe(Math.PI);
    right.move(P(1 + 20 / 180), 120); // 200° → −160°
    expect(deg(right.state.yaw)).toBeCloseTo(-160, 6);

    // 긴 끌기(화면 5번 = 900°) 내내 범위 안
    const long = createRotator();
    for (let k = 0; k < 5; k++) {
      long.grabOne(P(0), k * 1000);
      for (let i = 1; i <= 50; i++) {
        long.move(P(i / 50), k * 1000 + i * 10);
        expect(inRange(long.state.yaw)).toBe(true);
      }
      long.move(P(1), k * 1000 + 900);
      long.release(k * 1000 + 950);
    }
    expect(dAng(Math.PI, long.state.yaw)).toBeCloseTo(0, 9); // 900° ≡ 180°(경계라 −π+ε일 수 있음)

    // 관성으로 여러 바퀴 돌아도 범위 안
    const spin = createRotator();
    drag(spin, 0, 1, 0, 10, 1);
    spin.release(10);
    while (spin.state.mode === "spinning") expect(inRange(spin.tick(1 / 60).yaw)).toBe(true);
  });
});

describe("robustness", () => {
  it("bad dt and non-finite input ignored", () => {
    const r = createRotator();
    flick(r);
    const yaw = r.state.yaw;
    expect(r.tick(NaN).yaw).toBe(yaw);
    expect(r.tick(-1).yaw).toBe(yaw);
    expect(r.tick(0).yaw).toBe(yaw);
    expect(r.state.mode).toBe("spinning");
    const g = createRotator();
    g.grabOne(P(0.4), 0);
    g.move(P(NaN), 10);
    g.move(P(0.5), 20);
    expect(deg(g.state.yaw)).toBeCloseTo(18, 6);
    g.wheel(NaN);
    expect(g.state.zoom).toBe(1);
  });
  it("state is a snapshot", () => {
    const r = createRotator();
    const s = r.state as { yaw: number };
    s.yaw = 3;
    expect(r.state.yaw).toBe(0);
  });
});

// ---- 13.8 펼침 화면 확대: 가리키는 곳 기준(panX), 회전 잠금 ----

/** 기준점 s(ndc x) 아래에 보이는 장면 위치(W1 단위): panX + s/zoom. */
const sceneAt = (r: Rotator, s: number) => r.state.panX + s / r.state.zoom;
const panLimit = (z: number) => (z <= 1 ? 0 : 1 - 1 / z);

describe("zoomAt (13.8)", () => {
  it("keeps the scene point under the anchor fixed (pure formula)", () => {
    const r = createRotator();
    // 클램프에 걸리지 않는 순서(각 단계 뒤 |panX| < 1 − 1/z를 같이 확인)
    const steps: [number, number][] = [[1.6, -0.9], [1.4, -0.9], [1.6, 0.6], [1.25, -0.3], [1.45, 0.95]];
    for (const [z, s] of steps) {
      const before = sceneAt(r, s);
      r.zoomAt(z, s);
      expect(r.state.zoom).toBeCloseTo(z, 12);
      expect(Math.abs(r.state.panX)).toBeLessThan(panLimit(z));
      expect(sceneAt(r, s)).toBeCloseTo(before, 12);
    }
    // 첫 단계 값: panX = s/1 − s/1.6
    const q = createRotator();
    q.zoomAt(1.6, -0.9);
    expect(q.state.panX).toBeCloseTo(-0.9 + 0.9 / 1.6, 12);
    expect(q.state.panX).toBeLessThan(0); // 왼쪽(1위 쪽)을 본다
  });
  it("centre anchor keeps panX 0", () => {
    const r = createRotator();
    for (const z of [1.2, 1.6, 0.8, 1.4, 1]) {
      r.zoomAt(z, 0);
      expect(r.state.panX).toBe(0);
    }
  });
  it("clamps |panX| ≤ 1 − 1/z, panX 0 when z ≤ 1, zoom to [zoomMin, zoomMax]", () => {
    const r = createRotator();
    r.zoomAt(1.6, -1);
    expect(r.state.panX).toBeCloseTo(-(1 - 1 / 1.6), 12); // 끝 기준이면 딱 한계
    r.zoomAt(1.2, 1); // 공식대로면 −0.583 → 한계 −(1 − 1/1.2)
    expect(r.state.zoom).toBeCloseTo(1.2, 12);
    expect(r.state.panX).toBeCloseTo(-(1 - 1 / 1.2), 12);
    r.zoomAt(0.9, -0.5);
    expect(r.state.panX).toBe(0);
    r.zoomAt(1.5, 0.8);
    r.zoomAt(1, 0.8);
    expect(r.state.panX).toBe(0);
    r.zoomAt(5, -1);
    expect(r.state.zoom).toBe(1.6);
    r.zoomAt(0.1, -1);
    expect(r.state.zoom).toBe(0.7);
    expect(r.state.panX).toBe(0);

    // 무작위 순서에서도 늘 한계 안(결정적 의사난수)
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const g = createRotator();
    for (let i = 0; i < 500; i++) {
      g.zoomAt(0.5 + 1.5 * rnd(), rnd() * 2 - 1);
      const { zoom, panX } = g.state;
      expect(zoom).toBeGreaterThanOrEqual(0.7);
      expect(zoom).toBeLessThanOrEqual(1.6);
      expect(Math.abs(panX)).toBeLessThanOrEqual(panLimit(zoom) + 1e-12);
      if (zoom <= 1) expect(panX).toBe(0);
    }
  });
  it("bad input: non-finite z ignored, non-finite anchor = centre, anchor clamped to [−1, 1]", () => {
    const r = createRotator();
    r.zoomAt(NaN, -0.5);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
    r.zoomAt(1.4, NaN);
    expect(r.state.zoom).toBeCloseTo(1.4, 12);
    expect(r.state.panX).toBe(0);
    const a = createRotator();
    const b = createRotator();
    a.zoomAt(1.6, -5);
    b.zoomAt(1.6, -1);
    expect(a.state.panX).toBeCloseTo(b.state.panX, 12);
  });
  it("keeps yaw and mode (spin continues)", () => {
    const r = createRotator();
    flick(r);
    const yaw = r.state.yaw;
    r.zoomAt(1.3, 0.5);
    expect(r.state.mode).toBe("spinning");
    expect(r.state.yaw).toBe(yaw);
  });
});

describe("wheel with anchor (13.8)", () => {
  it("wheel(deltaY, anchor) zooms one step anchored at the pointer", () => {
    const r = createRotator();
    const before = sceneAt(r, -0.9);
    r.wheel(-1, -0.9);
    expect(r.state.zoom).toBeCloseTo(1.1, 12);
    expect(r.state.panX).toBeCloseTo(-0.9 + 0.9 / 1.1, 12);
    expect(sceneAt(r, -0.9)).toBeCloseTo(before, 12);
    const b2 = sceneAt(r, -0.9);
    r.wheel(-1, -0.9);
    expect(r.state.zoom).toBeCloseTo(1.21, 12);
    expect(sceneAt(r, -0.9)).toBeCloseTo(b2, 12);
    // 기준점 없는 휠은 가운데 기준: panX 그대로(확대는 한계를 넓히기만)
    const p = r.state.panX;
    r.wheel(-1);
    expect(r.state.zoom).toBeCloseTo(1.331, 12);
    expect(r.state.panX).toBe(p);
    // 1배로 돌아오면 0
    r.wheel(1, 0.3);
    r.wheel(1, 0.3);
    r.wheel(1, 0.3);
    expect(r.state.zoom).toBeCloseTo(1, 12);
    expect(r.state.panX).toBe(0);
  });
  it("map: anchor 0 (default) never pans", () => {
    const r = createRotator();
    for (const d of [-1, -1, -1, 1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1]) {
      r.wheel(d);
      expect(r.state.panX).toBe(0);
    }
  });
});

describe("two hands zoom at midpoint (13.8)", () => {
  it("yaw locked: moveTwo zooms anchored at the midpoint ndc (x·2 − 1), no yaw", () => {
    const r = createRotator();
    r.setYawLocked(true);
    r.grabTwo(P(0.05), P(0.15), 0); // 중점 0.1 → ndc −0.8, 거리 0.1
    const before = sceneAt(r, -0.8);
    r.moveTwo(P(0.025), P(0.175), 16); // 거리 0.15 → 1.5배
    expect(r.state.zoom).toBeCloseTo(1.5, 12);
    expect(r.state.panX).toBeCloseTo(-0.8 + 0.8 / 1.5, 12);
    expect(sceneAt(r, -0.8)).toBeCloseTo(before, 12);
    expect(r.state.yaw).toBe(0);
    // 중점이 옮겨 가면 새 중점이 기준(누적): 중점 0.2 → ndc −0.6
    const b2 = sceneAt(r, -0.6);
    r.moveTwo(P(0.12), P(0.28), 33); // 거리 0.16 → 1.6배
    expect(r.state.zoom).toBeCloseTo(1.6, 12);
    expect(sceneAt(r, -0.6)).toBeCloseTo(b2, 12);
    expect(r.state.yaw).toBe(0);
    r.release(50);
    expect(r.state.mode).toBe("idle");
    expect(r.state.panX).toBeCloseTo(b2 + 0.6 / 1.6, 12); // 놓아도 그대로
  });
  it("yaw unlocked (map): two-hand zoom stays centred, panX 0 (existing behaviour)", () => {
    const r = createRotator();
    r.grabTwo(P(0.05), P(0.15), 0);
    r.moveTwo(P(0.025), P(0.175), 16);
    expect(r.state.zoom).toBeCloseTo(1.5, 12);
    expect(r.state.panX).toBe(0);
    r.moveTwo(P(0.3), P(0.45), 33); // 중점 이동은 회전
    expect(deg(r.state.yaw)).toBeGreaterThan(0);
    expect(r.state.panX).toBe(0);
  });
});

describe("setYawLocked (13.8)", () => {
  it("locked: move/moveTwo do not change yaw, flicks do not spin", () => {
    const r = createRotator();
    r.setYawLocked(true);
    flick(r);
    expect(r.state.yaw).toBe(0);
    expect(r.state.mode).toBe("idle");
    expect(r.tick(0.5).yaw).toBe(0);
    r.grabTwo(P(0.2), P(0.4), 1000);
    for (let i = 1; i <= 5; i++) r.moveTwo(P(0.2 + 0.04 * i), P(0.4 + 0.04 * i), 1000 + 20 * i);
    expect(r.state.yaw).toBe(0);
    r.release(1100);
    expect(r.state.mode).toBe("idle");
    expect(r.tick(0.5).yaw).toBe(0);
  });
  it("locking stops inertia; yaw kept", () => {
    const r = createRotator();
    flick(r);
    r.tick(0.1);
    const yaw = r.state.yaw;
    r.setYawLocked(true);
    expect(r.state.mode).toBe("idle");
    expect(r.tick(0.5).yaw).toBe(yaw);
  });
  it("unlock mid-hold: only motion after unlocking turns (no jump)", () => {
    const r = createRotator();
    r.grabOne(P(0.4), 0);
    r.setYawLocked(true);
    r.move(P(0.6), 16);
    expect(r.state.yaw).toBe(0);
    r.setYawLocked(false);
    r.move(P(0.7), 33);
    expect(deg(r.state.yaw)).toBeCloseTo(18, 6);
  });
  it("reset still returns yaw to 0 while locked", () => {
    const r = createRotator();
    drag(r, 0.4, 0.6, 0, 50);
    r.move(P(0.6), 300);
    r.release(400);
    r.setYawLocked(true);
    r.reset();
    for (let i = 0; i < 7; i++) r.tick(0.1);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
});

describe("reset clears panX (13.8)", () => {
  it("animated: panX eases to 0 with zoom, staying within the clamp", () => {
    const r = createRotator();
    r.zoomAt(1.6, -0.9);
    const p0 = r.state.panX;
    r.reset();
    expect(r.state.mode).toBe("resetting");
    let prev = p0;
    for (let i = 0; i < 5; i++) {
      const s = r.tick(0.1);
      expect(s.panX).toBeLessThan(0);
      expect(s.panX).toBeGreaterThan(prev);
      expect(Math.abs(s.panX)).toBeLessThanOrEqual(panLimit(s.zoom) + 1e-12);
      prev = s.panX;
    }
    expect(r.tick(0.1)).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
  it("instant", () => {
    const r = createRotator();
    r.zoomAt(1.6, 0.7);
    expect(r.state.panX).not.toBe(0);
    r.reset(true);
    expect(r.state).toEqual({ yaw: 0, zoom: 1, mode: "idle", panX: 0 });
  });
});
