import { describe, it, expect } from "vitest";
import type { Stat } from "../data/types";
import { SPREAD_ANGLE_DEG, SPREAD_MAX_H, SPREAD_MIN_H, SPREAD_RADIUS, spreadLayout } from "./spreadLayout";

// 25구 이름(CONTRACTS 1절 순서)
const GUS = [
  "종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구", "강북구", "도봉구",
  "노원구", "은평구", "서대문구", "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구",
  "관악구", "서초구", "강남구", "송파구", "강동구",
] as const;

const RAD = Math.PI / 180;
const XMAX = 0.9 * Math.sin(50 * RAD);
const ZMAX = 0.9 * (1 - Math.cos(50 * RAD));

function stat(medPerM2: number | null, n: number): Stat {
  return { n, cancelled: 0, medPerM2, medAmt: null, maxAmt: null, truncated: false };
}

/** 가격은 뒤로 갈수록 비싸고(강동구 최고), 건수는 앞일수록 많다(종로구 최다). */
function fullSummary(): Record<string, Stat> {
  const s: Record<string, Stat> = {};
  GUS.forEach((gu, i) => (s[gu] = stat(1000 + i * 100, 50 - i)));
  return s;
}

describe("spreadLayout", () => {
  it("exports the contract constants", () => {
    expect(SPREAD_RADIUS).toBe(0.9);
    expect(SPREAD_ANGLE_DEG).toBe(50);
    expect(SPREAD_MIN_H).toBe(0.02);
    expect(SPREAD_MAX_H).toBe(0.3);
  });

  it("returns 25 slots, one per gu", () => {
    const slots = spreadLayout(fullSummary(), "price", GUS);
    expect(slots).toHaveLength(25);
    expect(new Set(slots.map((s) => s.gu))).toEqual(new Set(GUS));
  });

  it("puts rank 1 leftmost (min x) and ranks rise left to right", () => {
    const slots = spreadLayout(fullSummary(), "price", GUS);
    expect(slots[0]!.gu).toBe("강동구");
    expect(slots[0]!.rank).toBe(1);
    expect(slots[0]!.value).toBe(1000 + 24 * 100);
    expect(slots[0]!.x).toBeCloseTo(-XMAX, 12);
    expect(Math.min(...slots.map((s) => s.x))).toBe(slots[0]!.x);
    expect(slots[24]!.gu).toBe("종로구");
    expect(slots[24]!.x).toBeCloseTo(XMAX, 12);
    slots.forEach((s, i) => {
      expect(s.rank).toBe(i + 1);
      if (i > 0) expect(s.x).toBeGreaterThan(slots[i - 1]!.x);
    });
  });

  it("stays on the arc: θ = -50° + 100°·i/24, x = R·sinθ within ±0.9·sin50°, z = R·(1-cosθ) within 0..0.9(1-cos50°)", () => {
    const slots = spreadLayout(fullSummary(), "price", GUS);
    slots.forEach((s, i) => {
      const theta = (-50 + (100 * i) / 24) * RAD;
      expect(s.x).toBeCloseTo(0.9 * Math.sin(theta), 12);
      expect(s.z).toBeCloseTo(0.9 * (1 - Math.cos(theta)), 12);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(XMAX + 1e-12);
      expect(s.z).toBeGreaterThanOrEqual(-1e-12);
      expect(s.z).toBeLessThanOrEqual(ZMAX + 1e-12);
    });
    expect(slots[12]!.x).toBeCloseTo(0, 12); // 가운데(13위)가 원점
    expect(slots[12]!.z).toBeCloseTo(0, 12);
    expect(slots[0]!.z).toBeCloseTo(ZMAX, 12);
    expect(slots[24]!.z).toBeCloseTo(ZMAX, 12);
  });

  it("height = 0.02 + 0.28·value/max, within 0.02..0.30", () => {
    const slots = spreadLayout(fullSummary(), "price", GUS);
    const max = 1000 + 24 * 100;
    for (const s of slots) {
      expect(s.height).toBeCloseTo(0.02 + 0.28 * (s.value! / max), 12);
      expect(s.height).toBeGreaterThanOrEqual(SPREAD_MIN_H);
      expect(s.height).toBeLessThanOrEqual(SPREAD_MAX_H);
    }
    expect(slots[0]!.height).toBeCloseTo(0.3, 12);
  });

  it("null values last: rank null, MIN height, after every valued gu, in gus order", () => {
    const summary = fullSummary();
    delete summary["마포구"]; // 요약에 없음
    summary["용산구"] = stat(null, 3); // 가격 없음
    summary["중구"] = stat(Number.NaN, 1); // 유한하지 않은 값도 없음으로
    const slots = spreadLayout(summary, "price", GUS);
    expect(slots).toHaveLength(25);
    const tail = slots.slice(22);
    expect(tail.map((s) => s.gu)).toEqual(["중구", "용산구", "마포구"]); // gus 순서
    for (const s of tail) {
      expect(s.rank).toBeNull();
      expect(s.value).toBeNull();
      expect(s.height).toBe(SPREAD_MIN_H);
    }
    slots.slice(0, 22).forEach((s, i) => {
      expect(s.rank).toBe(i + 1);
      expect(s.value).not.toBeNull();
    });
    expect(tail[2]!.x).toBeCloseTo(XMAX, 12); // 값 없는 구가 오른쪽 끝
  });

  it("count metric sorts by n", () => {
    const summary = fullSummary();
    summary["강동구"] = stat(9999, 0); // 건수 0은 값 0(순위 있음, 최소 높이)
    const slots = spreadLayout(summary, "count", GUS);
    expect(slots[0]!.gu).toBe("종로구");
    expect(slots[0]!.value).toBe(50);
    expect(slots[0]!.height).toBeCloseTo(0.3, 12);
    const last = slots[24]!;
    expect(last.gu).toBe("강동구");
    expect(last.value).toBe(0);
    expect(last.rank).toBe(25);
    expect(last.height).toBe(SPREAD_MIN_H);
  });

  it("ties keep gus order", () => {
    const summary: Record<string, Stat> = {};
    for (const gu of GUS) summary[gu] = stat(2000, 1);
    summary["강남구"] = stat(3000, 1);
    const slots = spreadLayout(summary, "price", GUS);
    expect(slots.map((s) => s.gu)).toEqual(["강남구", ...GUS.filter((g) => g !== "강남구")]);
  });

  it("max <= 0 gives MIN height to every gu", () => {
    const summary: Record<string, Stat> = {};
    for (const gu of GUS) summary[gu] = stat(null, 0);
    const slots = spreadLayout(summary, "count", GUS);
    expect(slots.map((s) => s.gu)).toEqual([...GUS]);
    for (const s of slots) {
      expect(s.height).toBe(SPREAD_MIN_H);
      expect(s.value).toBe(0);
    }
    expect(slots[0]!.rank).toBe(1);
  });

  it("one gu sits at the center; no gus gives no slots; gus outside the list are ignored", () => {
    const one = spreadLayout(fullSummary(), "price", ["강남구"]);
    expect(one).toHaveLength(1);
    expect(one[0]!.x).toBe(0);
    expect(one[0]!.z).toBe(0);
    expect(one[0]!.rank).toBe(1);
    expect(one[0]!.height).toBeCloseTo(0.3, 12);
    expect(spreadLayout(fullSummary(), "price", [])).toEqual([]);
  });
});
