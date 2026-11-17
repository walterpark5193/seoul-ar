import { describe, expect, it, vi } from "vitest";
import { MAX_FUTURE_MS, acceptRemote, bindRemote } from "./remote";
import { INITIAL_STATE, createStore } from "./store";
import { createMockRealtime } from "../realtime/mock";
import type { StateMessage } from "../realtime/types";

const index = { months: ["202610", "202611"], gus: ["중구", "강남구"] };
const NOW = 1_800_000_000_000;
const msg = (over: Partial<StateMessage> = {}): StateMessage => ({
  v: 1, type: "state", month: "202611", gu: "강남구", metric: "count", ts: NOW, ...over,
});

describe("acceptRemote", () => {
  it("accepts a message that matches the index", () => {
    expect(acceptRemote(msg(), index, NOW)).toBe(true);
    expect(acceptRemote(msg({ gu: null }), index, NOW)).toBe(true);
    expect(acceptRemote(msg({ ts: NOW + MAX_FUTURE_MS }), index, NOW)).toBe(true);
  });

  it("rejects a ts more than 30 s in the future", () => {
    expect(MAX_FUTURE_MS).toBe(30_000);
    expect(acceptRemote(msg({ ts: NOW + MAX_FUTURE_MS + 1 }), index, NOW)).toBe(false);
    expect(acceptRemote(msg({ ts: 8.64e15 }), index, NOW)).toBe(false);
  });

  it("rejects a gu or month that is not in the index", () => {
    expect(acceptRemote(msg({ gu: "판교구" }), index, NOW)).toBe(false);
    expect(acceptRemote(msg({ month: "202501" }), index, NOW)).toBe(false);
  });
});

describe("bindRemote", () => {
  const setup = (isHost = () => false) => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const rt = createMockRealtime({ channel: () => null });
    bindRemote({ realtime: rt, store, index, now: () => NOW, isHost });
    return { store, rt };
  };

  it("a forged far-future message cannot make later host messages look stale", async () => {
    const { store, rt } = setup();
    await rt.publish(msg({ gu: "중구", ts: NOW + 10 * 365 * 24 * 3600 * 1000 }));
    expect(store.getState().gu).toBeNull();
    await rt.publish(msg({ gu: "강남구", ts: NOW }));
    expect(store.getState().gu).toBe("강남구");
  });

  it("drops messages for unknown gu or month and keeps the current state", async () => {
    const { store, rt } = setup();
    await rt.publish(msg({ gu: "<img>" }));
    await rt.publish(msg({ month: "209912" }));
    expect(store.getState()).toMatchObject({ month: "202611", gu: null });
  });

  it("does not apply remote state on the host screen", async () => {
    const { store, rt } = setup(() => true);
    await rt.publish(msg());
    expect(store.getState().gu).toBeNull();
  });

  it("unbinds", async () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const rt = createMockRealtime({ channel: () => null });
    const off = bindRemote({ realtime: rt, store, index, now: () => NOW, isHost: () => false });
    off();
    const spy = vi.spyOn(store, "dispatch");
    await rt.publish(msg());
    expect(spy).not.toHaveBeenCalled();
  });
});
