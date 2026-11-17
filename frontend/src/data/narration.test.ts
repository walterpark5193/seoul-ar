import { describe, expect, it } from "vitest";
import { NARRATION_ALL, isNarration, modelLabel, narrationText } from "./narration";

const good = { v: 1 as const, month: "202611", generatedAt: "2026-11-17T07:00:00.000Z", model: "anthropic.claude-haiku-5-5", items: { "서울 전체": "11월 서울 매매 1,014건.", 강남구: "강남구 11월: ㎡당 중앙값 1,564만원." } };

describe("narration", () => {
  it("isNarration accepts the contract shape and rejects others", () => {
    expect(isNarration(good)).toBe(true);
    expect(isNarration({ ...good, items: {} })).toBe(true);
    expect(isNarration(null)).toBe(false);
    expect(isNarration("<!doctype html>")).toBe(false);
    expect(isNarration({ ...good, v: 2 })).toBe(false);
    expect(isNarration({ ...good, month: "2026-11" })).toBe(false);
    expect(isNarration({ ...good, model: 3 })).toBe(false);
    expect(isNarration({ ...good, items: [] })).toBe(false);
    expect(isNarration({ ...good, items: { 강남구: 5 } })).toBe(false);
  });

  it("narrationText picks the gu or 서울 전체, only for the same month and non-empty text", () => {
    expect(NARRATION_ALL).toBe("서울 전체");
    expect(narrationText(good, "202611", "강남구")).toBe("강남구 11월: ㎡당 중앙값 1,564만원.");
    expect(narrationText(good, "202611", null)).toBe("11월 서울 매매 1,014건.");
    expect(narrationText(good, "202611", "중구")).toBeNull();
    expect(narrationText(good, "202610", "강남구")).toBeNull();
    expect(narrationText({ ...good, items: { 강남구: "  " } }, "202611", "강남구")).toBeNull();
    expect(narrationText(null, "202611", null)).toBeNull();
  });

  it("modelLabel strips provider and profile prefixes and version suffixes", () => {
    expect(modelLabel("anthropic.claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(modelLabel("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5-20251001");
    expect(modelLabel("")).toBe("모델 정보 없음");
  });
});
