import { describe, expect, it } from "vitest";
import { renderSheet } from "./sheet";
import type { AppState } from "../state/store";
import type { DataIndex, GuData, Stat } from "../data/types";

const stat = (over: Partial<Stat> = {}): Stat => ({
  n: 34, cancelled: 2, medPerM2: 2890, medAmt: 180000, maxAmt: 526000, truncated: false, ...over,
});
const empty: Stat = { n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null, truncated: false };

const index: DataIndex = {
  v: 1,
  generatedAt: "2026-11-17T07:00:00.000Z",
  source: "서울 열린데이터광장 부동산 실거래가(tbLnOpendataRtmsV)",
  months: ["202610", "202611"],
  gus: ["중구", "강남구", "도봉구"],
  summary: {
    "202611": { 중구: stat({ n: 12, medPerM2: 1500, maxAmt: 90000 }), 강남구: stat(), 도봉구: empty },
  },
};

const gangnam: GuData = {
  v: 1, month: "202611", gu: "강남구", generatedAt: index.generatedAt, total: stat(),
  dongs: [
    { name: "대치동", n: 7, cancelled: 0, nApt: 5, medPerM2: 3300, medPerM2Apt: 3500, medAmt: 250000, maxAmt: 400000, usage: { 아파트: 5, 오피스텔: 2 } },
    { name: "<b>일원동</b>", n: 2, cancelled: 0, nApt: 0, medPerM2: null, medPerM2Apt: null, medAmt: 9000, maxAmt: 9000, usage: { 단독다가구: 2 } },
  ],
};

const state = (over: Partial<AppState> = {}): AppState => ({
  month: "202611", gu: "강남구", metric: "price", follow: true, conn: "open", ...over,
});

/** Visible text: tags removed, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("renderSheet", () => {
  it("shows gu name, month and formatted figures", () => {
    const t = text(renderSheet(state(), gangnam, index));
    expect(t).toContain("강남구");
    expect(t).toContain("2026년 11월");
    expect(t).toContain("2,890만원/㎡");
    expect(t).toContain("34건");
    expect(t).toContain("52.6억");
  });

  it("sheet renders 거래 없음", () => {
    const t = text(renderSheet(state({ gu: "도봉구" }), null, index));
    expect(t).toContain("도봉구");
    expect(t).toContain("거래 없음");
    expect(t).not.toMatch(/NaN|Infinity|undefined|null/);
  });

  it("falls back to the index summary while gu data is loading", () => {
    const t = text(renderSheet(state(), null, index));
    expect(t).toContain("2,890만원/㎡");
    expect(t).toContain("52.6억");
  });

  it("shows a Seoul-wide view when no gu is selected", () => {
    const t = text(renderSheet(state({ gu: null }), null, index));
    expect(t).toContain("서울 전체");
    expect(t).toContain("46건");
    expect(t).toContain("52.6억");
  });

  it("reads 거래 없음 when the index has no month at all", () => {
    const t = text(renderSheet(state({ month: "202501" }), null, index));
    expect(t).toContain("거래 없음");
    expect(t).not.toMatch(/NaN|Infinity|undefined/);
    expect(text(renderSheet(state(), null, null))).toContain("거래 없음");
  });

  it("shows live state while following an open connection", () => {
    const html = renderSheet(state(), gangnam, index);
    expect(text(html)).toContain("라이브");
    expect(text(html)).not.toContain("라이브로 돌아가기");
  });

  it("offers 라이브로 돌아가기 when not following", () => {
    const html = renderSheet(state({ follow: false }), gangnam, index);
    expect(text(html)).toContain("직접 보는 중");
    expect(html).toContain('data-action="follow"');
    expect(text(html)).toContain("라이브로 돌아가기");
  });

  it("says when the live connection is down or still connecting", () => {
    expect(text(renderSheet(state({ conn: "error" }), gangnam, index))).toContain("연결 끊김");
    expect(text(renderSheet(state({ conn: "connecting" }), gangnam, index))).toContain("연결 중");
  });

  it("marks the active metric with aria-pressed, not color alone", () => {
    const html = renderSheet(state({ metric: "count" }), gangnam, index);
    expect(html).toMatch(/data-value="count"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-value="price"[^>]*aria-pressed="false"/);
  });

  it("renders the optional alternate view link", () => {
    const html = renderSheet(state(), gangnam, index, { altView: { href: "#/3d", label: "3D로 보기" } });
    expect(html).toContain('href="#/3d"');
    expect(text(html)).toContain("3D로 보기");
  });

  it("escapes names coming from data", () => {
    const html = renderSheet(state(), gangnam, { ...index, gus: [...index.gus, "<script>"] });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>일원동</b>");
  });
});
