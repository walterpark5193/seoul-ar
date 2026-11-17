import { describe, it, expect } from "vitest";
import { initialStageState, reduceStage, defaultCandidates, parseVoteParam, winnerOf } from "./stageState";
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
  it("grab without hover ignored", () => {
    const s0 = hands();
    const s = run(s0, { type: "grab" });
    expect(s).toEqual(s0);
    expect(s.lifted).toBeNull();
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
