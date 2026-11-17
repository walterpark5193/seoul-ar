import { describe, it, expect } from "vitest";
import { initialStageState, reduceStage, defaultCandidates, parseVoteParam, winnerOf } from "./stageState";
import { diffEffects } from "./effects";
import type { StageEvent, StageState, VoteState } from "./types";
import { VOTE_TIMING } from "./types";
import type { Stat } from "../data/types";
import { GU_ORDER } from "../data/gu";

const C3: [string, string, string] = ["강남구", "마포구", "노원구"];

/** 입력 상태를 깊게 얼려서 리듀서가 제자리 변경을 하면 strict 모드에서 바로 터지게 한다. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

function run(s: StageState, ...events: StageEvent[]): StageState {
  let cur = s;
  for (const e of events) cur = reduceStage(deepFreeze(cur), e);
  return cur;
}

function vote(s: StageState): VoteState {
  if (!s.vote) throw new Error("vote is null");
  return s.vote;
}

const hands = () => initialStageState("202611", "hands");
const mouse = () => initialStageState("202611", "mouse");
const tick = (now: number, cameraCount: number | null = null): StageEvent => ({ type: "voteTick", now, cameraCount });
const set = (index: number, n: number, now: number): StageEvent => ({ type: "voteSet", index, n, now });
const start = (now = 0, candidates: [string, string, string] = C3): StageEvent => ({ type: "voteStart", candidates, now });

/** 카메라 방식으로 후보 하나를 끝까지 센다: prompt 끝 tick, counting 끝 tick. 다음 시각을 돌려준다. */
function countOne(s: StageState, t: number, n: number): [StageState, number] {
  const promptEnd = vote(s).endsAt!;
  expect(promptEnd).toBe(t + VOTE_TIMING.promptMs);
  let cur = run(s, tick(promptEnd));
  expect(vote(cur).phase).toBe("counting");
  const countEnd = vote(cur).endsAt!;
  expect(countEnd).toBe(promptEnd + VOTE_TIMING.countMs);
  cur = run(cur, tick(countEnd, n));
  return [cur, countEnd];
}

describe("initialStageState", () => {
  it("map mode, nothing selected, price, round 0", () => {
    expect(initialStageState("202611", "mouse")).toEqual({
      mode: "map", hover: null, lifted: null, focus: null, input: "mouse", vote: null, month: "202611", metric: "price", round: 0,
      rotate: "none", spinning: false,
    });
  });
});

describe("hand controls", () => {
  it("hover updates hover", () => {
    const s = run(hands(), { type: "hover", gu: "마포구" });
    expect(s.hover).toBe("마포구");
    expect(run(s, { type: "hover", gu: null }).hover).toBeNull();
  });
  it("grab lifts hover", () => {
    const s = run(hands(), { type: "hover", gu: "강남구" }, { type: "grab" });
    expect(s.lifted).toBe("강남구");
    expect(s.focus).toBeNull();
  });
  it("grab without hover lifts nothing", () => {
    // 13.4 이전에는 상태가 그대로였다. 지금은 빈 지도 주먹이 돌리기를 시작하지만(아래 rotation 절) 여전히 아무것도 들지 않는다.
    const s = run(hands(), { type: "grab" });
    expect(s.lifted).toBeNull();
    expect(s.focus).toBeNull();
  });
  it("release settles focus", () => {
    const s = run(hands(), { type: "spread" }, { type: "hover", gu: "강남구" }, { type: "grab" }, { type: "release" });
    expect(s.focus).toBe("강남구");
    expect(s.lifted).toBeNull();
    expect(s.mode).toBe("map");
  });
  it("release without lifted ignored", () => {
    const s0 = run(hands(), { type: "spread" });
    const s = run(s0, { type: "release" });
    expect(s).toEqual(s0);
    expect(s.mode).toBe("spread");
  });
  it("spread toggles", () => {
    const a = run(hands(), { type: "spread" });
    expect(a.mode).toBe("spread");
    expect(run(a, { type: "spread" }).mode).toBe("map");
  });
  it("spread ignored while lifted", () => {
    const s = run(hands(), { type: "hover", gu: "강남구" }, { type: "grab" }, { type: "spread" });
    expect(s.mode).toBe("map");
    expect(s.lifted).toBe("강남구");
  });
  it("victory clears", () => {
    const s = run(hands(), { type: "hover", gu: "강남구" }, { type: "grab" }, { type: "release" }, { type: "spread" },
      { type: "hover", gu: "마포구" }, { type: "grab" }, { type: "victory" });
    expect(s.focus).toBeNull();
    expect(s.lifted).toBeNull();
    expect(s.mode).toBe("map");
    expect(s.hover).toBe("마포구");
  });
});

