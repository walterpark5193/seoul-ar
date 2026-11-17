import { describe, expect, it } from "vitest";
import { NO_TRADE, fmtAmt, fmtCount, fmtManwon, fmtMonth, fmtPerM2 } from "./format";

describe("format", () => {
  it("fmtManwon groups thousands", () => {
    expect(fmtManwon(2890)).toBe("2,890만원");
    expect(fmtManwon(123456)).toBe("123,456만원");
    expect(fmtManwon(0)).toBe("0만원");
  });

  it("fmtPerM2 appends the area unit", () => {
    expect(fmtPerM2(2890)).toBe("2,890만원/㎡");
  });

  it("fmtAmt uses 억 at 1억 and above", () => {
    expect(fmtAmt(526000)).toBe("52.6억");
    expect(fmtAmt(180000)).toBe("18억");
    expect(fmtAmt(10000)).toBe("1억");
    expect(fmtAmt(12345678)).toBe("1,234.6억");
    expect(fmtAmt(8500)).toBe("8,500만");
  });

  it("fmtCount appends 건", () => {
    expect(fmtCount(34)).toBe("34건");
    expect(fmtCount(1234)).toBe("1,234건");
  });

  it("null and non-finite values read 거래 없음", () => {
    for (const f of [fmtManwon, fmtPerM2, fmtAmt, fmtCount]) {
      expect(f(null)).toBe(NO_TRADE);
      expect(f(Number.NaN)).toBe(NO_TRADE);
      expect(f(Number.POSITIVE_INFINITY)).toBe(NO_TRADE);
    }
    expect(NO_TRADE).toBe("거래 없음");
  });

  it("fmtMonth reads as Korean year and month", () => {
    expect(fmtMonth("202611")).toBe("2026년 11월");
    expect(fmtMonth("202609")).toBe("2026년 9월");
    expect(fmtMonth("bad")).toBe("bad");
  });
});
