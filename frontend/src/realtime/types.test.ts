import { describe, expect, it } from "vitest";
import { isStateMessage } from "./types";

const good = { v: 1, type: "state", month: "202611", gu: "강남구", metric: "price", ts: 1731830400000 };

describe("isStateMessage", () => {
  it("accepts a well-formed message, with gu or null", () => {
    expect(isStateMessage(good)).toBe(true);
    expect(isStateMessage({ ...good, gu: null, metric: "count" })).toBe(true);
  });

  it("isStateMessage rejects malformed", () => {
    expect(isStateMessage(null)).toBe(false);
    expect(isStateMessage("state")).toBe(false);
    expect(isStateMessage([])).toBe(false);
    for (const key of Object.keys(good)) {
      const copy: Record<string, unknown> = { ...good };
      delete copy[key];
      expect(isStateMessage(copy), `missing ${key}`).toBe(false);
    }
  });

  it("rejects another version or type", () => {
    expect(isStateMessage({ ...good, v: 2 })).toBe(false);
    expect(isStateMessage({ ...good, v: "1" })).toBe(false);
    expect(isStateMessage({ ...good, type: "hello" })).toBe(false);
  });

  it("rejects a numeric gu and bad field values", () => {
    expect(isStateMessage({ ...good, gu: 11680 })).toBe(false);
    expect(isStateMessage({ ...good, gu: "" })).toBe(false);
    expect(isStateMessage({ ...good, metric: "area" })).toBe(false);
    expect(isStateMessage({ ...good, month: "2026-11" })).toBe(false);
    expect(isStateMessage({ ...good, ts: Number.NaN })).toBe(false);
    expect(isStateMessage({ ...good, ts: "1" })).toBe(false);
  });
});