describe("rotation hold (13.4)", () => {
  const grab: StageEvent = { type: "grab" };
  const release: StageEvent = { type: "release" };
  const spread: StageEvent = { type: "spread" };
  const victory: StageEvent = { type: "victory" };
  const twoFist: StageEvent = { type: "twoFist" };
  const twoFistEnd: StageEvent = { type: "twoFistEnd" };
  const spin = (spinning: boolean): StageEvent => ({ type: "spinState", spinning });
  const hover = (gu: string | null): StageEvent => ({ type: "hover", gu });

  /** stageView dispatch와 같은 한 단계: 리듀서가 같은 객체를 돌려주면(무시) 효과 없음, 아니면 이번 이벤트를 cause로 넘긴다. */
  function step(s: StageState, e: StageEvent): [StageState, string[]] {
    const next = reduceStage(deepFreeze(s), e);
    return [next, next === s ? [] : diffEffects(s, next, e).map((x) => x.type)];
  }

  it("grab without hover starts rotate only in map", () => {
    const [s, fx] = step(hands(), grab);
    expect(s.rotate).toBe("one");
    expect(s.lifted).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.mode).toBe("map");
    expect(fx).toEqual(["rotate.grabOne"]);
    // 마우스(빈 곳 누르기)도 같은 경로
    expect(run(mouse(), grab).rotate).toBe("one");
    // 결과 화면에서는 투표 표시를 지우고 돌리기 시작
    const result = run(hands(), start(0), tick(1500), tick(6500, 1), tick(8000), tick(13000, 2), tick(14500), tick(19500, 3), tick(22500));
    expect(vote(result).phase).toBe("result");
    const r = run(result, grab);
    expect(r.vote).toBeNull();
    expect(r.rotate).toBe("one");
  });

  it("grab in spread without hover ignored", () => {
    const s0 = run(hands(), spread);
    expect(run(s0, grab)).toBe(s0);
    expect(s0.rotate).toBe("none");
  });

  it("grab with hover still lifts", () => {
    const [s, fx] = step(run(hands(), hover("강남구")), grab);
    expect(s.lifted).toBe("강남구");
    expect(s.rotate).toBe("none");
    expect(fx).toEqual(["scene.lift", "narrate", "publish.stage"]);
    // 들고 있는 동안 grab은 무시(빈 곳이어도 돌리기 없음)
    expect(run(s, grab)).toBe(s);
    expect(run(s, hover(null), grab).rotate).toBe("none");
  });

  it("grab while spinning catches, no lift", () => {
    const s0 = run(hands(), spin(true), hover("강남구"));
    expect(s0.spinning).toBe(true);
    expect(s0.hover).toBe("강남구");
    const [s, fx] = step(s0, grab);
    expect(s.spinning).toBe(false);
    expect(s.rotate).toBe("one");
    expect(s.lifted).toBeNull();
    expect(s.hover).toBeNull(); // 잡는 동안 구 강조 없음
    expect(fx).toEqual(["rotate.catch", "rotate.grabOne", "scene.hover"]);
    // 빈 곳에서 잡아도 같은 순서
    expect(step(run(hands(), spin(true)), grab)[1]).toEqual(["rotate.catch", "rotate.grabOne"]);
    // 놓으면 그 구는 들리지 않는다(lift 경로 없음)
    const [after, fxAfter] = step(s, release);
    expect(after.lifted).toBeNull();
    expect(after.focus).toBeNull();
    expect(fxAfter).toEqual(["rotate.release"]);
  });

  it("release ends rotate with rotate.release", () => {
    const held = run(hands(), grab);
    const [s, fx] = step(held, release);
    expect(s.rotate).toBe("none");
    expect(s.lifted).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.mode).toBe("map");
    expect(fx).toEqual(["rotate.release"]);
    // 다시 놓아도 아무 일 없음
    expect(run(s, release)).toBe(s);
  });

  it("twoFist starts two-hand rotate in map", () => {
    const [s, fx] = step(hands(), twoFist);
    expect(s.rotate).toBe("two");
    expect(fx).toEqual(["rotate.grabTwo"]);
    // 한 손으로 돌리던 중이면 두 손으로 전환(놓기 없음)
    const [s2, fx2] = step(run(hands(), grab), twoFist);
    expect(s2.rotate).toBe("two");
    expect(fx2).toEqual(["rotate.grabTwo"]);
    // 관성 중이면 먼저 잡아 멈춘다, 구 강조는 끈다
    const [s3, fx3] = step(run(hands(), spin(true), hover("마포구")), twoFist);
    expect(s3.rotate).toBe("two");
    expect(s3.spinning).toBe(false);
    expect(s3.hover).toBeNull();
    expect(fx3).toEqual(["rotate.catch", "rotate.grabTwo", "scene.hover"]);
    // 두 손으로 잡은 동안 주 손의 grab·release는 두 손 회전을 깨지 않는다
    expect(run(s, grab)).toBe(s);
    expect(run(s, release)).toBe(s);
    expect(run(s, twoFist)).toBe(s);
  });

  // 13.8 이전에는 펼치기에서도 두 주먹을 무시했다. 지금은 펼치기의 두 주먹이 확대 전용 잡기다(아래 spread zoom 절).
  it("twoFist ignored while voting, or with a gu lifted in spread", () => {
    const prompt = run(hands(), start(0));
    const counting = run(prompt, tick(1500));
    const spreadMode = run(hands(), spread);
    const liftedInSpread = run(spreadMode, hover("강남구"), grab);
    expect(liftedInSpread.lifted).toBe("강남구");
    for (const s0 of [prompt, counting, liftedInSpread]) expect(run(s0, twoFist)).toBe(s0);
  });

  // Controller ruling(R2 결과): 주 손 주먹이 twoFist와 같은 프레임이나 몇 프레임 앞에 확정돼 구를 들 수 있다.
  // 두 주먹은 돌리기이므로 지도에서는 들던 구를 앉히지 않고 내려놓고(focus 그대로) 두 손 회전을 시작한다.
  it("same-frame grab+twoFist over a gu rotates, no lift, no focus", () => {
    // gestureMachine 출력 events ["grab", "twoFist"]를 stageView가 차례로 dispatch한다
    const [lifted] = step(run(hands(), hover("강남구")), grab);
    expect(lifted.lifted).toBe("강남구");
    const [s, fx] = step(lifted, twoFist);
    expect(s.rotate).toBe("two");
    expect(s.lifted).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.hover).toBeNull();
    expect(fx).toEqual(["rotate.grabTwo", "scene.lift", "scene.hover", "narrate.stop", "publish.stage"]); // final I-1: 든 구 해설도 멈춘다
    expect(diffEffects(lifted, s, twoFist)).toContainEqual({ type: "scene.lift", gu: null });
    // 나중에 주먹을 펴도 focus가 되지 않는다(주 손 release가 먼저 오든 twoFistEnd가 먼저 오든)
    const a = run(s, release, twoFistEnd);
    const b = run(s, twoFistEnd, release);
    for (const end of [a, b]) {
      expect(end.rotate).toBe("none");
      expect(end.lifted).toBeNull();
      expect(end.focus).toBeNull();
    }
  });

  it("grab (lift) then twoFist 3 frames later rotates, keeps the old focus", () => {
    // 이전에 앉혀 둔 구(중구)가 있으면 그대로 둔다
    const base0 = run(hands(), hover("중구"), grab, release);
    expect(base0.focus).toBe("중구");
    // 들고 있는 동안의 프레임마다 hover가 갱신된다
    const lifted = run(base0, hover("강남구"), grab, hover("강남구"), hover("서초구"), hover("서초구"));
    expect(lifted.lifted).toBe("강남구");
    const [s, fx] = step(lifted, twoFist);
    expect(s.rotate).toBe("two");
    expect(s.lifted).toBeNull();
    expect(s.focus).toBe("중구");
    expect(fx).toEqual(["rotate.grabTwo", "scene.lift", "scene.hover", "narrate.stop", "publish.stage"]); // final I-1: 든 구 해설도 멈춘다
    expect(fx).not.toContain("narrate");
    const end = run(s, release, twoFistEnd);
    expect(end.focus).toBe("중구");
    expect(end.lifted).toBeNull();
    expect(end.mode).toBe("map");
  });

  it("twoFistEnd releases", () => {
    const two = run(hands(), twoFist);
    const [s, fx] = step(two, twoFistEnd);
    expect(s.rotate).toBe("none");
    expect(fx).toEqual(["rotate.release"]);
    // 두 손으로 잡고 있지 않으면 무시
    const one = run(hands(), grab);
    for (const s0 of [hands(), one, s]) expect(run(s0, twoFistEnd)).toBe(s0);
  });

  it("spinState sets spinning", () => {
    const [s, fx] = step(hands(), spin(true));
    expect(s.spinning).toBe(true);
    expect(fx).toEqual([]);
    expect(run(s, spin(true))).toBe(s);
    const [s2, fx2] = step(s, spin(false));
    expect(s2.spinning).toBe(false);
    expect(fx2).toEqual([]);
    // 관성은 놓인 지도에서만: 잡고 있거나 펼치기·투표 중이면 도는 상태가 되지 않는다
    for (const s0 of [run(hands(), grab), run(hands(), twoFist), run(hands(), spread), run(hands(), start(0))]) {
      expect(run(s0, spin(true))).toBe(s0);
    }
  });

  it("spread/victory/voteStart emit rotate.reset", () => {
    // 펼치기 진입: 한 손으로 돌리던 중(마우스 누른 채 스페이스)
    const [sp, fxSp] = step(run(mouse(), grab), spread);
    expect(sp.mode).toBe("spread");
    expect(sp.rotate).toBe("none");
    expect(fxSp).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
    // 펼치기 진입: 관성 중
    const [sp2, fxSp2] = step(run(hands(), spin(true)), spread);
    expect(sp2.spinning).toBe(false);
    expect(fxSp2).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
    // 펼치기에서 지도로: 13.8부터 펼침 확대를 풀도록 나갈 때도 리셋(아래 spread zoom 절)
    expect(step(sp, spread)[1]).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);

    // 브이: 돌려 놓은 뒤 놓인 깨끗한 지도(상태는 그대로)여도 정면 복귀
    expect(step(hands(), victory)[1]).toEqual(["rotate.reset"]);
    // 브이: 펼치기에서, 관성 중에, 돌리는 중에
    expect(step(run(hands(), spread), victory)[1]).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
    const [v2, fxV2] = step(run(hands(), spin(true)), victory);
    expect(v2.spinning).toBe(false);
    expect(fxV2).toEqual(["rotate.reset"]);
    const [v3, fxV3] = step(run(mouse(), grab), victory);
    expect(v3.rotate).toBe("none");
    expect(fxV3).toEqual(["rotate.reset"]); // 놓기(관성)가 아니라 리셋

    // 투표 시작: 관성 중, 돌리는 중
    const [vs, fxVs] = step(run(hands(), spin(true)), start(0));
    expect(vs.spinning).toBe(false);
    expect(fxVs).toEqual(["rotate.reset", "narrate", "narrate"]);
    const [vs2, fxVs2] = step(run(hands(), twoFist), start(0));
    expect(vs2.rotate).toBe("none");
    expect(fxVs2[0]).toBe("rotate.reset");
    expect(fxVs2).not.toContain("rotate.release");

    // 무시된 이벤트는 리셋을 내지 않는다(투표 중 브이·펼치기)
    const voting = run(hands(), start(0));
    expect(step(voting, victory)).toEqual([voting, []]);
    expect(step(voting, spread)).toEqual([voting, []]);
  });

  it("hover ignored while rotating", () => {
    for (const held of [run(hands(), grab), run(hands(), twoFist)]) {
      expect(held.hover).toBeNull();
      expect(run(held, hover("마포구"))).toBe(held);
    }
    // 놓으면 다시 강조
    expect(run(hands(), grab, release, hover("마포구")).hover).toBe("마포구");
    expect(run(hands(), twoFist, twoFistEnd, hover("마포구")).hover).toBe("마포구");
  });

  it("setInput resets rotate", () => {
    const [s, fx] = step(run(mouse(), grab), { type: "setInput", input: "hands", now: 0 });
    expect(s.input).toBe("hands");
    expect(s.rotate).toBe("none");
    expect(fx).toEqual(["rotate.reset"]);
    // 전환 뒤 늦게 온 마우스 놓기는 아무 일 없음
    expect(run(s, release)).toBe(s);
    const [s2, fx2] = step(run(hands(), spin(true)), { type: "setInput", input: "mouse", now: 0 });
    expect(s2.spinning).toBe(false);
    expect(fx2).toEqual(["rotate.reset"]);
    const [s3] = step(run(hands(), twoFist), { type: "setInput", input: "mouse", now: 0 });
    expect(s3.rotate).toBe("none");
    // 같은 입력이면 무시
    const h = hands();
    expect(run(h, { type: "setInput", input: "hands", now: 0 })).toBe(h);
  });

  describe("spread zoom (13.8)", () => {
    it("twoFist in spread starts a zoom-only two-hand hold", () => {
      const sp = run(hands(), hover("강남구"), spread);
      expect(sp.mode).toBe("spread");
      expect(sp.hover).toBe("강남구");
      const [s, fx] = step(sp, twoFist);
      expect(s.mode).toBe("spread"); // 펼친 그대로(회전은 stageView가 잠근다)
      expect(s.rotate).toBe("two");
      expect(s.lifted).toBeNull();
      expect(s.focus).toBeNull();
      expect(s.hover).toBeNull(); // 잡는 동안 구 강조 없음
      expect(fx).toEqual(["rotate.grabTwo", "scene.hover"]);
      // 잡은 동안: 다시 두 주먹·주 손 grab·release·hover는 무시
      for (const e of [twoFist, grab, release, hover("마포구")]) expect(run(s, e)).toBe(s);
      // 놓으면 rotate.release, 펼친 그대로
      const [end, fxEnd] = step(s, twoFistEnd);
      expect(end.rotate).toBe("none");
      expect(end.mode).toBe("spread");
      expect(fxEnd).toEqual(["rotate.release"]);
      // 관성은 펼치기에서 생기지 않는다(놓은 뒤 늦게 온 "돈다"도 무시)
      expect(run(end, spin(true))).toBe(end);
      // 놓은 뒤에는 다시 구 강조
      expect(run(end, hover("마포구")).hover).toBe("마포구");
    });

    it("twoFist in spread ignored while lifted or voting", () => {
      const sp = run(hands(), spread);
      // 같은 프레임 grab+twoFist(구 위): 펼치기에서는 든 구를 그대로 두고 확대하지 않는다
      const lifted = run(sp, hover("강남구"), grab);
      expect(lifted.lifted).toBe("강남구");
      expect(step(lifted, twoFist)).toEqual([lifted, []]);
      // 펼친 채 투표 진행 중(안내·세기·확인)
      const prompt = run(sp, start(0));
      expect(prompt.mode).toBe("spread");
      const counting = run(prompt, tick(1500));
      for (const s0 of [prompt, counting]) expect(step(s0, twoFist)).toEqual([s0, []]);
    });

    it("one-hand empty-space grab in spread is still ignored, also after a zoom hold", () => {
      const sp = run(hands(), spread);
      expect(step(sp, grab)).toEqual([sp, []]);
      const after = run(sp, twoFist, twoFistEnd);
      expect(after.rotate).toBe("none");
      expect(step(after, grab)).toEqual([after, []]);
      expect(run(mouse(), spread, grab).rotate).toBe("none"); // 마우스 빈 곳 누르기도
    });

    it("spread→map emits rotate.reset like entering does", () => {
      // 확대 잡은 채 펼치기를 끄면: 잡기를 풀고(놓기·관성 아님) 리셋, 순서는 scene.layout 앞
      const held = run(hands(), spread, twoFist);
      const [m, fx] = step(held, spread);
      expect(m.mode).toBe("map");
      expect(m.rotate).toBe("none");
      expect(m.spinning).toBe(false);
      expect(fx).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
      expect(fx).not.toContain("rotate.release");
      // 놓은 뒤(확대만 남음) 펼치기 끄기
      expect(step(run(hands(), spread, twoFist, twoFistEnd), spread)[1]).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
      // 펼치기에서 구를 들었다 놓아 지도로(앉히기)
      const [settled, fxSettle] = step(run(hands(), spread, hover("강남구"), grab), release);
      expect(settled.mode).toBe("map");
      expect(settled.focus).toBe("강남구");
      expect(fxSettle[0]).toBe("rotate.reset");
      expect(fxSettle).toContain("scene.layout");
      // 펼치기에서 브이
      const [v, fxV] = step(run(hands(), spread, twoFist), victory);
      expect(v.rotate).toBe("none");
      expect(fxV).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
      // 지도 안의 변화는 여전히 리셋 없음(놓기는 release)
      expect(step(run(hands(), twoFist), twoFistEnd)[1]).toEqual(["rotate.release"]);
    });

    it("voteStart / setInput during a spread zoom hold reset it", () => {
      const held = run(hands(), spread, twoFist);
      const [vs, fxVs] = step(held, start(0));
      expect(vs.rotate).toBe("none");
      expect(vs.mode).toBe("spread");
      expect(fxVs[0]).toBe("rotate.reset");
      expect(fxVs).not.toContain("rotate.release");
      const [si, fxSi] = step(held, { type: "setInput", input: "mouse", now: 0 });
      expect(si.rotate).toBe("none");
      expect(fxSi).toEqual(["rotate.reset"]);
    });
  });
});

