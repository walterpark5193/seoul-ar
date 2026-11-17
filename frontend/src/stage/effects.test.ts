import { describe, expect, it } from "vitest";
import { diffEffects, NARRATION_IDS } from "./effects";
import type { StageEvent, StageState, VoteState } from "./types";

const base: StageState = {
  mode: "map", hover: null, lifted: null, focus: null, input: "mouse", vote: null, month: "202611", metric: "price", round: 0,
  rotate: "none", spinning: false,
};
const vote = (o: Partial<VoteState> = {}): VoteState => ({
  round: 1, candidates: ["강남구", "마포구", "노원구"], index: 0, phase: "prompt", method: "camera",
  counts: [null, null, null], sources: [null, null, null], reviewEdited: false, winner: null, allZero: false, endsAt: null, ...o,
});
const types = (e: { type: string }[]) => e.map((x) => x.type);
const s = (o: Partial<StageState>): StageState => ({ ...base, ...o });

describe("diffEffects", () => {
  it("lift emits scene.lift publish.stage narrate gu", () => {
    const e = diffEffects(base, s({ lifted: "강남구" }));
    expect(e).toEqual([
      { type: "scene.lift", gu: "강남구" },
      { type: "narrate", id: "gu-202611-강남구", interrupt: true, protect: false },
      { type: "publish.stage" },
    ]);
  });
  it("release emits lift null focus publish.state (no map-back)", () => {
    const e = diffEffects(s({ mode: "spread", lifted: "강남구" }), s({ mode: "map", lifted: null, focus: "강남구" }));
    expect(types(e)).toEqual(["scene.layout", "scene.lift", "scene.focus", "publish.state", "publish.stage"]);
    expect(e.some((x) => x.type === "narrate")).toBe(false);
    const e2 = diffEffects(s({ lifted: "강남구" }), s({ lifted: null, focus: "강남구" }));
    expect(types(e2)).toEqual(["scene.lift", "scene.focus", "publish.state", "publish.stage"]);
  });
  it("spread emits layout spread-intro publish.stage", () => {
    expect(diffEffects(base, s({ mode: "spread" }))).toEqual([
      { type: "rotate.reset" }, // 13.4: 펼치기 진입은 정면·1배로
      { type: "scene.layout", mode: "spread" },
      { type: "narrate", id: "spread-intro", interrupt: true, protect: false },
      { type: "publish.stage" },
    ]);
  });
  it("victory from spread emits map-back", () => {
    const e = diffEffects(s({ mode: "spread" }), base);
    expect(e).toContainEqual({ type: "narrate", id: "map-back", interrupt: true, protect: false });
  });
  it("hover only scene.hover", () => {
    expect(diffEffects(base, s({ hover: "마포구" }))).toEqual([{ type: "scene.hover", gu: "마포구" }]);
  });
  it("month change emits scene.data publish.state", () => {
    expect(types(diffEffects(base, s({ month: "202610" })))).toEqual(["scene.data", "publish.state"]);
    expect(types(diffEffects(base, s({ metric: "count" })))).toEqual(["scene.data", "publish.state"]);
  });
  it("vote round start narrates vote-intro protect", () => {
    const e = diffEffects(base, s({ vote: vote() }));
    expect(e[0]).toEqual({ type: "rotate.reset" }); // 13.4: 투표 시작은 정면·1배로
    expect(e[1]).toEqual({ type: "narrate", id: "vote-intro", interrupt: true, protect: true });
  });
  it("prompt entry narrates vote-prompt-{gu} protect not interrupt", () => {
    const e = diffEffects(s({ vote: vote({ phase: "review", index: 0 }) }), s({ vote: vote({ phase: "prompt", index: 1 }) }));
    expect(e).toEqual([{ type: "narrate", id: "vote-prompt-마포구", interrupt: false, protect: true }]);
    const e2 = diffEffects(s({ vote: vote({ phase: "prompt", index: 0 }) }), s({ vote: vote({ phase: "prompt", index: 0 }) }));
    expect(e2).toEqual([]);
  });
  it("voteCancel stops the vote narration (queued and protected prompts)", () => {
    for (const phase of ["prompt", "counting", "awaitManual", "review"] as const) {
      expect(diffEffects(s({ vote: vote({ phase }) }), s({ vote: null }))).toEqual([{ type: "narrate.stop" }]);
    }
  });
  it("the vote clearing after the result does not stop the result narration", () => {
    expect(diffEffects(s({ vote: vote({ phase: "result", winner: "강남구" }) }), s({ vote: null }))).toEqual([]);
  });
  it("counting entry resets counter", () => {
    expect(diffEffects(s({ vote: vote() }), s({ vote: vote({ phase: "counting" }) }))).toEqual([{ type: "counter.reset" }]);
  });
  it("victory while lifted emits map-back", () => {
    const e = diffEffects(s({ mode: "spread", lifted: "강남구" }), s({ mode: "map", lifted: null, focus: null }));
    expect(e).toEqual([
      { type: "scene.layout", mode: "map" },
      { type: "scene.lift", gu: null },
      { type: "narrate", id: "map-back", interrupt: true, protect: false },
      { type: "publish.stage" },
    ]);
  });
  it("no publish.vote before result", () => {
    const e = diffEffects(s({ vote: vote({ phase: "counting" }) }), s({ vote: vote({ phase: "review", counts: [1, 2, 0] }) }));
    expect(types(e)).not.toContain("publish.vote");
  });
  it("voteConfirm from spread: full ordered effects, no map-back", () => {
    const e = diffEffects(
      s({ mode: "spread", vote: vote({ phase: "review", counts: [1, 2, 0] }) }),
      s({ mode: "map", focus: "마포구", vote: vote({ phase: "result", counts: [1, 2, 0], winner: "마포구" }) }),
    );
    expect(e).toEqual([
      { type: "scene.layout", mode: "map" },
      { type: "scene.focus", gu: "마포구" },
      { type: "narrate.stop" },
      { type: "narrate", id: "vote-result-마포구-2", interrupt: true, protect: false },
      { type: "narrate", id: "gu-202611-마포구", interrupt: false, protect: false },
      { type: "publish.state" },
      { type: "publish.stage" },
      { type: "publish.vote" },
    ]);
  });
  it("voteConfirm from map with lifted gu: lift cleared, full order", () => {
    const e = diffEffects(
      s({ lifted: "강남구", vote: vote({ phase: "review", counts: [1, 2, 0] }) }),
      s({ lifted: null, focus: "마포구", vote: vote({ phase: "result", counts: [1, 2, 0], winner: "마포구" }) }),
    );
    expect(e).toEqual([
      { type: "scene.lift", gu: null },
      { type: "scene.focus", gu: "마포구" },
      { type: "narrate.stop" },
      { type: "narrate", id: "vote-result-마포구-2", interrupt: true, protect: false },
      { type: "narrate", id: "gu-202611-마포구", interrupt: false, protect: false },
      { type: "publish.state" },
      { type: "publish.stage" },
      { type: "publish.vote" },
    ]);
  });
  it("all zero emits vote-none", () => {
    const e = diffEffects(
      s({ mode: "spread", vote: vote({ phase: "review", counts: [0, 0, 0] }) }),
      s({ mode: "map", focus: "노원구", vote: vote({ phase: "result", counts: [0, 0, 0], winner: "노원구", allZero: true }) }),
    );
    expect(e).toEqual([
      { type: "scene.layout", mode: "map" },
      { type: "scene.focus", gu: "노원구" },
      { type: "narrate.stop" },
      { type: "narrate", id: "vote-none-노원구", interrupt: true, protect: false },
      { type: "narrate", id: "gu-202611-노원구", interrupt: false, protect: false },
      { type: "publish.state" },
      { type: "publish.stage" },
      { type: "publish.vote" },
    ]);
  });
  it("order is fixed", () => {
    const e = diffEffects(
      s({ mode: "spread", hover: "a" }),
      s({ mode: "map", hover: "b", lifted: "강남구", focus: "강남구", month: "202610", vote: vote({ phase: "counting" }) }),
    );
    expect(types(e)).toEqual([
      "rotate.reset", "scene.layout", "scene.lift", "scene.focus", "scene.hover", "scene.data", "counter.reset",
      "narrate", "narrate", "narrate", "publish.state", "publish.stage",
    ]);
  });
  it("rotate.* come first, catch before grabOne", () => {
    expect(types(diffEffects(base, s({ rotate: "one" })))).toEqual(["rotate.grabOne"]);
    expect(types(diffEffects(s({ spinning: true, hover: "강남구" }), s({ rotate: "one" })))).toEqual(["rotate.catch", "rotate.grabOne", "scene.hover"]);
    expect(types(diffEffects(s({ spinning: true }), s({ rotate: "two" })))).toEqual(["rotate.catch", "rotate.grabTwo"]);
    // 한 손 → 두 손 전환은 놓기 없이 grabTwo만
    expect(types(diffEffects(s({ rotate: "one" }), s({ rotate: "two" })))).toEqual(["rotate.grabTwo"]);
    // 돌리던 중 펼치기 진입: 리셋 하나가 scene.layout 앞
    expect(types(diffEffects(s({ rotate: "one" }), s({ mode: "spread" })))).toEqual(["rotate.reset", "scene.layout", "narrate", "publish.stage"]);
  });
  it("release from one or two hands", () => {
    expect(diffEffects(s({ rotate: "one" }), base)).toEqual([{ type: "rotate.release" }]);
    expect(diffEffects(s({ rotate: "two" }), base)).toEqual([{ type: "rotate.release" }]);
  });
  it("spinState alone emits nothing", () => {
    expect(diffEffects(base, s({ spinning: true }))).toEqual([]);
    expect(diffEffects(s({ spinning: true }), base)).toEqual([]); // 관성이 저절로 끝남
  });
  it("input change resets rotation instead of releasing", () => {
    expect(diffEffects(s({ rotate: "one" }), s({ input: "hands" }))).toEqual([{ type: "rotate.reset" }]);
    expect(diffEffects(base, s({ input: "hands" }))).toEqual([{ type: "rotate.reset" }]);
  });
  it("victory resets from its cause even when nothing else changed", () => {
    const victory: StageEvent = { type: "victory" };
    expect(diffEffects(base, { ...base }, victory)).toEqual([{ type: "rotate.reset" }]);
    expect(diffEffects(s({ rotate: "one" }), base, victory)).toEqual([{ type: "rotate.reset" }]);
    expect(diffEffects(s({ mode: "spread" }), base, victory)[0]).toEqual({ type: "rotate.reset" });
    // 리듀서가 무시한 브이(같은 객체)는 리셋 없음
    expect(diffEffects(base, base, victory)).toEqual([]);
    // cause가 없으면 상태 차이로만 판단한다(브이인지 알 수 없음)
    expect(diffEffects(base, { ...base })).toEqual([]);
    // 다른 cause는 리셋을 만들지 않는다
    expect(diffEffects(s({ rotate: "one" }), base, { type: "release" })).toEqual([{ type: "rotate.release" }]);
  });
  // final I-1: 주 손 주먹이 먼저 확정돼 구를 든 뒤 두 주먹이 들기를 취소하면, 그 구 해설이 계속 나오지 않게 멈춘다.
  it("twoFist that drops a lift stops the gu narration", () => {
    const twoFist: StageEvent = { type: "twoFist" };
    const lifted = s({ input: "hands", hover: "강남구", lifted: "강남구" });
    const rotating = s({ input: "hands", rotate: "two", lifted: null });
    expect(types(diffEffects(lifted, rotating, twoFist))).toEqual([
      "rotate.grabTwo", "scene.lift", "scene.hover", "narrate.stop", "publish.stage",
    ]);
    // 관성 중 두 주먹(든 구 없음)은 멈출 해설이 없다
    expect(types(diffEffects(s({ spinning: true }), s({ rotate: "two" }), twoFist))).toEqual(["rotate.catch", "rotate.grabTwo"]);
    // 들기를 끝내는 다른 원인은 그대로: 놓기(앉히기)는 해설을 멈추지 않는다
    const settle = diffEffects(lifted, s({ input: "hands", hover: "강남구", focus: "강남구" }), { type: "release" });
    expect(types(settle)).not.toContain("narrate.stop");
    // cause 없이 같은 상태 차이만으로는 내지 않는다(두 주먹인지 알 수 없음)
    expect(types(diffEffects(lifted, rotating))).not.toContain("narrate.stop");
  });
  it("NARRATION_IDS literals", () => {
    expect(NARRATION_IDS.voteResult("마포구", 2)).toBe("vote-result-마포구-2");
    expect(NARRATION_IDS.voteNone("노원구")).toBe("vote-none-노원구");
    expect(NARRATION_IDS.hello).toBe("stage-hello");
    expect(NARRATION_IDS.gu("202611", "강남구")).toBe("gu-202611-강남구");
  });
});
