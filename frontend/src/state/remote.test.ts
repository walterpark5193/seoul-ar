import { describe, expect, it, vi } from "vitest";
import { MAX_FUTURE_MS, REFRESH_RETRY_MS, acceptRemote, bindRemote } from "./remote";
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
    bindRemote({ realtime: rt, store, index: () => index, now: () => NOW, isHost });
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
    const off = bindRemote({ realtime: rt, store, index: () => index, now: () => NOW, isHost: () => false });
    off();
    const spy = vi.spyOn(store, "dispatch");
    await rt.publish(msg());
    expect(spy).not.toHaveBeenCalled();
  });

  describe("month not in the loaded index", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const withRefresh = (next: { months: string[]; gus: string[] }) => {
      const store = createStore({ ...INITIAL_STATE, month: "202611" });
      const rt = createMockRealtime({ channel: () => null });
      let current = index;
      const refreshIndex = vi.fn(async () => { current = next; return next; });
      bindRemote({ realtime: rt, store, index: () => current, refreshIndex, now: () => NOW, isHost: () => false });
      return { store, rt, refreshIndex };
    };

    it("re-fetches the index once, then applies the newly fetched month", async () => {
      const { store, rt, refreshIndex } = withRefresh({ months: ["202609", "202610", "202611"], gus: index.gus });
      await rt.publish(msg({ month: "202609", gu: "중구" }));
      await flush();
      expect(refreshIndex).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({ month: "202609", gu: "중구" });
    });

    it("drops it if the month is still unknown, and does not refetch for the same month again", async () => {
      const { store, rt, refreshIndex } = withRefresh({ months: index.months, gus: index.gus });
      await rt.publish(msg({ month: "202609" }));
      await flush();
      await rt.publish(msg({ month: "202609", ts: NOW + 1 }));
      await flush();
      expect(refreshIndex).toHaveBeenCalledTimes(1);
      expect(store.getState().month).toBe("202611");
    });

    it("allows another refresh for the same month after REFRESH_RETRY_MS", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202611" });
      const rt = createMockRealtime({ channel: () => null });
      let t = NOW;
      let current = index;
      // 첫 refresh에는 아직 새 달이 없고(수집 전), 두 번째에 생긴다.
      const refreshIndex = vi.fn(async () => {
        if (refreshIndex.mock.calls.length >= 2) current = { months: ["202609", ...index.months], gus: index.gus };
        return current;
      });
      bindRemote({ realtime: rt, store, index: () => current, refreshIndex, now: () => t, isHost: () => false });
      await rt.publish(msg({ month: "202609", ts: t }));
      await flush();
      expect(store.getState().month).toBe("202611");
      await rt.publish(msg({ month: "202609", ts: t + 1 }));
      await flush();
      expect(refreshIndex).toHaveBeenCalledTimes(1);
      t += REFRESH_RETRY_MS;
      await rt.publish(msg({ month: "202609", ts: t }));
      await flush();
      expect(refreshIndex).toHaveBeenCalledTimes(2);
      expect(store.getState().month).toBe("202609");
    });

    it("never refetches for a month after this month or for a far-future ts", async () => {
      const { rt, refreshIndex } = withRefresh({ months: ["209912"], gus: index.gus });
      await rt.publish(msg({ month: "209912" }));
      await rt.publish(msg({ month: "202609", ts: NOW + 10 * MAX_FUTURE_MS }));
      await flush();
      expect(refreshIndex).not.toHaveBeenCalled();
    });

    it("keeps working when the refresh fails", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202611" });
      const rt = createMockRealtime({ channel: () => null });
      bindRemote({
        realtime: rt, store, index: () => index, now: () => NOW, isHost: () => false,
        refreshIndex: async () => { throw new Error("offline"); },
      });
      await rt.publish(msg({ month: "202609" }));
      await flush();
      await rt.publish(msg({ month: "202610", gu: "중구" }));
      expect(store.getState()).toMatchObject({ month: "202610", gu: "중구" });
    });
  });
});