describe("vote prompt timing follows the narration (F1)", () => {
  const timed = (now = 0): StageEvent => ({ type: "voteStart", candidates: C3, now, promptMs: [3000, 2800, 3200], introMs: 4000 });

  it("first prompt waits for the intro clip plus its own prompt", () => {
    const s = run(hands(), timed(0));
    expect(vote(s).endsAt).toBe(7000);
    expect(vote(run(s, tick(6999))).phase).toBe("prompt");
    expect(vote(run(s, tick(7000))).phase).toBe("counting");
  });

  it("later prompts use their own clip length, without the intro (camera)", () => {
    let s = run(hands(), timed(0), tick(7000));
    expect(vote(s).endsAt).toBe(12_000);
    s = run(s, tick(12_000, 2));
    expect(vote(s).index).toBe(1);
    expect(vote(s).endsAt).toBe(14_800);
    s = run(s, tick(14_800));
    expect(vote(s).endsAt).toBe(19_800);
    s = run(s, tick(19_800, 1));
    expect(vote(s).index).toBe(2);
    expect(vote(s).endsAt).toBe(23_000);
  });

  it("manual: picking during the prompt does not shorten it, and the next prompt gets its own length", () => {
    let s = run(mouse(), timed(0), set(0, 2, 100));
    expect(vote(s).endsAt).toBe(7000);
    s = run(s, tick(7000));
    expect(vote(s).endsAt).toBe(7000 + VOTE_TIMING.manualAdvanceMs);
    s = run(s, tick(8000));
    expect(vote(s).index).toBe(1);
    expect(vote(s).endsAt).toBe(10_800);
  });

  it("invalid or short values fall back to the minimum, missing intro adds nothing", () => {
    const bad = run(hands(), { type: "voteStart", candidates: C3, now: 0, promptMs: [100, Number.NaN, -5], introMs: Number.NaN });
    expect(vote(bad).endsAt).toBe(VOTE_TIMING.promptMs);
    let s = run(bad, tick(1500), tick(6500, 1));
    expect(vote(s).endsAt).toBe(6500 + VOTE_TIMING.promptMs);
    s = run(s, tick(8000), tick(13_000, 1));
    expect(vote(s).endsAt).toBe(13_000 + VOTE_TIMING.promptMs);
    const noIntro = run(hands(), { type: "voteStart", candidates: C3, now: 0, promptMs: [2000, 2000, 2000] });
    expect(vote(noIntro).endsAt).toBe(2000);
    const negIntro = run(hands(), { type: "voteStart", candidates: C3, now: 0, introMs: -100 });
    expect(vote(negIntro).endsAt).toBe(VOTE_TIMING.promptMs);
  });

  it("the caller's array is copied, not kept", () => {
    const promptMs: [number, number, number] = [3000, 3000, 3000];
    const s = run(hands(), { type: "voteStart", candidates: C3, now: 0, promptMs });
    promptMs[1] = 9000;
    const next = run(s, tick(3000), tick(8000, 1));
    expect(vote(next).endsAt).toBe(11_000);
  });
});

