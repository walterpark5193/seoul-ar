import { describe, expect, it } from "vitest";
import { renderLanding } from "./landing";
import type { DataIndex, Stat } from "../data/types";

const s = (medPerM2: number | null): Stat => ({ n: 1, cancelled: 0, medPerM2, medAmt: 1, maxAmt: 1, truncated: false });

describe("renderLanding", () => {
  it("draws one skyline bar per gu, missing values included, and the two entry buttons", () => {
    const index: DataIndex = {
      v: 1, generatedAt: "", source: "서울 열린데이터광장", months: ["202611"], gus: ["중구", "강남구", "도봉구"],
      summary: { "202611": { 중구: s(1500), 강남구: s(2890), 도봉구: s(null) } },
    };
    const html = renderLanding(index);
    expect(html.match(/class="bar[ "]/g)).toHaveLength(3);
    expect(html).toContain('href="#/ar"');
    expect(html).toContain('href="#/3d"');
    expect(html).toContain('href="#/host"');
    expect(html).toContain("강남구 2,890만원/㎡");
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("renders without an index", () => {
    const html = renderLanding(null);
    expect(html.replace(/<[^>]+>/g, "")).toContain("서울이 선다");
    expect(html).not.toMatch(/NaN|undefined/);
  });
});
