import { describe, expect, it } from "vitest";
import { STAGE_QR_HINT, isStageQuery, renderStage } from "./stage";
import type { AppState } from "../state/store";
import type { DataIndex, GuData, Stat } from "../data/types";

const stat = (over: Partial<Stat> = {}): Stat => ({ n: 34, cancelled: 0, medPerM2: 2890, medAmt: 1, maxAmt: 526000, truncated: false, ...over });
const index: DataIndex = {
  v: 1, generatedAt: "", source: "", months: ["202611"], gus: ["중구", "강남구"],
  summary: { "202611": { 중구: stat({ n: 12, medPerM2: 1500, maxAmt: 90000 }), 강남구: stat() } },
};
const data: GuData = { v: 1, month: "202611", gu: "강남구", generatedAt: "", total: stat(), dongs: [] };
const state = (over: Partial<AppState> = {}): AppState => ({ month: "202611", gu: "강남구", metric: "price", follow: true, conn: "open", ...over });
const narration = { v: 1 as const, month: "202611", generatedAt: "", model: "anthropic.claude-haiku-5-5", items: { 강남구: "강남구는 <i>압구정동</i>이 가장 높습니다.", "서울 전체": "서울 46건." } };
// 인라인 span(숫자·단위)은 붙여 읽힌다: 태그는 공백 없이 지운다.
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("isStageQuery", () => {
  it("is true only for stage=1", () => {
    expect(isStageQuery("stage=1")).toBe(true);
    expect(isStageQuery("x=2&stage=1")).toBe(true);
    expect(isStageQuery("stage=0")).toBe(false);
    expect(isStageQuery("")).toBe(false);
    expect(isStageQuery(undefined)).toBe(false);
  });
});

describe("renderStage", () => {
  it("shows a big title, the month and the three big figures", () => {
    const html = renderStage(state(), data, index, null);
    const t = text(html);
    expect(html).toMatch(/<h1 class="stage-title">강남구<\/h1>/);
    expect(t).toContain("2026년 11월");
    expect(t).toContain("㎡당 중앙값");
    expect(t).toContain("2,890만원/㎡");
    expect(t).toContain("34건");
    expect(t).toContain("52.6억");
  });

  it("uses 서울 전체 in the overview", () => {
    const t = text(renderStage(state({ gu: null }), null, index, narration));
    expect(t).toContain("서울 전체");
    expect(t).toContain("46건");
    expect(t).toContain("서울 46건.");
  });

  it("shows the AI line with attribution only when there is one, escaped", () => {
    const html = renderStage(state(), data, index, narration);
    expect(html).toContain("&lt;i&gt;압구정동&lt;/i&gt;");
    expect(html).not.toContain("<i>압구정동</i>");
    expect(text(html)).toContain("Bedrock · claude-haiku-5-5 · 자동 생성, 참고용");
    expect(renderStage(state(), data, index, null)).not.toContain("ai-note");
    expect(renderStage(state({ gu: "중구" }), null, index, narration)).not.toContain("ai-note");
  });

  it("has no direct controls and says 거래 없음 without NaN", () => {
    const html = renderStage(state({ month: "202501" }), null, index, null);
    expect(html).not.toMatch(/<button|<select|data-action=/);
    expect(text(html)).toContain("거래 없음");
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("states a lost connection in words", () => {
    expect(text(renderStage(state({ conn: "error" }), data, index, null))).toContain("연결 끊김");
    expect(text(renderStage(state(), data, index, null))).not.toContain("연결 끊김");
  });

  it("has the QR hint text", () => {
    expect(STAGE_QR_HINT).toBe("폰으로 QR을 찍어 그림을 비춰 보세요");
  });
});
