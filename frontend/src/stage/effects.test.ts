import { describe, expect, it } from "vitest";
import { diffEffects, NARRATION_IDS } from "./effects";
import type { StageState, VoteState } from "./types";

const base: StageState = { mode: "map", hover: null, lifted: null, focus: null, input: "mouse", vote: null, month: "202611", metric: "price", round: 0 };
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
    expect(e[0]).toEqual({ type: "narrate", id: "vote-intro", interrupt: true, protect: true });
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
      "scene.layout", "scene.lift", "scene.focus", "scene.hover", "scene.data", "counter.reset",
      "narrate", "narrate", "narrate", "publish.state", "publish.stage",
    ]);
  });
  it("NARRATION_IDS literals", () => {
    expect(NARRATION_IDS.voteResult("마포구", 2)).toBe("vote-result-마포구-2");
    expect(NARRATION_IDS.voteNone("노원구")).toBe("vote-none-노원구");
    expect(NARRATION_IDS.hello).toBe("stage-hello");
    expect(NARRATION_IDS.gu("202611", "강남구")).toBe("gu-202611-강남구");
  });
});
