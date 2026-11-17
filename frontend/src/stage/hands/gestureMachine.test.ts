import { describe, expect, it } from "vitest";
import { DEFAULT_GESTURE_CONFIG, createGestureMachine, type GestureMachine } from "./gestureMachine";
import type { GestureEvent, GestureName, GestureOutput, HandObs, Vec3 } from "../types";

const DT = 33;

/** 합성 손: 손목(랜드마크 0) 위치와 손바닥 폭(랜드마크 5↔17 거리)만 의미 있다. */
function hand(gesture: GestureName, score = 0.9, wrist: [number, number] = [0.5, 0.5], palmWidth = 0.1): HandObs {
  const [wx, wy] = wrist;
  const landmarks: Vec3[] = Array.from({ length: 21 }, (): Vec3 => [wx, wy - 0.05, 0]);
  landmarks[0] = [wx, wy, 0];
  landmarks[5] = [wx - palmWidth / 2, wy - 0.1, 0];
  landmarks[17] = [wx + palmWidth / 2, wy - 0.1, 0];
  return { landmarks, gesture, score, handedness: "Unknown" };
}

const fist = (score = 0.9) => hand("Closed_Fist", score);
const open = (score = 0.9) => hand("Open_Palm", score);
const twoOpen = (): HandObs[] => [hand("Open_Palm", 0.9, [0.3, 0.5]), hand("Open_Palm", 0.9, [0.7, 0.5])];

/** 33ms 간격으로 프레임을 밀어 넣는 운전기. */
function driver(m: GestureMachine, t0 = 1000) {
  let t = t0 - DT;
  const step = (hands: HandObs[], voting = false): GestureOutput => {
    t += DT;
    return m.push({ t, hands }, { voting });
  };
  const run = (n: number, hands: HandObs[], voting = false): GestureOutput[] =>
    Array.from({ length: n }, () => step(hands, voting));
  return { step, run, get t() { return t; } };
}

const types = (outs: GestureOutput[]): GestureEvent["type"][] => outs.flatMap((o) => o.events.map((e) => e.type));

describe("DEFAULT_GESTURE_CONFIG", () => {
  it("matches contract 2.2 values", () => {
    expect(DEFAULT_GESTURE_CONFIG).toEqual({ minScore: 0.6, confirmFrames: 6, cooldownMs: 800, releaseAfterMs: 300 });
  });
});

describe("grab", () => {
  it("grab after 6 frames", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(5, [fist()]))).toEqual([]);
    expect(m.fist).toBe(false);
    expect(d.step([fist()]).events).toEqual([{ type: "grab" }]);
    expect(m.fist).toBe(true);
    expect(types(d.run(30, [fist()]))).toEqual([]);
    expect(m.fist).toBe(true);
  });

  it("a broken frame restarts the confirmation count", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(5, [fist()]))).toEqual([]);
    expect(types(d.run(1, [open()]))).toEqual([]);
    expect(types(d.run(5, [fist()]))).toEqual([]);
    expect(types(d.run(1, [fist()]))).toEqual(["grab"]);
  });

  it("low score ignored", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(30, [fist(0.5)]))).toEqual([]);
    expect(m.fist).toBe(false);
  });

  it("score exactly minScore counts", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(6, [fist(0.6)]))).toEqual(["grab"]);
  });

  it("config override changes confirmFrames", () => {
    const d = driver(createGestureMachine({ confirmFrames: 3 }));
    expect(types(d.run(2, [fist()]))).toEqual([]);
    expect(types(d.run(1, [fist()]))).toEqual(["grab"]);
  });
});

describe("release", () => {
  it("release after open (ignores the grab cooldown)", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    const grabT = d.t;
    expect(m.fist).toBe(true);
    expect(types(d.run(5, [open()]))).toEqual([]);
    expect(m.fist).toBe(true);
    expect(d.step([open()]).events).toEqual([{ type: "release" }]);
    expect(d.t - grabT).toBeLessThan(DEFAULT_GESTURE_CONFIG.cooldownMs);
    expect(m.fist).toBe(false);
    expect(types(d.run(30, [open()]))).toEqual([]);
  });

  it("low-score fist counts as not a fist and releases", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    expect(types(d.run(6, [fist(0.4)]))).toEqual(["release"]);
    expect(m.fist).toBe(false);
  });

  it("release on hand loss after releaseAfterMs since the last hand", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    // 마지막 손 프레임 뒤 9프레임(297ms)은 아직, 10번째(330ms)에서 한 번.
    expect(types(d.run(9, []))).toEqual([]);
    expect(m.fist).toBe(true);
    expect(d.step([]).events).toEqual([{ type: "release" }]);
    expect(m.fist).toBe(false);
    expect(types(d.run(20, []))).toEqual([]);
  });

  it("short hand loss then fist again keeps holding", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    expect(types(d.run(5, []))).toEqual([]);
    expect(types(d.run(20, [fist()]))).toEqual([]);
    expect(m.fist).toBe(true);
  });
});

