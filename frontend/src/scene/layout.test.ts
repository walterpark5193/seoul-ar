import { describe, it, expect } from "vitest";
import type { DongStat } from "../data/types";
import { boundsOf, heightFor, metricValue, layoutBars } from "./layout";
import type { Bounds } from "./layout";

function dong(name: string, medPerM2: number | null, n = 1): DongStat {
  return { name, n, cancelled: 0, nApt: 0, medPerM2, medPerM2Apt: null, medAmt: null, maxAmt: null, usage: {} };
}

describe("boundsOf", () => {
  it("covers every point of every ring", () => {
    const b = boundsOf([
      [[0.1, 0.2], [0.3, 0.2], [0.3, 0.4]],
      [[-0.2, 0.25], [0.0, -0.1], [0.05, 0.3]],
    ]);
    expect(b).toEqual({ minX: -0.2, minZ: -0.1, maxX: 0.3, maxZ: 0.4 });
  });

  it("returns a zero box for no points instead of Infinity", () => {
    expect(boundsOf([])).toEqual({ minX: 0, minZ: 0, maxX: 0, maxZ: 0 });
    expect(boundsOf([[]])).toEqual({ minX: 0, minZ: 0, maxX: 0, maxZ: 0 });
  });
});

describe("metricValue", () => {
  it("price uses medPerM2, count uses n", () => {
    const d = dong("대치동", 3300, 7);
    expect(metricValue(d, "price")).toBe(3300);
    expect(metricValue(d, "count")).toBe(7);
    expect(metricValue(dong("x", null, 2), "price")).toBeNull();
  });
});

describe("heightFor", () => {
  it("heightFor(null, …) = 0.02", () => {
    expect(heightFor(null, 100)).toBe(0.02);
  });
  it("heightFor(max, max) = 0.35", () => {
    expect(heightFor(100, 100)).toBeCloseTo(0.35, 10);
    expect(heightFor(3300, 3300)).toBeCloseTo(0.35, 10);
  });
  it("heightFor(x, 0) = 0.02 (max <= 0)", () => {
    expect(heightFor(50, 0)).toBe(0.02);
    expect(heightFor(50, -1)).toBe(0.02);
  });
  it("is linear in between", () => {
    expect(heightFor(50, 100)).toBeCloseTo(0.02 + 0.33 * 0.5, 10);
    expect(heightFor(0, 100)).toBeCloseTo(0.02, 10);
  });
  it("stays inside 0.02..0.35 and never returns NaN", () => {
    expect(heightFor(250, 100)).toBeCloseTo(0.35, 10);
    expect(heightFor(-5, 100)).toBeCloseTo(0.02, 10);
    expect(heightFor(Number.NaN, 100)).toBe(0.02);
    expect(heightFor(10, Number.NaN)).toBe(0.02);
  });
});

