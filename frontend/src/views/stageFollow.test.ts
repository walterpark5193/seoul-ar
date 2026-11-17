import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPREAD_METRIC, STAGE_STALE_MS, bindStageFollow, followLayout, voteLine } from "./stageFollow";
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

  it("re-runs layout when the month changes while following; a metric change alone does not (spread is always by price)", () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611", follow: true });
    const f = fakeChannel();
    const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn() };
    bindStageFollow({ channel: f.channel, store, index: { ...index, months: ["202610", "202611"] }, ...o });
    f.emit({ v: 1, type: "stage", mode: "spread", lifted: null, ts: 1 });
    expect(o.onLayout).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "remote", msg: { v: 1, type: "state", month: "202611", gu: null, metric: "count", ts: 2 } });
    expect(o.onLayout).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "remote", msg: { v: 1, type: "state", month: "202610", gu: null, metric: "count", ts: 3 } });
    expect(store.getState().month).toBe("202610");
    expect(o.onLayout).toHaveBeenCalledTimes(2);
    expect(o.onLayout).toHaveBeenLastCalledWith("spread");
  });

  it("turning follow off returns to map and clears lift once", () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611", follow: true });
    const f = fakeChannel();
    const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn() };
    bindStageFollow({ channel: f.channel, store, index, ...o });
    f.emit({ v: 1, type: "stage", mode: "spread", lifted: "마포구", ts: 1 });
    o.onLayout.mockClear(); o.onLift.mockClear();
    store.dispatch({ type: "local", metric: "count" });
    expect(store.getState().follow).toBe(false);
    expect(o.onLayout).toHaveBeenCalledTimes(1);
    expect(o.onLayout).toHaveBeenCalledWith("map");
    expect(o.onLift).toHaveBeenCalledTimes(1);
    expect(o.onLift).toHaveBeenCalledWith(null);
  });

  it("stores stage messages while follow is off and re-applies the last on follow on", () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611", follow: false });
    const f = fakeChannel();
    const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn() };
    bindStageFollow({ channel: f.channel, store, index, ...o });
    f.emit({ v: 1, type: "stage", mode: "spread", lifted: "노원구", ts: 1 });
    f.emit({ v: 1, type: "stage", mode: "map", lifted: "마포구", ts: 2 });
    expect(o.onLayout).not.toHaveBeenCalled();
    store.dispatch({ type: "follow" });
    expect(store.getState().follow).toBe(true);
    expect(o.onLayout).toHaveBeenCalledTimes(1);
    expect(o.onLayout).toHaveBeenCalledWith("map");
    expect(o.onLift).toHaveBeenCalledWith("마포구");
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

describe("followLayout: 폰의 펼치기도 늘 ㎡당 가격순", () => {
  const stat = (medPerM2: number, n: number) => ({ n, cancelled: 0, medPerM2, medAmt: null, maxAmt: null, truncated: false });
  const idx: DataIndex = { ...index, summary: { "202611": { 강남구: stat(3000, 10), 노원구: stat(900, 80) } } };

  it("지표가 거래 건수여도 setLayout에는 price를 넘긴다", () => {
    const city = { setLayout: vi.fn() };
    followLayout(city, idx, "202611", "spread");
    expect(city.setLayout).toHaveBeenCalledWith("spread", idx.summary["202611"], "price");
    expect(SPREAD_METRIC).toBe("price");
  });

  it("요약이 없는 달은 매번 같은 빈 요약을 넘긴다(하트비트마다 라벨을 다시 만들지 않게)", () => {
    const city = { setLayout: vi.fn() };
    followLayout(city, idx, "209901", "spread");
    followLayout(city, idx, "209901", "spread");
    const [a, b] = city.setLayout.mock.calls.map((c) => c[1]);
    expect(a).toEqual({});
    expect(a).toBe(b);
  });
});

