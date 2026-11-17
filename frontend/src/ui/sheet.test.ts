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

  describe("top dong list", () => {
    const dong = (name: string, medPerM2: number | null, n: number) => ({
      name, n, cancelled: 0, nApt: 0, medPerM2, medPerM2Apt: null, medAmt: 1, maxAmt: 1, usage: {},
    });
    // CONTRACTS 2.2 order: medPerM2 desc, null last.
    const many: GuData = {
      ...gangnam,
      dongs: [
        dong("대치동", 3300, 7), dong("압구정동", 3200, 3), dong("삼성동", 3000, 9), dong("청담동", 2950, 2),
        dong("역삼동", 2600, 12), dong("개포동", 2400, 5), dong("일원동", null, 1),
      ],
    };
    const rows = (html: string) =>
      [...html.matchAll(/<li class="dong[^"]*">([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!).trim());

    it("lists the top 5 dongs in the data's order for price, with value and count", () => {
      const r = rows(renderSheet(state({ metric: "price" }), many, index));
      expect(r).toHaveLength(5);
      expect(r.map((t) => t.split(" ")[1])).toEqual(["대치동", "압구정동", "삼성동", "청담동", "역삼동"]);
      expect(r[0]).toContain("3,300만원/㎡");
      expect(r[0]).toContain("7건");
      expect(r[0]).toMatch(/^1 /);
    });

    it("sorts by trade count for the count metric", () => {
      const r = rows(renderSheet(state({ metric: "count" }), many, index));
      expect(r.map((t) => t.split(" ")[1])).toEqual(["역삼동", "삼성동", "대치동", "개포동", "압구정동"]);
      expect(r[0]).toContain("12건");
      expect(r[0]).toContain("2,600만원/㎡");
    });

    it("shows 거래 없음 rows gracefully and lists fewer than 5 when there are fewer dongs", () => {
      const r = rows(renderSheet(state({ metric: "price" }), gangnam, index));
      expect(r).toHaveLength(2);
      expect(r[1]).toContain("거래 없음");
      expect(r[1]).toContain("2건");
      expect(r.join(" ")).not.toMatch(/NaN|undefined|null/);
    });

    it("keeps the same gu's held list while the next month loads, with the new month's figures", () => {
      const held = { ...many, month: "202610", total: stat({ medPerM2: 9999 }) };
      const html = renderSheet(state({ month: "202611", metric: "price" }), held, index);
      expect(rows(html)).toHaveLength(5);
      expect(text(html)).toContain("2026년 11월");
      expect(text(html)).toContain("2,890만원/㎡");
      expect(text(html)).not.toContain("9,999만원/㎡");
    });

    it("omits the list for Seoul overview, while loading, and for a gu with no dongs", () => {
      expect(rows(renderSheet(state({ gu: null }), null, index))).toHaveLength(0);
      expect(rows(renderSheet(state(), null, index))).toHaveLength(0);
      expect(rows(renderSheet(state(), { ...gangnam, dongs: [] }, index))).toHaveLength(0);
      expect(rows(renderSheet(state({ gu: "중구" }), many, index))).toHaveLength(0);
    });

    it("titles the list by metric", () => {
      expect(text(renderSheet(state({ metric: "price" }), many, index))).toContain("㎡당 중앙값 상위 법정동");
      expect(text(renderSheet(state({ metric: "count" }), many, index))).toContain("거래가 많은 법정동");
    });
  });

  describe("AI 해설", () => {
    const narration = {
      v: 1 as const, month: "202611", generatedAt: "", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      items: { "서울 전체": "11월 서울 매매 46건입니다.", 강남구: "강남구 11월: <b>압구정동</b>이 가장 높습니다." },
    };

    it("shows the selected gu's line with the attribution, escaped", () => {
      const html = renderSheet(state(), gangnam, index, { narration });
      expect(html).toContain('class="ai-note"');
      expect(text(html)).toContain("AI 해설");
      expect(text(html)).toContain("강남구 11월:");
      expect(html).toContain("&lt;b&gt;압구정동&lt;/b&gt;");
      expect(html).not.toContain("<b>압구정동</b>");
      expect(text(html)).toContain("Bedrock · claude-haiku-4-5-20251001 · 자동 생성, 참고용");
    });

    it("uses the 서울 전체 line in the overview", () => {
      expect(text(renderSheet(state({ gu: null }), null, index, { narration }))).toContain("11월 서울 매매 46건입니다.");
    });

    it("is placed under the numbers", () => {
      const html = renderSheet(state(), gangnam, index, { narration });
      expect(html.indexOf('class="figs"')).toBeLessThan(html.indexOf('class="ai-note"'));
    });

    it("hides the whole area when there is no narration, no item for the key, or another month", () => {
      expect(renderSheet(state(), gangnam, index)).not.toContain("ai-note");
      expect(renderSheet(state(), gangnam, index, { narration: null })).not.toContain("ai-note");
      expect(renderSheet(state({ gu: "도봉구" }), null, index, { narration })).not.toContain("ai-note");
      expect(renderSheet(state({ month: "202610" }), null, index, { narration })).not.toContain("ai-note");
    });
  });

  it("shows the AR tuning note under the header only when given", () => {
    const withNote = renderSheet(state(), gangnam, index, { tuningNote: "조정값 적용 중: cf=0.0001 <b>" });
    expect(withNote).toContain('class="sheet-tuning"');
    expect(text(withNote)).toContain("조정값 적용 중: cf=0.0001");
    expect(withNote).not.toContain("<b>");
    expect(renderSheet(state(), gangnam, index)).not.toContain("sheet-tuning");
  });

  it("escapes names coming from data", () => {
    const html = renderSheet(state(), gangnam, { ...index, gus: [...index.gus, "<script>"] });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>일원동</b>");
  });
});