describe("cooldown", () => {
  it("no grab within cooldownMs after release, then grab", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    d.run(6, [open()]);
    const releaseT = d.t;
    expect(m.fist).toBe(false);
    const outs = d.run(40, [fist()]);
    const grabIdx = outs.findIndex((o) => o.events.some((e) => e.type === "grab"));
    expect(types(outs)).toEqual(["grab"]);
    // 첫 번째 주먹 프레임이 releaseT+33, grab 프레임은 releaseT+33*(idx+1)
    const grabT = releaseT + DT * (grabIdx + 1);
    expect(grabT).toBeGreaterThanOrEqual(releaseT + DEFAULT_GESTURE_CONFIG.cooldownMs);
    expect(grabT - DT).toBeLessThan(releaseT + DEFAULT_GESTURE_CONFIG.cooldownMs);
  });

  it("victory is blocked during cooldown after spread", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
    const spreadT = d.t;
    const outs = d.run(40, [hand("Victory")]);
    const idx = outs.findIndex((o) => o.events.length > 0);
    expect(types(outs)).toEqual(["victory"]);
    expect(spreadT + DT * (idx + 1)).toBeGreaterThanOrEqual(spreadT + DEFAULT_GESTURE_CONFIG.cooldownMs);
  });
});

describe("spread", () => {
  it("one open palm is cursor only", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(30, [open()]))).toEqual([]);
    expect(m.fist).toBe(false);
  });

  it("spread needs two open palms, latches, re-fires after a break and cooldown", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(5, twoOpen()))).toEqual([]);
    expect(types(d.run(1, twoOpen()))).toEqual(["spread"]);
    // 계속 유지: 쿨다운이 지나도 추가 없음(래치)
    expect(types(d.run(60, twoOpen()))).toEqual([]);
    // 한 프레임 깨짐(한 손만) → 래치 풀림. 쿨다운은 이미 지났다.
    expect(types(d.run(1, [open()]))).toEqual([]);
    expect(types(d.run(5, twoOpen()))).toEqual([]);
    expect(types(d.run(1, twoOpen()))).toEqual(["spread"]);
  });

  it("re-fire waits for cooldown when the break comes early", () => {
    const d = driver(createGestureMachine());
    d.run(6, twoOpen());
    const spreadT = d.t;
    d.run(1, [hand("Open_Palm"), hand("None", 0.9, [0.7, 0.5])]);
    const outs = d.run(40, twoOpen());
    const idx = outs.findIndex((o) => o.events.length > 0);
    expect(types(outs)).toEqual(["spread"]);
    expect(spreadT + DT * (idx + 2)).toBeGreaterThanOrEqual(spreadT + DEFAULT_GESTURE_CONFIG.cooldownMs);
  });

  it("a score dip alone does not re-arm the latch", () => {
    const d = driver(createGestureMachine());
    d.run(6, twoOpen());
    d.run(30, twoOpen());
    d.run(1, [hand("Open_Palm", 0.5, [0.3, 0.5]), hand("Open_Palm", 0.9, [0.7, 0.5])]);
    expect(types(d.run(60, twoOpen()))).toEqual([]);
  });

  it("fist released by two open palms does not also spread", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(6, [fist()]))).toEqual(["grab"]);
    // 두 손을 1500ms 펴 둔다: release 한 번, spread 없음
    expect(types(d.run(Math.ceil(1500 / DT), twoOpen()))).toEqual(["release"]);
    expect(m.fist).toBe(false);
    // 손 모양이 한 번 바뀌면 다시 spread 가능
    d.run(1, [open()]);
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
  });

  it("three open palms are not a spread", () => {
    const d = driver(createGestureMachine());
    const three = [...twoOpen(), hand("Open_Palm", 0.9, [0.5, 0.2])];
    expect(types(d.run(30, three))).toEqual([]);
  });

  it("spread ignored while fist", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(6, [hand("Closed_Fist", 0.9, [0.3, 0.5], 0.15)]))).toEqual(["grab"]);
    const holding = [hand("Closed_Fist", 0.9, [0.3, 0.5], 0.15), hand("Open_Palm", 0.9, [0.7, 0.5], 0.1)];
    expect(types(d.run(60, holding))).toEqual([]);
    expect(m.fist).toBe(true);
  });
});

describe("victory", () => {
  it("victory latch: fires once while held", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(5, [hand("Victory")]))).toEqual([]);
    expect(types(d.run(1, [hand("Victory")]))).toEqual(["victory"]);
    expect(types(d.run(14, [hand("Victory")]))).toEqual([]);
    // 20프레임을 넘어 쿨다운이 지나도 래치 때문에 추가 없음
    expect(types(d.run(60, [hand("Victory")]))).toEqual([]);
  });

  it("victory re-fires after the gesture changes", () => {
    const d = driver(createGestureMachine());
    d.run(40, [hand("Victory")]);
    d.run(1, [hand("None")]);
    expect(types(d.run(5, [hand("Victory")]))).toEqual([]);
    expect(types(d.run(1, [hand("Victory")]))).toEqual(["victory"]);
  });

  it("low-score victory ignored", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(30, [hand("Victory", 0.5)]))).toEqual([]);
  });
});