describe("stageFollow: 무대가 사라지면(30초 무소식) 폰을 지도로 되돌린다", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const spread = { v: 1, type: "stage", mode: "spread", lifted: "마포구", ts: 1 } as const;

  function setupTimed(follow: boolean) {
    const store = createStore({ ...INITIAL_STATE, month: "202611", follow });
    const f = fakeChannel();
    const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn(), onStage: vi.fn() };
    const unbind = bindStageFollow({ channel: f.channel, store, index, ...o });
    return { store, f, o, unbind };
  }

  it("STAGE_STALE_MS는 무대 하트비트 10초의 3배", () => {
    expect(STAGE_STALE_MS).toBe(30_000);
  });

  it("마지막 StageMessage 뒤 30초 동안 새 메시지가 없으면 map·lift null, onStage(false)", () => {
    const { f, o } = setupTimed(true);
    f.emit(spread);
    expect(o.onStage).toHaveBeenLastCalledWith(true);
    o.onLayout.mockClear(); o.onLift.mockClear();
    vi.advanceTimersByTime(29_999);
    expect(o.onLayout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(o.onLayout).toHaveBeenCalledTimes(1);
    expect(o.onLayout).toHaveBeenCalledWith("map");
    expect(o.onLift).toHaveBeenCalledTimes(1);
    expect(o.onLift).toHaveBeenCalledWith(null);
    expect(o.onStage).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(120_000);
    expect(o.onLayout).toHaveBeenCalledTimes(1); // 한 번만
  });

  it("하트비트(10초)가 오는 동안은 만료되지 않는다", () => {
    const { f, o } = setupTimed(true);
    f.emit(spread);
    for (let i = 0; i < 9; i++) { vi.advanceTimersByTime(10_000); f.emit({ ...spread, ts: 2 + i }); }
    expect(o.onLayout.mock.calls.every(([m]) => m === "spread")).toBe(true);
    expect(o.onStage).not.toHaveBeenCalledWith(false);
  });

  it("투표 메시지는 무대 상태 시계를 늘리지 않는다", () => {
    const { f, o } = setupTimed(true);
    f.emit(spread);
    vi.advanceTimersByTime(20_000);
    f.emit({ ...vote, phase: "counting", winner: null, ts: 5 });
    vi.advanceTimersByTime(10_000);
    expect(o.onLayout).toHaveBeenLastCalledWith("map");
  });

  it("만료 뒤 따라가기를 다시 켜도 낡은 펼침을 다시 적용하지 않는다", () => {
    const { store, f, o } = setupTimed(false);
    f.emit(spread);
    vi.advanceTimersByTime(30_000);
    expect(o.onStage).toHaveBeenLastCalledWith(false);
    expect(o.onLayout).not.toHaveBeenCalled(); // follow off: 이미 폰 자기 화면
    store.dispatch({ type: "follow" });
    expect(store.getState().follow).toBe(true);
    expect(o.onLayout).not.toHaveBeenCalled();
    expect(o.onLift).not.toHaveBeenCalled();
  });

  it("만료 뒤 새 StageMessage가 오면 다시 따라가고 onStage(true)", () => {
    const { f, o } = setupTimed(true);
    f.emit(spread);
    vi.advanceTimersByTime(30_000);
    f.emit({ ...spread, ts: 9 });
    expect(o.onLayout).toHaveBeenLastCalledWith("spread");
    expect(o.onLift).toHaveBeenLastCalledWith("마포구");
    expect(o.onStage).toHaveBeenLastCalledWith(true);
  });

  it("무대가 보내는 최종 {map, null}은 그대로 반영한다", () => {
    const { f, o } = setupTimed(true);
    f.emit(spread);
    f.emit({ v: 1, type: "stage", mode: "map", lifted: null, ts: 2 });
    expect(o.onLayout).toHaveBeenLastCalledWith("map");
    expect(o.onLift).toHaveBeenLastCalledWith(null);
  });

  it("unbind하면 만료 타이머도 멈춘다", () => {
    const { f, o, unbind } = setupTimed(true);
    f.emit(spread);
    unbind();
    o.onLayout.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(o.onLayout).not.toHaveBeenCalled();
    expect(o.onStage).not.toHaveBeenCalledWith(false);
  });
});

describe("stageFollow: onView (yaw·zoom)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const base = { v: 1, type: "stage", mode: "map", lifted: null, ts: 1 } as const;

  function setupView(follow: boolean) {
    const store = createStore({ ...INITIAL_STATE, month: "202611", follow });
    const f = fakeChannel();
    const o = { onLayout: vi.fn(), onLift: vi.fn(), onVote: vi.fn(), onView: vi.fn() };
    bindStageFollow({ channel: f.channel, store, index, ...o });
    return { store, f, o };
  }

  it("onView called while following; missing fields mean (0, 1)", () => {
    const { f, o } = setupView(true);
    f.emit({ ...base, yaw: 1.1, zoom: 1.3 });
    expect(o.onView).toHaveBeenLastCalledWith(1.1, 1.3);
    f.emit({ ...base, ts: 2 });
    expect(o.onView).toHaveBeenLastCalledWith(0, 1);
  });

  it("not called when not following; applied when follow turns on", () => {
    const { store, f, o } = setupView(false);
    f.emit({ ...base, yaw: 1, zoom: 1.2 });
    expect(o.onView).not.toHaveBeenCalled();
    store.dispatch({ type: "follow" });
    expect(o.onView).toHaveBeenLastCalledWith(1, 1.2);
  });

  it("onView reset on stale", () => {
    const { f, o } = setupView(true);
    f.emit({ ...base, yaw: 1, zoom: 1.2 });
    vi.advanceTimersByTime(STAGE_STALE_MS);
    expect(o.onView).toHaveBeenLastCalledWith(0, 1);
  });

  it("follow off -> onView(0,1)", () => {
    const { store, f, o } = setupView(true);
    f.emit({ ...base, yaw: 1, zoom: 1.2 });
    store.dispatch({ type: "local", metric: "count" }); // 직접 조작하면 따라가기가 꺼진다
    expect(store.getState().follow).toBe(false);
    expect(o.onView).toHaveBeenLastCalledWith(0, 1);
  });
});
