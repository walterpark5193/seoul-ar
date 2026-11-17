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

  it("spinning: a fist grabs without waiting for the cooldown, still after confirmFrames (contract 13.3)", () => {
    const m = createGestureMachine();
    let t = 1000 - DT;
    const step = (hands: HandObs[], spinning: boolean) => { t += DT; return m.push({ t, hands }, { voting: false, spinning }); };
    for (let i = 0; i < 6; i++) step([fist()], false);
    for (let i = 0; i < 6; i++) step([open()], false); // release → 관성 시작(쿨다운 800ms 시작)
    const releaseT = t;
    for (let i = 0; i < 3; i++) step([open()], true);
    const outs = Array.from({ length: 6 }, () => step([fist()], true));
    expect(types(outs)).toEqual(["grab"]);
    expect(outs[5]!.events).toEqual([{ type: "grab" }]); // 확정 6프레임은 그대로
    expect(t - releaseT).toBeLessThan(DEFAULT_GESTURE_CONFIG.cooldownMs);
    expect(m.fist).toBe(true);
    // 관성이 아니면(spinning false) 같은 흐름에서 쿨다운을 기다린다(없을 때는 위 "no grab within cooldownMs")
    const n = createGestureMachine();
    let u = 1000 - DT;
    const stepN = (hands: HandObs[]) => { u += DT; return n.push({ t: u, hands }, { voting: false, spinning: false }); };
    for (let i = 0; i < 6; i++) stepN([fist()]);
    for (let i = 0; i < 6; i++) stepN([open()]);
    for (let i = 0; i < 3; i++) stepN([open()]);
    expect(types(Array.from({ length: 6 }, () => stepN([fist()])))).toEqual([]);
  });

  it("spinning does not lift the cooldown for spread or victory", () => {
    const m = createGestureMachine();
    let t = 1000 - DT;
    const step = (hands: HandObs[]) => { t += DT; return m.push({ t, hands }, { voting: false, spinning: true }); };
    for (let i = 0; i < 6; i++) step([fist()]);
    for (let i = 0; i < 6; i++) step([open()]);
    const releaseT = t;
    const outs = Array.from({ length: 40 }, () => step([hand("Victory", 0.9)]));
    const idx = outs.findIndex((o) => o.events.length > 0);
    expect(types(outs)).toEqual(["victory"]);
    expect(releaseT + DT * (idx + 1)).toBeGreaterThanOrEqual(releaseT + DEFAULT_GESTURE_CONFIG.cooldownMs);
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
    expect(d.step([])).toEqual({ primary: null, secondary: null, events: [], handCount: 0 });
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

describe("two fists (contract 13.3)", () => {
  // L(0.3)이 조금 더 커서 추적 기억이 없으면 L이 주 손이 된다(같은 폭이면 부동소수 차이로 갈린다).
  const L = (g: GestureName, score = 0.9) => hand(g, score, [0.3, 0.5], 0.12);
  const R = (g: GestureName, score = 0.9) => hand(g, score, [0.7, 0.5]);
  const twoFists = (): HandObs[] => [L("Closed_Fist"), R("Closed_Fist")];

  it("secondary is the other hand", () => {
    // 손 없음·한 손이면 null
    const d0 = driver(createGestureMachine());
    expect(d0.step([]).secondary).toBeNull();
    expect(d0.step([open()]).secondary).toBeNull();

    // 두 손: 주 손(큰 손)이 아닌 손
    const d = driver(createGestureMachine());
    const first = d.step([hand("Open_Palm", 0.9, [0.2, 0.5], 0.08), hand("Open_Palm", 0.9, [0.8, 0.5], 0.14)]);
    expect([first.primary, first.secondary]).toEqual([1, 0]);
    // 순서가 바뀌어도 주 손은 손목을 따라가고, 둘째 손은 남은 손(더 커도)
    const swapped = d.step([hand("Open_Palm", 0.9, [0.78, 0.52], 0.1), hand("Open_Palm", 0.9, [0.25, 0.5], 0.2)]);
    expect([swapped.primary, swapped.secondary]).toEqual([0, 1]);
    // 한 손만 남으면 null
    expect(d.step([hand("Open_Palm", 0.9, [0.78, 0.52], 0.1)]).secondary).toBeNull();

    // 세 손: 주 손이 아닌 손 중 손바닥이 가장 큰 손
    const d3 = driver(createGestureMachine());
    const three = [hand("Open_Palm", 0.9, [0.2, 0.5], 0.08), hand("Open_Palm", 0.9, [0.5, 0.5], 0.14), hand("Open_Palm", 0.9, [0.8, 0.5], 0.12)];
    const o3 = d3.step(three);
    expect([o3.primary, o3.secondary]).toEqual([1, 2]);

    // 투표 중에도 알려 준다
    const dv = driver(createGestureMachine());
    const ov = dv.step(three, true);
    expect([ov.primary, ov.secondary]).toEqual([1, 2]);

    // 주 손이 없는 프레임(추적 손 기억 중 근처에 손 없음): 모든 손이 "주 손이 아닌 손"이라 가장 큰 손
    const dn = driver(createGestureMachine());
    dn.step([hand("Open_Palm", 0.9, [0.5, 0.9], 0.1)]);
    const on = dn.step([hand("Open_Palm", 0.9, [0.2, 0.2], 0.08), hand("Open_Palm", 0.9, [0.8, 0.2], 0.14)]);
    expect([on.primary, on.secondary]).toEqual([null, 1]);
  });

  it("twoFist after 6 frames both fists", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(5, twoFists()))).toEqual([]);
    // 주 손도 주먹이므로 grab이 같은 프레임에 함께 난다(두 주먹은 단일 주먹 상태와 독립). 순서: grab → twoFist
    expect(types(d.run(1, twoFists()))).toEqual(["grab", "twoFist"]);
    expect(m.fist).toBe(true);
  });

  it("twoFist: a broken frame restarts the count, low score and other hand counts do not qualify", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(5, twoFists()))).toEqual([]);
    d.step([L("Closed_Fist"), R("Closed_Fist", 0.5)]); // 한 손 점수 미달: 끊김
    const outs = d.run(6, twoFists());
    expect(outs.findIndex((o) => o.events.some((e) => e.type === "twoFist"))).toBe(5);

    const d1 = driver(createGestureMachine());
    expect(types(d1.run(30, [L("Closed_Fist"), R("Closed_Fist", 0.5)])).filter((e) => e === "twoFist")).toEqual([]);
    const d2 = driver(createGestureMachine());
    expect(types(d2.run(30, [L("Closed_Fist"), R("Open_Palm")])).filter((e) => e === "twoFist")).toEqual([]);
    const d3 = driver(createGestureMachine());
    expect(types(d3.run(30, [...twoFists(), hand("Closed_Fist", 0.9, [0.5, 0.2])])).filter((e) => e === "twoFist")).toEqual([]);
  });

  it("twoFist latch", () => {
    const d = driver(createGestureMachine());
    expect(types(d.run(6, twoFists()))).toEqual(["grab", "twoFist"]);
    // 쿨다운이 지나도록 계속 쥐고 있어도 다시 나지 않는다
    expect(types(d.run(60, twoFists()))).toEqual([]);
  });

  it("twoFistEnd when one opens", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, twoFists());
    // 둘째 손(R)이 편다: 비주먹 6프레임째 한 번. 주 손 주먹(fist)은 그대로
    expect(types(d.run(5, [L("Closed_Fist"), R("Open_Palm")]))).toEqual([]);
    expect(d.step([L("Closed_Fist"), R("Open_Palm")]).events).toEqual([{ type: "twoFistEnd" }]);
    expect(m.fist).toBe(true);
    expect(types(d.run(30, [L("Closed_Fist"), R("Open_Palm")]))).toEqual([]);
    // 풀린 뒤 다시 두 주먹 → 새로 6프레임 확정 후 다시 twoFist
    expect(types(d.run(5, twoFists()))).toEqual([]);
    expect(types(d.run(1, twoFists()))).toEqual(["twoFist"]);
    // 점수 미달 주먹도 주먹이 아님(release와 같은 기준)
    expect(types(d.run(6, [L("Closed_Fist"), R("Closed_Fist", 0.4)]))).toEqual(["twoFistEnd"]);
  });

  it("twoFistEnd when the primary hand opens comes with release (release first)", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, twoFists());
    const outs = d.run(6, [L("Open_Palm"), R("Closed_Fist")]);
    expect(types(outs)).toEqual(["release", "twoFistEnd"]);
    expect(outs.findIndex((o) => o.events.length > 0)).toBe(5);
    expect(m.fist).toBe(false);
  });

  it("twoFist survives 1-frame dropout", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, twoFists());
    const outs = [
      ...d.run(10, twoFists()),
      d.step([L("Closed_Fist")]), // 둘째 손 한 프레임 놓침
      ...d.run(10, twoFists()),
      d.step([]), // 두 손 다 한 프레임 놓침
      ...d.run(10, twoFists()),
      d.step([L("Closed_Fist"), R("None")]), // 한 프레임 None
      ...d.run(10, twoFists()),
      ...d.run(9, [L("Closed_Fist")]), // releaseAfterMs 미만(297ms) 놓침
      ...d.run(30, twoFists()),
    ];
    expect(types(outs)).toEqual([]);
    expect(m.fist).toBe(true);
  });

  it("twoFistEnd after hand loss 300ms", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, twoFists());
    // 둘째 손이 사라지고 주 손 주먹만 남는다: 마지막 두 손 프레임 뒤 9프레임(297ms)은 아직, 10번째(330ms)에서 한 번
    expect(types(d.run(9, [L("Closed_Fist")]))).toEqual([]);
    expect(d.step([L("Closed_Fist")]).events).toEqual([{ type: "twoFistEnd" }]);
    expect(m.fist).toBe(true);
    expect(types(d.run(20, [L("Closed_Fist")]))).toEqual([]);

    // 두 손이 다 사라지면 release와 같은 프레임(330ms)
    const m2 = createGestureMachine();
    const d2 = driver(m2);
    d2.run(6, twoFists());
    expect(types(d2.run(9, []))).toEqual([]);
    expect(types(d2.run(1, []))).toEqual(["release", "twoFistEnd"]);
    expect(types(d2.run(20, []))).toEqual([]);
  });

  it("hand-loss twoFistEnd uses elapsed time since the last two-hand frame (uneven intervals)", () => {
    const m = createGestureMachine();
    let t = 1000;
    for (let i = 0; i < 6; i++) m.push({ t: (t += 33), hands: twoFists() }, { voting: false });
    const lastTwoT = t;
    const gaps = [20, 50, 45, 20, 50, 40, 30, 44]; // 누적 299ms
    for (const g of gaps) expect(m.push({ t: (t += g), hands: [L("Closed_Fist")] }, { voting: false }).events).toEqual([]);
    expect(t - lastTwoT).toBe(299);
    expect(m.push({ t: (t += 1), hands: [L("Closed_Fist")] }, { voting: false }).events).toEqual([{ type: "twoFistEnd" }]);
  });

  it("voting silences twoFist", () => {
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(30, twoFists(), true))).toEqual([]);
    // 투표 중 본 프레임은 확정에 세지 않는다
    expect(types(d.run(5, twoFists()))).toEqual([]);
    expect(types(d.run(1, twoFists()))).toEqual(["grab", "twoFist"]);
    // 두 주먹 상태에서 투표가 시작되면 조용히 해제: twoFistEnd 없음
    expect(d.step(twoFists(), true).events).toEqual([]);
    expect(types(d.run(30, [L("Open_Palm"), R("Open_Palm")], true))).toEqual([]);
    // 투표 뒤 손을 펴거나 놓쳐도 twoFistEnd(또는 release)는 나오지 않는다(이미 풀림)
    expect(types(d.run(30, [L("Open_Palm"), R("Open_Palm")]))).toEqual([]);
    expect(types(d.run(30, []))).toEqual([]);
    expect(m.fist).toBe(false);
  });

  it("single fist grab/release unaffected by second fist", () => {
    const m = createGestureMachine();
    const d = driver(m);
    const outs: GestureOutput[] = [];
    // 주 손(L)만 주먹: 지금처럼 6프레임째 grab
    const g = d.run(6, [L("Closed_Fist")]);
    outs.push(...g);
    expect(types(g)).toEqual(["grab"]);
    expect(g.findIndex((o) => o.events.length > 0)).toBe(5);
    // 둘째 손이 들어와 주먹: twoFist만(grab 다시 없음)
    const two = d.run(6, twoFists());
    outs.push(...two);
    expect(types(two)).toEqual(["twoFist"]);
    expect(m.fist).toBe(true);
    // 둘째 손이 펴지면 twoFistEnd만(release 없음)
    const half = d.run(6, [L("Closed_Fist"), R("Open_Palm")]);
    outs.push(...half);
    expect(types(half)).toEqual(["twoFistEnd"]);
    expect(m.fist).toBe(true);
    // 둘째 손이 사라져도 주먹은 그대로
    const solo = d.run(30, [L("Closed_Fist")]);
    outs.push(...solo);
    expect(types(solo)).toEqual([]);
    // 주 손은 내내 L(0번)
    expect(outs.every((o) => o.primary === 0)).toBe(true);
    // 주 손을 펴면 지금처럼 비주먹 6프레임째 release
    const rel = d.run(6, [L("Open_Palm")]);
    expect(types(rel)).toEqual(["release"]);
    expect(rel.findIndex((o) => o.events.length > 0)).toBe(5);
    expect(m.fist).toBe(false);
  });

  it("twoFist ignores the grab cooldown; opening the two fists does not spread", () => {
    // 브이 직후(쿨다운 중) 두 주먹: twoFist는 쿨다운과 무관하게 나고, grab은 쿨다운에 막힌다.
    // 그대로 두 손을 펴면 release가 없어도 twoFistEnd가 spread 래치를 잠가 펼치기로 번지지 않는다(release 규칙과 같은 이유).
    const m = createGestureMachine();
    const d = driver(m);
    expect(types(d.run(6, [L("Victory")]))).toEqual(["victory"]);
    expect(types(d.run(8, twoFists()))).toEqual(["twoFist"]);
    expect(m.fist).toBe(false);
    const opened = d.run(40, [L("Open_Palm"), R("Open_Palm")]);
    expect(types(opened)).toEqual(["twoFistEnd"]);
    // 모양이 confirmFrames 연속 바뀌면 다시 spread 가능
    d.run(6, [L("Open_Palm")]);
    expect(types(d.run(6, twoOpen()))).toEqual(["spread"]);
  });

  it("reset clears the two-fist state", () => {
    const m = createGestureMachine();
    const d = driver(m);
    d.run(6, twoFists());
    m.reset();
    // 풀린 상태라 손을 펴도 twoFistEnd 없음, 다시 쥐면 6프레임째 twoFist
    expect(types(d.run(30, [L("Open_Palm"), R("Open_Palm")])).filter((e) => e.startsWith("twoFist"))).toEqual([]);
    m.reset();
    expect(types(d.run(6, twoFists()))).toEqual(["grab", "twoFist"]);
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
