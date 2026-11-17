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

  it("confirmFrames below 1 is treated as 1", () => {
    const d = driver(createGestureMachine({ confirmFrames: 0 }));
    expect(types(d.run(5, []))).toEqual([]);
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

  it("intermittent None detections near the fist still release (empty frames are neutral)", () => {
    // 리뷰 탐침 A: grab 뒤 4프레임마다 한 번 작은 None 손이 잡힌다. 10초 동안 묶여 있으면 안 된다.
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    const blip = [hand("None", 0.9, [0.5, 0.5], 0.05)];
    const outs: GestureOutput[] = [];
    for (let i = 0; i < 75; i++) outs.push(...d.run(3, []), d.step(blip));
    expect(types(outs)).toEqual(["release"]);
    expect(m.fist).toBe(false);
    // 손이 보인 프레임만 세므로 6번째 None 손 프레임(24번째 프레임)에서 release
    expect(outs.findIndex((o) => o.events.length > 0)).toBe(23);
  });

  it("intermittent detections of some other far hand do not keep the fist held", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, [fist()]);
    const far = [hand("None", 0.9, [0.9, 0.9], 0.05)];
    const outs: GestureOutput[] = [];
    for (let i = 0; i < 75; i++) outs.push(...d.run(3, []), d.step(far));
    expect(types(outs)).toEqual(["release"]);
    // 추적 손이 마지막으로 보인 뒤 releaseAfterMs: 10번째 프레임(330ms)
    expect(outs.findIndex((o) => o.events.length > 0)).toBe(9);
  });

  it("frames stalling for 400ms with the fist in the same place: no release", () => {
    // T3 ⚑: 프레임이 멈췄다 다시 와도 같은 자리 주먹이면 같은 손이다(구가 떨어졌다 다시 들리면 안 된다).
    const m = createGestureMachine();
    let t = 1000;
    const outs: GestureOutput[] = [];
    for (let i = 0; i < 6; i++) outs.push(m.push({ t: (t += 33), hands: [fist()] }, { voting: false }));
    expect(types(outs)).toEqual(["grab"]);
    t += 400; // 프레임 정지
    const after: GestureOutput[] = [];
    for (let i = 0; i < 40; i++) after.push(m.push({ t: (t += 33), hands: [fist()] }, { voting: false }));
    expect(types(after)).toEqual([]);
    expect(after[0]!.primary).toBe(0);
    expect(m.fist).toBe(true);
  });

  it("at 3fps a held fist grabs once and never releases", () => {
    const m = createGestureMachine();
    let t = 1000;
    const outs: GestureOutput[] = [];
    for (let i = 0; i < 30; i++) outs.push(m.push({ t: (t += 340), hands: [fist()] }, { voting: false })); // 약 10초
    expect(types(outs)).toEqual(["grab"]);
    expect(m.fist).toBe(true);
  });

  it("after a stall, a fist that comes back far away is a different hand: release", () => {
    const m = createGestureMachine();
    let t = 1000;
    for (let i = 0; i < 6; i++) m.push({ t: (t += 33), hands: [fist()] }, { voting: false });
    t += 400;
    const out = m.push({ t: (t += 33), hands: [hand("Closed_Fist", 0.9, [0.9, 0.9])] }, { voting: false });
    expect(out.events).toEqual([{ type: "release" }]);
  });

  it("after a stall, the same hand opened releases normally", () => {
    const m = createGestureMachine();
    let t = 1000;
    for (let i = 0; i < 6; i++) m.push({ t: (t += 33), hands: [fist()] }, { voting: false });
    t += 400;
    const outs: GestureOutput[] = [];
    for (let i = 0; i < 6; i++) outs.push(m.push({ t: (t += 33), hands: [open()] }, { voting: false }));
    expect(types(outs)).toEqual(["release"]);
    expect(outs.findIndex((o) => o.events.length > 0)).toBe(5); // 비주먹 6프레임 확정(만료로 바로 놓지 않음)
  });

  it("hand-loss release uses elapsed time, not frame count (uneven intervals)", () => {
    const m = createGestureMachine();
    let t = 1000;
    for (let i = 0; i < 6; i++) m.push({ t: (t += 33), hands: [fist()] }, { voting: false });
    const lastHandT = t;
    const gaps = [20, 50, 45, 20, 50, 40, 30, 44]; // 누적 299ms
    for (const g of gaps) expect(m.push({ t: (t += g), hands: [] }, { voting: false }).events).toEqual([]);
    expect(t - lastHandT).toBe(299);
    expect(m.push({ t: (t += 1), hands: [] }, { voting: false }).events).toEqual([{ type: "release" }]);
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
    // 주 손(0.3 쪽)이 그대로 브이를 한다
    const outs = d.run(40, [hand("Victory", 0.9, [0.3, 0.5])]);
    const idx = outs.findIndex((o) => o.events.length > 0);
    expect(types(outs)).toEqual(["victory"]);
    expect(spreadT + DT * (idx + 1)).toBeGreaterThanOrEqual(spreadT + DEFAULT_GESTURE_CONFIG.cooldownMs);
    expect(spreadT + DT * idx).toBeLessThan(spreadT + DEFAULT_GESTURE_CONFIG.cooldownMs);
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
    // 5프레임 깨짐(한 손만)으로는 래치가 안 풀린다
    d.run(5, [open()]);
    expect(types(d.run(30, twoOpen()))).toEqual([]);
    // confirmFrames(6) 연속 깨짐 → 래치 풀림. 쿨다운은 이미 지났다.
    expect(types(d.run(6, [open()]))).toEqual([]);
    expect(types(d.run(5, twoOpen()))).toEqual([]);
    expect(types(d.run(1, twoOpen()))).toEqual(["spread"]);
  });

  it("one None frame while holding two palms does not spread again", () => {
    // 리뷰 탐침 C: 두 손을 약 1.5초 들고 있는 중 한 손이 한 프레임 None
    const d = driver(createGestureMachine());
    const blip = [hand("Open_Palm", 0.9, [0.3, 0.5]), hand("None", 0.9, [0.7, 0.5])];
    const outs = [...d.run(20, twoOpen()), d.step(blip), ...d.run(25, twoOpen()), d.step([open()]), ...d.run(60, twoOpen())];
    expect(types(outs)).toEqual(["spread"]);
  });

  it("re-fire waits for cooldown when the break comes early", () => {
    const d = driver(createGestureMachine());
    d.run(6, twoOpen());
    const spreadT = d.t;
    d.run(6, [hand("Open_Palm", 0.9, [0.3, 0.5]), hand("None", 0.9, [0.7, 0.5])]);
    const outs = d.run(40, twoOpen());
    const idx = outs.findIndex((o) => o.events.length > 0);
    expect(types(outs)).toEqual(["spread"]);
    // 첫 두 손 프레임이 spreadT+33*7
    expect(spreadT + DT * (idx + 7)).toBeGreaterThanOrEqual(spreadT + DEFAULT_GESTURE_CONFIG.cooldownMs);
    expect(spreadT + DT * (idx + 6)).toBeLessThan(spreadT + DEFAULT_GESTURE_CONFIG.cooldownMs);
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
    // 주먹 손(0.3)이 그대로 펴지고 다른 손(0.7)이 함께 펴진다
    expect(types(d.run(6, [hand("Closed_Fist", 0.9, [0.3, 0.5])]))).toEqual(["grab"]);
    // 두 손을 1500ms 펴 둔다: release 한 번(6번째 프레임, 편 손 확정), spread 없음
    const held = d.run(Math.ceil(1500 / DT), twoOpen());
    expect(types(held)).toEqual(["release"]);
    expect(held.findIndex((o) => o.events.length > 0)).toBe(5);
    expect(m.fist).toBe(false);
    // 한 프레임 바뀐 것으로는 안 풀린다
    d.run(1, [open()]);
    expect(types(d.run(30, twoOpen()))).toEqual([]);
    // confirmFrames 연속 바뀌면 다시 spread 가능
    d.run(6, [open()]);
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
  });

  it("releasing with one palm then opening the second hand right away does not spread", () => {
    // 리뷰 탐침 D: release 때 spread 래치가 잠기고 풀림 카운트도 처음부터
    const d = driver(createGestureMachine());
    d.run(6, [fist()]);
    expect(types(d.run(6, [open()]))).toEqual(["release"]);
    expect(types(d.run(40, [open(), hand("Open_Palm", 0.9, [0.8, 0.5])]))).toEqual([]);
  });

  it("three open palms are not a spread", () => {
    const d = driver(createGestureMachine());
    const three = [...twoOpen(), hand("Open_Palm", 0.9, [0.5, 0.2])];
    expect(types(d.run(30, three))).toEqual([]);
  });

  it("spread ignored while fist", () => {
    // 한 손이 주먹이라 spread 조건 자체가 거짓이다. 실제로 확인하는 것: 다른 손이 펴 있어도 주먹이 유지되고 release도 spread도 없다.
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

  it("victory re-fires only after the gesture changes for confirmFrames", () => {
    const d = driver(createGestureMachine());
    d.run(40, [hand("Victory")]);
    // 한 프레임 None은 래치를 풀지 않는다
    d.run(1, [hand("None")]);
    expect(types(d.run(30, [hand("Victory")]))).toEqual([]);
    // 6프레임 연속 다른 제스처 → 다시 가능
    d.run(6, [hand("None")]);
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
    expect(types(d.run(30, twoOpen()))).toEqual([]);
    d.run(6, [open()]);
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
  });

  it("a break seen during voting does not unlock the latch afterwards", () => {
    const d = driver(createGestureMachine());
    d.run(30, [open()], true);
    // 투표 중 6프레임 넘게 한 손이었어도, 투표 뒤 바로 든 두 손은 spread가 아니다
    expect(types(d.run(30, twoOpen()))).toEqual([]);
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
    // 멀리 있는 다른 손만 남으면 releaseAfterMs 동안은 "추적 손 없음"(null), 그 뒤 그 손
    const outs = d.run(10, [hand("Open_Palm", 0.9, [0.3, 0.5], 0.2)]);
    expect(outs.map((o) => o.primary)).toEqual([null, null, null, null, null, null, null, null, null, 0]);
  });

  it("a short gap with no hands keeps tracking", () => {
    const d = driver(createGestureMachine());
    d.step([hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)]);
    d.step([]);
    // 더 큰 손이 있어도 기억하는 손목(0.8) 근처 손을 다시 잡는다
    expect(d.step([hand("Open_Palm", 0.9, [0.79, 0.5], 0.08), hand("Open_Palm", 0.9, [0.2, 0.5], 0.14)]).primary).toBe(0);
  });

  it("after releaseAfterMs with no hands, falls back to the widest palm", () => {
    const d = driver(createGestureMachine());
    d.step([hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)]);
    d.run(10, []);
    expect(d.step([hand("Open_Palm", 0.9, [0.79, 0.5], 0.08), hand("Open_Palm", 0.9, [0.2, 0.5], 0.14)]).primary).toBe(1);
  });

  it("fist hand missing for one frame next to an open hand: no release, primary returns", () => {
    // 리뷰 탐침 B
    const m = createGestureMachine();
    const d = driver(m);
    const F = hand("Closed_Fist", 0.9, [0.3, 0.5], 0.15);
    const O = hand("Open_Palm", 0.9, [0.7, 0.5], 0.1);
    expect(types(d.run(6, [F]))).toEqual(["grab"]);
    expect(d.run(10, [F, O]).map((o) => o.primary)).toEqual(Array(10).fill(0));
    const miss = d.step([O]);
    expect(miss.primary).toBeNull();
    expect(miss.events).toEqual([]);
    const back = d.run(30, [O, F]);
    expect(back.map((o) => o.primary)).toEqual(Array(30).fill(1));
    expect(types(back)).toEqual([]);
    expect(m.fist).toBe(true);
  });

  it("fist hand gone for releaseAfterMs next to another hand: release once, then the other hand", () => {
    const m = createGestureMachine();
    const d = driver(m);
    const F = hand("Closed_Fist", 0.9, [0.3, 0.5], 0.15);
    const O = hand("Open_Palm", 0.9, [0.7, 0.5], 0.1);
    d.run(6, [F]);
    const waiting = d.run(9, [O]);
    expect(waiting.map((o) => o.primary)).toEqual(Array(9).fill(null));
    expect(types(waiting)).toEqual([]);
    const out = d.step([O]);
    expect(out.events).toEqual([{ type: "release" }]);
    expect(out.primary).toBe(0);
    expect(m.fist).toBe(false);
    expect(types(d.run(30, [O]))).toEqual([]);
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