describe("vote flow (camera)", () => {
  it("prompt → counting → next candidate × 3 → review → result → cleared", () => {
    let s = run(hands(), { type: "hover", gu: "송파구" }, { type: "grab" }, start(0));
    expect(s.round).toBe(1);
    expect(s.lifted).toBeNull();
    expect(vote(s)).toEqual({
      round: 1, candidates: C3, index: 0, phase: "prompt", method: "camera",
      counts: [null, null, null], sources: [null, null, null], reviewEdited: false, winner: null, allZero: false, endsAt: 1500,
    });
    // prompt가 끝나기 전 tick은 아무 일 없음
    expect(vote(run(s, tick(1499))).phase).toBe("prompt");

    s = run(s, tick(1500));
    expect(vote(s).phase).toBe("counting");
    expect(vote(s).endsAt).toBe(6500);
    expect(vote(run(s, tick(6499, 4))).phase).toBe("counting");

    s = run(s, tick(6500, 2));
    expect(vote(s).counts).toEqual([2, null, null]);
    expect(vote(s).sources).toEqual(["camera", null, null]);
    expect(vote(s).index).toBe(1);
    expect(vote(s).phase).toBe("prompt");

    let t: number;
    [s, t] = countOne(s, 6500, 5);
    expect(vote(s).index).toBe(2);
    expect(vote(s).phase).toBe("prompt");
    [s, t] = countOne(s, t, 1);
    expect(vote(s).counts).toEqual([2, 5, 1]);
    expect(vote(s).sources).toEqual(["camera", "camera", "camera"]);
    expect(vote(s).phase).toBe("review");
    expect(vote(s).reviewEdited).toBe(false);
    expect(vote(s).endsAt).toBe(t + 3000);
    expect(vote(run(s, tick(t + 2999))).phase).toBe("review");

    s = run(s, { type: "hover", gu: "강남구" }, tick(t + 3000));
    expect(vote(s).phase).toBe("result");
    expect(vote(s).winner).toBe("마포구");
    expect(vote(s).allZero).toBe(false);
    expect(vote(s).endsAt).toBe(t + 3000 + 6000);
    expect(s.focus).toBe("마포구");
    expect(s.lifted).toBeNull();
    expect(s.mode).toBe("map");

    s = run(s, tick(t + 9000));
    expect(s.vote).toBeNull();
    expect(s.focus).toBe("마포구");
    expect(s.round).toBe(1);
  });

  it("vote round increments every start", () => {
    let s = run(hands(), start(0), { type: "voteCancel" }, start(100));
    expect(s.round).toBe(2);
    expect(vote(s).round).toBe(2);
    expect(vote(s).endsAt).toBe(1600);
    s = run(s, { type: "voteCancel" });
    expect(s.vote).toBeNull();
    expect(s.round).toBe(2);
  });

  it("voteStart ignored while a vote is running", () => {
    const s0 = run(hands(), start(0), tick(1500));
    const s = run(s0, start(2000, ["종로구", "중구", "용산구"]));
    expect(s).toEqual(s0);
  });

  it("voteStart allowed from result phase", () => {
    let s = run(hands(), start(0));
    s = run(s, tick(1500), tick(6500, 1), tick(8000), tick(13000, 1), tick(14500), tick(19500, 1));
    expect(vote(s).phase).toBe("review");
    s = run(s, { type: "voteConfirm", now: 20000 });
    expect(vote(s).phase).toBe("result");
    s = run(s, start(21000, ["종로구", "중구", "용산구"]));
    expect(s.round).toBe(2);
    expect(vote(s).phase).toBe("prompt");
    expect(vote(s).candidates).toEqual(["종로구", "중구", "용산구"]);
  });

  it("camera null awaits manual", () => {
    let s = run(hands(), start(0), tick(1500), tick(6500, null));
    expect(vote(s).phase).toBe("awaitManual");
    expect(vote(s).endsAt).toBeNull();
    expect(vote(s).counts).toEqual([null, null, null]);
    // 타이머가 멈춰 있다
    expect(run(s, tick(60000, 3))).toEqual(s);

    s = run(s, set(0, 1, 7000));
    expect(vote(s).counts[0]).toBe(1);
    expect(vote(s).sources[0]).toBe("manual");
    expect(vote(s).phase).toBe("awaitManual");
    expect(vote(s).endsAt).toBe(8000);
    expect(vote(run(s, tick(7999))).phase).toBe("awaitManual");

    s = run(s, tick(8000));
    expect(vote(s).index).toBe(1);
    expect(vote(s).phase).toBe("prompt");
    expect(vote(s).endsAt).toBe(9500);
  });

  it("manual method has no timer", () => {
    let s = run(mouse(), start(0));
    expect(vote(s).method).toBe("manual");
    s = run(s, tick(1500));
    expect(vote(s).phase).toBe("counting");
    expect(vote(s).endsAt).toBeNull();
    expect(run(s, tick(11500, 4))).toEqual(s);

    s = run(s, set(0, 4, 11500));
    expect(vote(s).counts[0]).toBe(4);
    expect(vote(s).sources[0]).toBe("manual");
    expect(vote(s).endsAt).toBe(12500);
    expect(vote(run(s, tick(12499))).index).toBe(0);
    s = run(s, tick(12500));
    expect(vote(s).index).toBe(1);
    expect(vote(s).phase).toBe("prompt");
    expect(vote(s).endsAt).toBe(14000);
  });

  it("manual pick during prompt is kept and advances 1s after counting starts", () => {
    let s = run(mouse(), start(0), set(0, 2, 500));
    expect(vote(s).phase).toBe("prompt");
    expect(vote(s).endsAt).toBe(1500); // 안내 시간은 그대로
    expect(vote(s).counts[0]).toBe(2);
    s = run(s, tick(1500));
    expect(vote(s).phase).toBe("counting");
    expect(vote(s).endsAt).toBe(2500);
    s = run(s, tick(2500));
    expect(vote(s).index).toBe(1);
    expect(vote(s).counts[0]).toBe(2);
  });

  it("manual beats camera", () => {
    let s = run(hands(), start(0), tick(1500), set(0, 3, 3000));
    expect(vote(s).counts[0]).toBe(3);
    expect(vote(s).sources[0]).toBe("manual");
    expect(vote(s).endsAt).toBe(6500); // 카메라 창은 그대로 진행
    s = run(s, tick(6500, 1));
    expect(vote(s).counts[0]).toBe(3);
    expect(vote(s).sources[0]).toBe("manual");
    expect(vote(s).index).toBe(1);
  });

  it("manual pick also beats a later camera null", () => {
    const s = run(hands(), start(0), tick(1500), set(0, 0, 3000), tick(6500, null));
    expect(vote(s).phase).toBe("prompt");
    expect(vote(s).index).toBe(1);
    expect(vote(s).counts[0]).toBe(0);
  });

  it("review edit pauses auto confirm", () => {
    let s = run(hands(), start(0), tick(1500), tick(6500, 1), tick(8000), tick(13000, 2), tick(14500), tick(19500, 3));
    expect(vote(s).phase).toBe("review");
    s = run(s, set(2, 0, 20000));
    expect(vote(s).reviewEdited).toBe(true);
    expect(vote(s).endsAt).toBeNull();
    expect(vote(s).counts).toEqual([1, 2, 0]);
    expect(vote(s).sources).toEqual(["camera", "camera", "manual"]);
    expect(run(s, tick(22500), tick(1e9))).toEqual(s);

    // review에서는 지난 줄도 고칠 수 있다
    s = run(s, set(0, 6, 30000));
    expect(vote(s).counts).toEqual([6, 2, 0]);
    expect(vote(s).phase).toBe("review");

    s = run(s, { type: "voteConfirm", now: 40000 });
    expect(vote(s).phase).toBe("result");
    expect(vote(s).winner).toBe("강남구");
    expect(vote(s).endsAt).toBe(46000);
    expect(s.focus).toBe("강남구");
  });

  it("voteConfirm only in review", () => {
    const s0 = run(hands(), start(0), tick(1500));
    expect(run(s0, { type: "voteConfirm", now: 2000 })).toEqual(s0);
    const s1 = run(hands(), { type: "voteConfirm", now: 0 });
    expect(s1.vote).toBeNull();
  });

  it("voteSet rejects out of range", () => {
    const s0 = run(hands(), start(0), tick(1500));
    for (const n of [7, -1, 1.5, Number.NaN]) expect(run(s0, set(0, n, 2000))).toEqual(s0);
    for (const index of [-1, 3, 0.5]) expect(run(s0, set(index, 1, 2000))).toEqual(s0);
    // 아직 안 온 후보(review 전) 무시
    expect(run(s0, set(1, 2, 2000))).toEqual(s0);
    expect(run(s0, set(2, 2, 2000))).toEqual(s0);
    // 경계값은 받는다
    expect(vote(run(s0, set(0, 0, 2000))).counts[0]).toBe(0);
    expect(vote(run(s0, set(0, 6, 2000))).counts[0]).toBe(6);
  });

  it("voteSet on a past candidate keeps the current one's timer", () => {
    let s = run(hands(), start(0), tick(1500), tick(6500, 2), tick(8000));
    expect(vote(s).index).toBe(1);
    expect(vote(s).endsAt).toBe(13000);
    s = run(s, set(0, 5, 9000));
    expect(vote(s).counts[0]).toBe(5);
    expect(vote(s).sources[0]).toBe("manual");
    expect(vote(s).endsAt).toBe(13000);
    expect(vote(s).index).toBe(1);
  });

  it("voteSet ignored after result and without vote", () => {
    const s0 = run(hands(), start(0), tick(1500), tick(6500, 1), tick(8000), tick(13000, 2), tick(14500), tick(19500, 3), tick(22500));
    expect(vote(s0).phase).toBe("result");
    expect(run(s0, set(0, 6, 23000))).toEqual(s0);
    expect(run(hands(), set(0, 1, 0)).vote).toBeNull();
  });

  it("tie goes to first", () => {
    const s = run(hands(), start(0), tick(1500), tick(6500, 2), tick(8000), tick(13000, 3), tick(14500), tick(19500, 3), tick(22500));
    expect(vote(s).winner).toBe("마포구");
    expect(vote(s).allZero).toBe(false);
  });

  it("all zero winner first and allZero", () => {
    const s = run(hands(), start(0), tick(1500), tick(6500, 0), tick(8000), tick(13000, 0), tick(14500), tick(19500, 0), tick(22500));
    expect(vote(s).winner).toBe("강남구");
    expect(vote(s).allZero).toBe(true);
    expect(s.focus).toBe("강남구");
  });

  it("winnerOf treats null as 0", () => {
    const base = vote(run(hands(), start(0)));
    expect(winnerOf({ ...base, counts: [null, null, null] })).toEqual({ winner: "강남구", allZero: true });
    expect(winnerOf({ ...base, counts: [null, 1, null] })).toEqual({ winner: "마포구", allZero: false });
    expect(winnerOf({ ...base, counts: [4, 4, 6] })).toEqual({ winner: "노원구", allZero: false });
  });

  it("gestures ignored during vote", () => {
    const s0 = run(hands(), { type: "hover", gu: "마포구" }, start(0));
    for (const e of [{ type: "grab" }, { type: "release" }, { type: "spread" }, { type: "victory" }] as StageEvent[]) {
      expect(run(s0, e)).toEqual(s0);
    }
    const counting = run(s0, tick(1500));
    expect(run(counting, { type: "spread" })).toEqual(counting);
    // hover는 투표 중에도 갱신
    expect(run(counting, { type: "hover", gu: "노원구" }).hover).toBe("노원구");
  });

  it("result phase gesture clears vote", () => {
    const result = run(hands(), start(0), tick(1500), tick(6500, 1), tick(8000), tick(13000, 2), tick(14500), tick(19500, 3), tick(22500));
    expect(vote(result).phase).toBe("result");
    expect(result.focus).toBe("노원구");

    const sp = run(result, { type: "spread" });
    expect(sp.vote).toBeNull();
    expect(sp.mode).toBe("spread");

    const v = run(result, { type: "victory" });
    expect(v.vote).toBeNull();
    expect(v.focus).toBeNull();

    const g = run(result, { type: "hover", gu: "중구" }, { type: "grab" });
    expect(g.vote).toBeNull();
    expect(g.lifted).toBe("중구");
  });

  it("setInput mouse switches method", () => {
    let s = run(hands(), { type: "hover", gu: "중구" }, { type: "grab" }, { type: "release" }, { type: "hover", gu: "강남구" }, { type: "grab" });
    expect(s.lifted).toBe("강남구");
    s = run(s, { type: "setInput", input: "mouse", now: 0 });
    expect(s.input).toBe("mouse");
    expect(s.lifted).toBeNull();
    expect(s.focus).toBe("중구");

    let v = run(hands(), start(0), tick(1500));
    expect(vote(v).endsAt).toBe(6500);
    v = run(v, { type: "setInput", input: "mouse", now: 3000 });
    expect(v.input).toBe("mouse");
    expect(vote(v).method).toBe("manual");
    expect(vote(v).phase).toBe("counting");
    expect(vote(v).endsAt).toBeNull();
    expect(run(v, tick(1e9, 2))).toEqual(v);

    // prompt 중에 바뀌면 안내 시간은 그대로, counting은 타이머 없음
    let p = run(hands(), start(0), { type: "setInput", input: "mouse", now: 500 });
    expect(vote(p).method).toBe("manual");
    expect(vote(p).endsAt).toBe(1500);
    p = run(p, tick(1500));
    expect(vote(p).endsAt).toBeNull();

    // 손 모드로 돌아와도 방식은 그대로
    expect(vote(run(v, { type: "setInput", input: "hands", now: 4000 })).method).toBe("manual");
  });

  it("voteMethod camera restarts window", () => {
    let s = run(mouse(), start(0), tick(1500));
    expect(vote(s).endsAt).toBeNull();
    s = run(s, { type: "voteMethod", method: "camera", now: 4000 });
    expect(vote(s).method).toBe("camera");
    expect(vote(s).endsAt).toBe(9000);
    s = run(s, tick(9000, 2));
    expect(vote(s).counts[0]).toBe(2);
    expect(vote(s).sources[0]).toBe("camera");

    // camera → manual in counting: 타이머 멈춤
    let c = run(hands(), start(0), tick(1500), { type: "voteMethod", method: "manual", now: 2000 });
    expect(vote(c).method).toBe("manual");
    expect(vote(c).endsAt).toBeNull();
    // 같은 방식으로 다시 보내면 창을 새로 시작하지 않는다
    c = run(hands(), start(0), tick(1500), { type: "voteMethod", method: "camera", now: 4000 });
    expect(vote(c).endsAt).toBe(6500);
  });

  it("voteMethod outside counting only changes method", () => {
    const p = run(hands(), start(0), { type: "voteMethod", method: "manual", now: 100 });
    expect(vote(p).method).toBe("manual");
    expect(vote(p).endsAt).toBe(1500);
    const a = run(hands(), start(0), tick(1500), tick(6500, null), { type: "voteMethod", method: "manual", now: 7000 });
    expect(vote(a).phase).toBe("awaitManual");
    expect(vote(a).endsAt).toBeNull();
  });

  it("vote events without a vote are no-ops", () => {
    const s0 = hands();
    for (const e of [tick(5000, 2), { type: "voteMethod", method: "manual", now: 0 }, { type: "voteCancel" }] as StageEvent[]) {
      expect(run(s0, e)).toEqual(s0);
    }
  });
});