describe("layoutBars", () => {
  const bounds: Bounds = { minX: 0.1, minZ: -0.3, maxX: 0.3, maxZ: -0.2 }; // 폭 0.2, 깊이 0.1

  it("layoutBars single: one bar at the bounds center with size > 0", () => {
    const out = layoutBars([dong("대치동", 3300, 7)], bounds, "price");
    expect(out).toHaveLength(1);
    const b = out[0]!;
    expect(b.name).toBe("대치동");
    expect(b.x).toBeCloseTo(0.2, 10);
    expect(b.z).toBeCloseTo(-0.25, 10);
    expect(b.size).toBeGreaterThan(0);
    expect(b.size).toBeCloseTo(0.1 * 0.72, 10); // 셀 = min(0.2/1, 0.1/1)
    expect(b.value).toBe(3300);
    expect(b.height).toBeCloseTo(0.35, 10);
  });

  it("layoutBars 45 dongs fit bounds: inside, size > 0, sorted desc, nulls last", () => {
    const dongs: DongStat[] = [];
    for (let i = 0; i < 45; i++) {
      // 섞인 순서 + null 몇 개
      const v = i % 9 === 4 ? null : ((i * 37) % 45) * 100 + 500;
      dongs.push(dong(`동${i}`, v, i + 1));
    }
    const out = layoutBars(dongs, bounds, "price");
    expect(out).toHaveLength(45);
    const cols = Math.ceil(Math.sqrt(45)); // 7
    const rows = Math.ceil(45 / cols); // 7
    const cell = Math.min(0.2 / cols, 0.1 / rows);
    const eps = 1e-12;
    for (const b of out) {
      expect(b.size).toBeGreaterThan(0);
      expect(b.size).toBeCloseTo(cell * 0.72, 12);
      expect(b.x - b.size / 2).toBeGreaterThanOrEqual(bounds.minX - eps);
      expect(b.x + b.size / 2).toBeLessThanOrEqual(bounds.maxX + eps);
      expect(b.z - b.size / 2).toBeGreaterThanOrEqual(bounds.minZ - eps);
      expect(b.z + b.size / 2).toBeLessThanOrEqual(bounds.maxZ + eps);
      expect(b.height).toBeGreaterThanOrEqual(0.02 - eps);
      expect(b.height).toBeLessThanOrEqual(0.35 + eps);
    }
    // 정렬: 값 내림차순, null은 뒤
    const values = out.map((b) => b.value);
    const firstNull = values.indexOf(null);
    expect(firstNull).toBeGreaterThan(0);
    expect(values.slice(firstNull).every((v) => v === null)).toBe(true);
    const nonNull = values.slice(0, firstNull) as number[];
    for (let i = 1; i < nonNull.length; i++) expect(nonNull[i - 1]!).toBeGreaterThanOrEqual(nonNull[i]!);
    // 가장 큰 값이 0.35, null 막대는 0.02
    expect(out[0]!.height).toBeCloseTo(0.35, 10);
    expect(out[out.length - 1]!.height).toBe(0.02);
    // 서로 겹치지 않는 셀: 모든 좌표 쌍이 다르다
    const keys = new Set(out.map((b) => `${b.x.toFixed(9)},${b.z.toFixed(9)}`));
    expect(keys.size).toBe(45);
  });

  it("fills row-major from the top-left (minX, minZ) and centers the whole grid", () => {
    // 4개 → cols 2, rows 2, 셀 = min(0.2/2, 0.1/2) = 0.05, 격자 폭 0.1을 폭 0.2 안에 가운데 정렬
    const out = layoutBars([dong("a", 4), dong("b", 3), dong("c", 2), dong("d", 1)], bounds, "price");
    expect(out.map((b) => b.name)).toEqual(["a", "b", "c", "d"]);
    expect(out[0]!.x).toBeCloseTo(0.175, 10);
    expect(out[0]!.z).toBeCloseTo(-0.275, 10);
    expect(out[1]!.x).toBeCloseTo(0.225, 10);
    expect(out[1]!.z).toBeCloseTo(-0.275, 10);
    expect(out[2]!.x).toBeCloseTo(0.175, 10);
    expect(out[2]!.z).toBeCloseTo(-0.225, 10);
    expect(out[3]!.x).toBeCloseTo(0.225, 10);
  });

  it("count metric sorts and scales by n", () => {
    const out = layoutBars([dong("a", 9000, 1), dong("b", 100, 10), dong("c", null, 5)], bounds, "count");
    expect(out.map((b) => b.name)).toEqual(["b", "c", "a"]);
    expect(out.map((b) => b.value)).toEqual([10, 5, 1]);
    expect(out[0]!.height).toBeCloseTo(0.35, 10);
    expect(out[1]!.height).toBeCloseTo(0.02 + 0.33 * 0.5, 10);
  });

  it("all-null values give 0.02 bars, empty input gives []", () => {
    const out = layoutBars([dong("a", null), dong("b", null)], bounds, "price");
    expect(out.map((b) => b.height)).toEqual([0.02, 0.02]);
    expect(layoutBars([], bounds, "price")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [dong("a", 1), dong("b", 2)];
    layoutBars(input, bounds, "price");
    expect(input.map((d) => d.name)).toEqual(["a", "b"]);
  });
});
