import { describe, expect, it } from "vitest";
import { renderHostControls, toMessage, viewerUrl } from "./hostView";
import type { AppState } from "../state/store";
import type { DataIndex } from "../data/types";

const index: DataIndex = {
  v: 1, generatedAt: "", source: "", months: ["202610", "202611"], gus: ["중구", "강남구"],
  summary: { "202611": { 강남구: { n: 34, cancelled: 0, medPerM2: 2890, medAmt: 1, maxAmt: 1, truncated: false } } },
};
const state: AppState = { month: "202611", gu: "강남구", metric: "price", follow: false, conn: "open" };

describe("hostView", () => {
  it("viewerUrl prefers the configured app URL and points at #/ar", () => {
    expect(viewerUrl("https://d1.cloudfront.net/", { origin: "http://localhost:5173", pathname: "/" })).toBe("https://d1.cloudfront.net/#/ar");
    expect(viewerUrl(null, { origin: "http://localhost:5173", pathname: "/" })).toBe("http://localhost:5173/#/ar");
  });

  it("toMessage builds a contract state message", () => {
    expect(toMessage(state, 42)).toEqual({ v: 1, type: "state", month: "202611", gu: "강남구", metric: "price", ts: 42 });
  });

  it("marks the selected month, gu and metric with aria-pressed", () => {
    const html = renderHostControls(state, index);
    expect(html).toMatch(/data-action="gu" data-value="강남구"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-action="gu" data-value="중구"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/data-action="month" data-value="202611"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-action="metric" data-value="price"[^>]*aria-pressed="true"/);
    expect(html).toContain("2,890");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("states the connection in words", () => {
    expect(renderHostControls({ ...state, conn: "error" }, index)).toContain("연결 안 됨");
    expect(renderHostControls(state, index)).toContain("연결됨");
  });
});
