import { describe, expect, it, vi } from "vitest";
import { bindStageFollow, voteLine } from "./stageFollow";
import { INITIAL_STATE, createStore } from "../state/store";
import type { StageChannel } from "../stage/net/stageChannel";
import type { StageChannelMessage, VoteMessage } from "../stage/net/messages";
import type { DataIndex } from "../data/types";

const index: DataIndex = { v: 1, generatedAt: "", source: "", months: ["202611"], gus: [], summary: {} };

function fakeChannel() {
  let h: ((m: StageChannelMessage) => void) | null = null;
  const channel = {
    subscribe: (fn: (m: StageChannelMessage) => void) => { h = fn; return () => { h = null; }; },
  } as unknown as StageChannel;
  return { channel, emit: (m: unknown) => h?.(m as StageChannelMessage), active: () => h !== null };
}

const vote: VoteMessage = {
  v: 1, type: "vote", round: 1, phase: "result",
  candidates: ["강남구", "마포구", "노원구"], counts: [2, 1, 0], winner: "강남구", ts: 1,
};

function setup(follow: boolean) {
  const store = createStore({ ...INITIAL_STATE, month: "202611", follow });
  const f = fakeChannel();
  const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn() };
  const unbind = bindStageFollow({ channel: f.channel, store, index, ...o });
  return { f, o, unbind };
}

describe("stageFollow", () => {
  it("voteLine", () => {
    expect(voteLine(vote)).toBe("투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표");
  });

  it("follow true applies layout and lift", () => {
    const { f, o } = setup(true);
    f.emit({ v: 1, type: "stage", mode: "spread", lifted: "마포구", ts: 1 });
    expect(o.onLayout).toHaveBeenCalledWith("spread");
    expect(o.onLift).toHaveBeenCalledWith("마포구");
  });

  it("follow false ignores layout but shows vote", () => {
    const { f, o } = setup(false);
    f.emit({ v: 1, type: "stage", mode: "spread", lifted: "마포구", ts: 1 });
    f.emit(vote);
    expect(o.onLayout).not.toHaveBeenCalled();
    expect(o.onLift).not.toHaveBeenCalled();
    expect(o.onVote).toHaveBeenCalledWith("투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표");
  });

  it("re-runs layout when month or metric changes while following", () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611", follow: true });
    const f = fakeChannel();
    const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn() };
    bindStageFollow({ channel: f.channel, store, index, ...o });
    f.emit({ v: 1, type: "stage", mode: "spread", lifted: null, ts: 1 });
    expect(o.onLayout).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "remote", msg: { v: 1, type: "state", month: "202611", gu: null, metric: "count", ts: 2 } });
    expect(o.onLayout).toHaveBeenCalledTimes(2);
    expect(o.onLayout).toHaveBeenLastCalledWith("spread");
  });

  it("malformed ignored", () => {
    const { f, o } = setup(true);
    f.emit(null);
    f.emit({ v: 1, type: "stage", mode: "bogus", lifted: null, ts: 1 });
    f.emit({ v: 1, type: "vote", phase: "result" });
    f.emit({ ...vote, phase: "counting" });
    expect(o.onLayout).not.toHaveBeenCalled();
    expect(o.onVote).not.toHaveBeenCalled();
  });

  it("unbind stops listening", () => {
    const { f, unbind } = setup(true);
    unbind();
    expect(f.active()).toBe(false);
  });
});
