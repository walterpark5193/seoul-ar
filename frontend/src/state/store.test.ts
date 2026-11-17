import { describe, expect, it, vi } from "vitest";
import { INITIAL_STATE, createStore, initialStateFor, reduce, type AppState } from "./store";
import type { StateMessage } from "../realtime/types";

const msg = (over: Partial<StateMessage> = {}): StateMessage => ({
  v: 1, type: "state", month: "202610", gu: "강남구", metric: "count", ts: 1000, ...over,
});

const base: AppState = { ...INITIAL_STATE, month: "202611" };

describe("INITIAL_STATE", () => {
  it("starts on overview, price, following, idle", () => {
    expect(INITIAL_STATE.gu).toBeNull();
    expect(INITIAL_STATE.metric).toBe("price");
    expect(INITIAL_STATE.follow).toBe(true);
    expect(INITIAL_STATE.conn).toBe("idle");
  });

  it("initialStateFor picks the last month of the index", () => {
    expect(initialStateFor({ months: ["202609", "202610", "202611"] }).month).toBe("202611");
    expect(initialStateFor({ months: [] }).month).toBe("");
  });
});

describe("reduce", () => {
  it("remote applies month/gu/metric while following", () => {
    const s = reduce(base, { type: "remote", msg: msg() }, null);
    expect(s).toMatchObject({ month: "202610", gu: "강남구", metric: "count", follow: true });
  });

  it("local switches follow off and applies only given fields", () => {
    const s = reduce(base, { type: "local", gu: "마포구" }, null);
    expect(s).toMatchObject({ month: "202611", gu: "마포구", metric: "price", follow: false });
    const back = reduce(s, { type: "local", gu: null }, null);
    expect(back.gu).toBeNull();
  });

  it("reduce ignores remote when follow=false", () => {
    const local = reduce(base, { type: "local", metric: "count" }, null);
    const s = reduce(local, { type: "remote", msg: msg({ gu: "송파구" }) }, null);
    expect(s).toEqual(local);
  });

  it("follow restores the last remote state", () => {
    const local = reduce(base, { type: "local", gu: "마포구" }, null);
    const s = reduce(local, { type: "follow" }, msg({ gu: "서초구", month: "202609", metric: "price" }));
    expect(s).toMatchObject({ follow: true, gu: "서초구", month: "202609", metric: "price" });
  });

  it("follow without any remote keeps the current selection", () => {
    const local = reduce(base, { type: "local", gu: "마포구" }, null);
    const s = reduce(local, { type: "follow" }, null);
    expect(s).toMatchObject({ follow: true, gu: "마포구" });
  });

  it("conn updates connection status only", () => {
    const s = reduce(base, { type: "conn", status: "open" }, null);
    expect(s).toEqual({ ...base, conn: "open" });
  });

  it("drops a remote message older than the last one", () => {
    const s = reduce(base, { type: "remote", msg: msg({ ts: 5 }) }, msg({ ts: 10, gu: "중구" }));
    expect(s).toEqual(base);
  });
});

describe("createStore", () => {
  it("notifies subscribers on change and not on no-op", () => {
    const store = createStore(base);
    const fn = vi.fn();
    store.subscribe(fn);
    store.dispatch({ type: "conn", status: "open" });
    store.dispatch({ type: "conn", status: "open" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.getState().conn).toBe("open");
  });

  it("remembers remote messages received while not following", () => {
    const store = createStore(base);
    store.dispatch({ type: "local", gu: "마포구" });
    store.dispatch({ type: "remote", msg: msg({ gu: "강서구", ts: 20 }) });
    expect(store.getState().gu).toBe("마포구");
    store.dispatch({ type: "follow" });
    expect(store.getState()).toMatchObject({ follow: true, gu: "강서구" });
  });

  it("unsubscribe stops notifications", () => {
    const store = createStore(base);
    const fn = vi.fn();
    const off = store.subscribe(fn);
    off();
    store.dispatch({ type: "local", gu: "중구" });
    expect(fn).not.toHaveBeenCalled();
  });
});
