import { describe, expect, it, vi } from "vitest";
import { mountSheet } from "./sheetDom";
import { INITIAL_STATE, createStore, type AppState } from "../state/store";
import type { DataIndex, GuData } from "../data/types";

const index: DataIndex = {
  v: 1, generatedAt: "", source: "", months: ["202611"], gus: ["강남구"],
  summary: { "202611": { 강남구: { n: 34, cancelled: 0, medPerM2: 2890, medAmt: 1, maxAmt: 526000, truncated: false } } },
};
const data: GuData = {
  v: 1, month: "202611", gu: "강남구", generatedAt: "", total: index.summary["202611"]!.강남구!,
  dongs: [{ name: "대치동", n: 7, cancelled: 0, nApt: 5, medPerM2: 3300, medPerM2Apt: null, medAmt: 1, maxAmt: 1, usage: {} }],
};
const state = (over: Partial<AppState> = {}): AppState => ({ ...INITIAL_STATE, month: "202611", gu: "강남구", conn: "open", ...over });

/** node 테스트용 가짜 host: 리스너만 모으고, 그리기는 paint 주입으로 받는다. */
function fakeHost() {
  const listeners: Record<string, (ev: unknown) => void> = {};
  const host = {
    addEventListener: (type: string, fn: (ev: unknown) => void) => { listeners[type] = fn; },
    removeEventListener: vi.fn(),
    contains: () => true,
    innerHTML: "",
  } as unknown as HTMLElement;
  return { host, listeners };
}

/** closest(selector)만 흉내 내는 클릭 대상. */
function target(o: { action?: string; value?: string; inHead?: boolean }) {
  return {
    closest(sel: string) {
      if (sel === "button[data-action]") return o.action ? { dataset: { action: o.action, value: o.value } } : null;
      if (sel === ".sheet-head") return o.inHead ? {} : null;
      if (sel.includes("button")) return o.action ? {} : null;
      return null;
    },
  };
}

function setup() {
  const store = createStore(state());
  const { host, listeners } = fakeHost();
  let html = "";
  const sheet = mountSheet(host, store, () => index, { paint: (_h, h) => { html = h; } });
  const click = (o: Parameters<typeof target>[0]) => listeners.click!({ target: target(o) });
  return { store, sheet, click, html: () => html };
}

describe("mountSheet toggle (Task 4f)", () => {
  it("starts in peek on every mount", () => {
    const { sheet, html } = setup();
    sheet.render(state(), data, null);
    expect(sheet.expanded).toBe(false);
    expect(html()).toContain('aria-expanded="false"');
    expect(html()).not.toContain("dong-list");
    const again = setup();
    again.sheet.render(state(), data, null);
    expect(again.sheet.expanded).toBe(false);
  });

  it("the handle flips the state and aria-expanded, and a re-render keeps it", () => {
    const { sheet, click, html } = setup();
    sheet.render(state(), data, null);
    click({ action: "sheet-toggle" });
    expect(sheet.expanded).toBe(true);
    expect(html()).toContain('aria-expanded="true"');
    expect(html()).toContain("dong-list");
    sheet.render(state({ conn: "error" }), data, null);
    expect(sheet.expanded).toBe(true);
    expect(html()).toContain("연결 끊김");
    expect(html()).toContain('aria-expanded="true"');
    click({ action: "sheet-toggle" });
    expect(sheet.expanded).toBe(false);
    expect(html()).toContain('aria-expanded="false"');
  });

  it("tapping the header toggles; a button inside the header does its own job", () => {
    const { sheet, click, store } = setup();
    sheet.render(state(), data, null);
    click({ inHead: true });
    expect(sheet.expanded).toBe(true);
    const spy = vi.spyOn(store, "dispatch");
    click({ action: "follow", inHead: true });
    expect(spy).toHaveBeenCalledWith({ type: "follow" });
    expect(sheet.expanded).toBe(true);
  });

  it("metric buttons still dispatch local actions", () => {
    const { sheet, click, store } = setup();
    sheet.render(state(), data, null);
    click({ action: "sheet-toggle" });
    click({ action: "metric", value: "count" });
    expect(store.getState()).toMatchObject({ metric: "count", follow: false });
  });
});
