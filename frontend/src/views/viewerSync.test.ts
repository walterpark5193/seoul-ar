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
});