describe("month and metric", () => {
  it("updates month and metric", () => {
    const s = run(hands(), { type: "month", month: "202610" }, { type: "metric", metric: "count" });
    expect(s.month).toBe("202610");
    expect(s.metric).toBe("count");
  });
});

function stat(medPerM2: number | null, n = 10): Stat {
  return { n, cancelled: 0, medPerM2, medAmt: null, maxAmt: null, truncated: false };
}

describe("defaultCandidates", () => {
  it("defaultCandidates picks 1st 13th 25th", () => {
    // GU_ORDER 뒤로 갈수록 비싸게: 1위 강동구(마지막), 13위 서대문구, 25위 종로구
    const summary: Record<string, Stat> = {};
    GU_ORDER.forEach((g, i) => (summary[g] = stat(1000 + i * 10, 100 - i)));
    expect(defaultCandidates(summary, "price", GU_ORDER)).toEqual([GU_ORDER[24], GU_ORDER[12], GU_ORDER[0]]);
    // 건수는 반대 순서
    expect(defaultCandidates(summary, "count", GU_ORDER)).toEqual([GU_ORDER[0], GU_ORDER[12], GU_ORDER[24]]);
  });

  it("defaultCandidates skips null", () => {
    const summary: Record<string, Stat> = {};
    GU_ORDER.forEach((g, i) => (summary[g] = stat(5000 - i * 10)));
    summary["종로구"] = stat(null);
    summary["강남구"] = stat(null);
    // 남은 23개: GU_ORDER에서 종로구·강남구를 뺀 순서 그대로 내림차순
    const rest = GU_ORDER.filter((g) => g !== "종로구" && g !== "강남구");
    expect(rest).toHaveLength(23);
    expect(defaultCandidates(summary, "price", GU_ORDER)).toEqual([rest[0], rest[11], rest[22]]);
  });

  it("missing summary entries are skipped", () => {
    const summary: Record<string, Stat> = {};
    GU_ORDER.slice(0, 5).forEach((g, i) => (summary[g] = stat(100 - i)));
    // 5개: 첫째, floor(4/2)=2, 마지막
    expect(defaultCandidates(summary, "price", GU_ORDER)).toEqual([GU_ORDER[0], GU_ORDER[2], GU_ORDER[4]]);
  });

  it("ties follow GU_ORDER", () => {
    const summary: Record<string, Stat> = {};
    for (const g of GU_ORDER) summary[g] = stat(700);
    summary["노원구"] = stat(900);
    // gus를 거꾸로 넘겨도 동률은 GU_ORDER 순: 노원구, 종로구, 중구, … (13위 = 서대문구), 마지막 강동구
    const reversed = [...GU_ORDER].reverse();
    expect(defaultCandidates(summary, "price", reversed)).toEqual(["노원구", "서대문구", "강동구"]);
  });

  it("fewer than 3 valid gus still yields 3 distinct names", () => {
    const summary: Record<string, Stat> = { 마포구: stat(900), 노원구: stat(500) };
    const c = defaultCandidates(summary, "price", GU_ORDER);
    expect(c.slice(0, 2)).toEqual(["마포구", "노원구"]);
    expect(new Set(c).size).toBe(3);
    const empty = defaultCandidates({}, "price", GU_ORDER);
    expect(empty).toEqual([GU_ORDER[0], GU_ORDER[1], GU_ORDER[2]]);
  });
});

