import { describe, expect, it, vi } from "vitest";
import { bindViewer } from "./viewerSync";
import { INITIAL_STATE, createStore } from "../state/store";
import type { GuData } from "../data/types";

const gu = (name: string): GuData => ({
  v: 1, month: "202611", gu: name, generatedAt: "",
  total: { n: 1, cancelled: 0, medPerM2: 1, medAmt: 1, maxAmt: 1, truncated: false }, dongs: [],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("bindViewer", () => {
  it("draws the overview immediately", () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const onScene = vi.fn();
    const onSheet = vi.fn();
    bindViewer({ store, loadGu: vi.fn(), onScene, onSheet });
    expect(onScene).toHaveBeenCalledWith(expect.objectContaining({ gu: null }), null);
    expect(onSheet).toHaveBeenCalledTimes(1);
  });

  it("loads gu data, then redraws; ignores a stale response", async () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const a = deferred<GuData>();
    const b = deferred<GuData>();
    const loadGu = vi.fn((_m: string, g: string) => (g === "중구" ? a.promise : b.promise));
    const onScene = vi.fn();
    const onSheet = vi.fn();
    bindViewer({ store, loadGu, onScene, onSheet });
    store.dispatch({ type: "local", gu: "중구" });
    store.dispatch({ type: "local", gu: "마포구" });
    b.resolve(gu("마포구"));
    await flush();
    a.resolve(gu("중구"));
    await flush();
    const lastScene = onScene.mock.calls.at(-1);
    expect(lastScene?.[0].gu).toBe("마포구");
    expect(lastScene?.[1]?.gu).toBe("마포구");
    expect(onScene.mock.calls.some((c) => c[1]?.gu === "중구")).toBe(false);
  });

  it("redraws the scene on metric change but only the sheet on conn change", async () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const onScene = vi.fn();
    const onSheet = vi.fn();
    bindViewer({ store, loadGu: vi.fn(async () => gu("중구")), onScene, onSheet });
    store.dispatch({ type: "local", gu: "중구" });
    await flush();
    const scenes = onScene.mock.calls.length;
    store.dispatch({ type: "conn", status: "open" });
    expect(onScene).toHaveBeenCalledTimes(scenes);
    store.dispatch({ type: "local", metric: "count" });
    expect(onScene).toHaveBeenCalledTimes(scenes + 1);
    expect(onScene.mock.calls.at(-1)?.[1]?.gu).toBe("중구");
  });

  it("still draws with null data when loading fails", async () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const onScene = vi.fn();
    bindViewer({ store, loadGu: vi.fn(async () => { throw new Error("404"); }), onScene, onSheet: vi.fn() });
    store.dispatch({ type: "local", gu: "중구" });
    await flush();
    expect(onScene).toHaveBeenLastCalledWith(expect.objectContaining({ gu: "중구" }), null);
  });

  it("stops after unbind", async () => {
    const store = createStore({ ...INITIAL_STATE, month: "202611" });
    const onSheet = vi.fn();
    const off = bindViewer({ store, loadGu: vi.fn(), onScene: vi.fn(), onSheet });
    off();
    store.dispatch({ type: "conn", status: "open" });
    expect(onSheet).toHaveBeenCalledTimes(1);
  });

  describe("same-gu month switch (time travel morph, CONTRACTS 11)", () => {
    const guMonth = (name: string, month: string): GuData => ({ ...gu(name), month });

    it("keeps the previous month's data on the scene until the new one arrives: no null in between", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202610", gu: "중구", follow: true });
      const next = deferred<GuData>();
      const loadGu = vi.fn((m: string, g: string) => (m === "202610" ? Promise.resolve(guMonth(g, m)) : next.promise));
      const onScene = vi.fn();
      bindViewer({ store, loadGu, onScene, onSheet: vi.fn() });
      await flush();
      store.dispatch({ type: "remote", msg: { v: 1, type: "state", month: "202611", gu: "중구", metric: "price", ts: 1 } });
      store.dispatch({ type: "conn", status: "open" });
      store.dispatch({ type: "conn", status: "error" });
      next.resolve(guMonth("중구", "202611"));
      await flush();
      const seq = onScene.mock.calls.map(([s, d]) => `${s.gu}:${d ? d.month : "null"}`);
      // 처음 마운트는 "보여 줄 것이 없는" 구 변경이라 null로 시작한다. 그 뒤 두 달 사이에는 null이 없다.
      expect(seq).toEqual(["중구:null", "중구:202610", "중구:202611"]);
    });

    it("applies a metric change made during the load together with the new data", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202610", gu: "중구" });
      const next = deferred<GuData>();
      const loadGu = vi.fn((m: string, g: string) => (m === "202610" ? Promise.resolve(guMonth(g, m)) : next.promise));
      const onScene = vi.fn();
      bindViewer({ store, loadGu, onScene, onSheet: vi.fn() });
      await flush();
      store.dispatch({ type: "local", month: "202611" });
      store.dispatch({ type: "local", metric: "count" });
      next.resolve(guMonth("중구", "202611"));
      await flush();
      const last = onScene.mock.calls.at(-1)!;
      expect(onScene.mock.calls.map(([, d]) => d?.month ?? null)).toEqual([null, "202610", "202611"]);
      expect(last[0]).toMatchObject({ month: "202611", metric: "count" });
      expect(last[1]?.month).toBe("202611");
    });

    it("a real gu change still shows the gu at once with null, then its data", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202611", gu: "중구" });
      const next = deferred<GuData>();
      const loadGu = vi.fn((m: string, g: string) => (g === "중구" ? Promise.resolve(guMonth(g, m)) : next.promise));
      const onScene = vi.fn();
      bindViewer({ store, loadGu, onScene, onSheet: vi.fn() });
      await flush();
      store.dispatch({ type: "local", gu: "마포구" });
      expect(onScene.mock.calls.at(-1)?.[0].gu).toBe("마포구");
      expect(onScene.mock.calls.at(-1)?.[1]).toBeNull();
      next.resolve(guMonth("마포구", "202611"));
      await flush();
      expect(onScene.mock.calls.at(-1)?.[1]?.gu).toBe("마포구");
    });
  });

  describe("narration", () => {
    const narr = (month: string) => ({ v: 1 as const, month, generatedAt: "", model: "m", items: { "서울 전체": `${month} 문장` } });

    it("loads the month's narration and passes it to the sheet, reloading when the month changes", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202611" });
      const onSheet = vi.fn();
      const loadNarration = vi.fn(async (m: string) => narr(m));
      bindViewer({ store, loadGu: vi.fn(), loadNarration, onScene: vi.fn(), onSheet });
      await flush();
      expect(onSheet.mock.calls.at(-1)?.[2]).toMatchObject({ month: "202611" });
      store.dispatch({ type: "local", month: "202610" });
      await flush();
      expect(loadNarration).toHaveBeenLastCalledWith("202610");
      expect(onSheet.mock.calls.at(-1)?.[2]).toMatchObject({ month: "202610" });
    });

    it("never passes a narration for another month while the new one loads", async () => {
      const store = createStore({ ...INITIAL_STATE, month: "202611" });
      const onSheet = vi.fn();
      const later = deferred<ReturnType<typeof narr>>();
      const loadNarration = vi.fn(async (m: string) => (m === "202611" ? narr(m) : later.promise));
      bindViewer({ store, loadGu: vi.fn(), loadNarration, onScene: vi.fn(), onSheet });
      await flush();
      store.dispatch({ type: "local", month: "202610" });
      expect(onSheet.mock.calls.at(-1)?.[2] ?? null).toBeNull();
      later.resolve(narr("202610"));
      await flush();
      expect(onSheet.mock.calls.at(-1)?.[2]).toMatchObject({ month: "202610" });
    });

    it("checks again later while the narration is missing, and stops after unbind", async () => {
      vi.useFakeTimers();
      try {
        const store = createStore({ ...INITIAL_STATE, month: "202611" });
        const onSheet = vi.fn();
        const loadNarration = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(narr("202611"));
        const off = bindViewer({ store, loadGu: vi.fn(), loadNarration, onScene: vi.fn(), onSheet, narrationRetryMs: 60_000 });
        await vi.advanceTimersByTimeAsync(0);
        expect(loadNarration).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(loadNarration).toHaveBeenCalledTimes(2);
        expect(onSheet.mock.calls.at(-1)?.[2]).toMatchObject({ month: "202611" });
        await vi.advanceTimersByTimeAsync(300_000);
        expect(loadNarration).toHaveBeenCalledTimes(2);
        off();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