describe("voting", () => {
  it("voting silences every event", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(30, [fist()], true))).toEqual([]);
    expect(m.fist).toBe(false);
    expect(types(d.run(30, twoOpen(), true))).toEqual([]);
    expect(types(d.run(30, [hand("Victory")], true))).toEqual([]);
    expect(types(d.run(30, [], true))).toEqual([]);
  });

  it("voting clears a held fist silently", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    expect(m.fist).toBe(true);
    expect(d.step([fist()], true).events).toEqual([]);
    expect(m.fist).toBe(false);
    expect(types(d.run(30, [open()], true))).toEqual([]);
    // 투표가 끝난 뒤에도 release는 나오지 않는다(이미 false)
    expect(types(d.run(30, [open()]))).toEqual([]);
    expect(m.fist).toBe(false);
  });

  it("still reports primary and handCount while voting", () => {
    const d = driver(createGestureMachine());
    const out = d.step([open(), open(), open()], true);
    expect(out.handCount).toBe(3);
    expect(out.primary).not.toBeNull();
  });

  it("frames seen during voting do not confirm a gesture afterwards", () => {
    const d = driver(createGestureMachine());
    d.run(30, [fist()], true);
    expect(types(d.run(5, [fist()]))).toEqual([]);
    expect(types(d.run(1, [fist()]))).toEqual(["grab"]);
  });

  it("two palms held through the end of voting need a break before spread", () => {
    const d = driver(createGestureMachine());
    d.run(30, twoOpen(), true);
    expect(types(d.run(60, twoOpen()))).toEqual([]);
    d.run(1, [open()]);
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
  });
});

describe("primary and handCount", () => {
  it("no hands → primary null, handCount 0", () => {
    const d = driver(createGestureMachine());
    expect(d.step([])).toEqual({ primary: null, events: [], handCount: 0 });
  });

  it("without a previous primary, the widest palm wins", () => {
    const d = driver(createGestureMachine());
    const out = d.step([hand("Open_Palm", 0.9, [0.2, 0.5], 0.08), hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)]);
    expect(out.primary).toBe(1);
  });

  it("primary follows nearest wrist", () => {
    const d = driver(createGestureMachine());
    expect(d.step([hand("Open_Palm", 0.9, [0.2, 0.5], 0.08), hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)]).primary).toBe(1);
    // 순서가 바뀌고 다른 손이 더 커져도, 직전 주 손(0.8 근처) 쪽을 유지
    expect(d.step([hand("Open_Palm", 0.9, [0.78, 0.52], 0.1), hand("Open_Palm", 0.9, [0.25, 0.5], 0.2)]).primary).toBe(0);
    expect(d.step([hand("Open_Palm", 0.9, [0.3, 0.5], 0.2), hand("Open_Palm", 0.9, [0.74, 0.55], 0.1)]).primary).toBe(1);
    // 한 손만 남으면 그 손
    expect(d.step([hand("Open_Palm", 0.9, [0.3, 0.5], 0.2)]).primary).toBe(0);
  });

  it("after a frame with no hands, falls back to the widest palm", () => {
    const d = driver(createGestureMachine());
    d.step([hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)]);
    d.step([]);
    expect(d.step([hand("Open_Palm", 0.9, [0.79, 0.5], 0.08), hand("Open_Palm", 0.9, [0.2, 0.5], 0.14)]).primary).toBe(1);
  });

  it("gesture is judged on the primary hand", () => {
    const m = createGestureMachine();
    const d = driver(m);
    // 큰 손(주 손)은 편 손, 작은 손은 주먹 → grab 없음
    const hands = [hand("Closed_Fist", 0.9, [0.2, 0.5], 0.06), hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)];
    expect(types(d.run(30, hands))).toEqual([]);
    expect(m.fist).toBe(false);
  });

  it("handCount capped 6", () => {
    const d = driver(createGestureMachine());
    const many = Array.from({ length: 8 }, (_, i) => hand("Open_Palm", 0.9, [0.1 * (i + 1), 0.5]));
    expect(d.step(many).handCount).toBe(6);
    expect(d.step(many.slice(0, 3)).handCount).toBe(3);
  });
});

describe("reset", () => {
  it("clears fist, streaks, cooldown and latches", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    expect(m.fist).toBe(true);
    m.reset();
    expect(m.fist).toBe(false);
    // 쿨다운도 지워져 곧바로 다시 확정된다
    expect(types(d.run(6, [fist()]))).toEqual(["grab"]);
    m.reset();
    d.run(6, twoOpen());
    m.reset();
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
  });
});