describe("parseVoteParam", () => {
  it("valid names only, deduped, in order", () => {
    expect(parseVoteParam("#/stage?vote=강남구,마포구,노원구", GU_ORDER)).toEqual(["강남구", "마포구", "노원구"]);
    expect(parseVoteParam("#/stage?vote=강남구,없는구,강남구, 마포구 ", GU_ORDER)).toEqual(["강남구", "마포구"]);
    expect(parseVoteParam("#/stage?x=1&vote=노원구", GU_ORDER)).toEqual(["노원구"]);
  });
  it("decodes percent-encoded names", () => {
    const hash = "#/stage?vote=" + ["강남구", "마포구"].map(encodeURIComponent).join("%2C");
    expect(parseVoteParam(hash, GU_ORDER)).toEqual(["강남구", "마포구"]);
  });
  it("null when nothing usable", () => {
    expect(parseVoteParam("#/stage", GU_ORDER)).toBeNull();
    expect(parseVoteParam("", GU_ORDER)).toBeNull();
    expect(parseVoteParam("#/stage?vote=", GU_ORDER)).toBeNull();
    expect(parseVoteParam("#/stage?vote=뉴욕,파리", GU_ORDER)).toBeNull();
    expect(parseVoteParam("#/stage?other=강남구", GU_ORDER)).toBeNull();
  });
  it("only names in gus count", () => {
    expect(parseVoteParam("#/stage?vote=강남구,마포구", ["마포구"])).toEqual(["마포구"]);
  });
});
