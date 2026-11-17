// 법정동 막대 배치용 순수 함수 (CONTRACTS 4절).
import type { DongStat, Metric } from "../data/types";

export interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number; }
export interface BarPlacement { name: string; x: number; z: number; size: number; height: number; value: number | null; }

export const BAR_MIN_HEIGHT = 0.02;
export const BAR_MAX_HEIGHT = 0.35;
/** 0.02 + 0.33 = 0.35 (계약식 그대로) */
const BAR_RANGE = 0.33;
/** 막대 한 변 = 셀 * BAR_FILL */
export const BAR_FILL = 0.72;

/** 모든 링의 모든 점을 덮는 경계 상자. 점이 없으면 0 상자(Infinity 방지). */
export function boundsOf(rings: [number, number][][]): Bounds {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (minX > maxX || minZ > maxZ) return { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  return { minX, minZ, maxX, maxZ };
}

/** price → medPerM2, count → n */
export function metricValue(d: DongStat, metric: Metric): number | null {
  return metric === "price" ? d.medPerM2 : d.n;
}

/** null→0.02, 그 외 0.02 + 0.33*(value/max), max<=0이면 0.02. 비율은 0..1로 자른다. */
export function heightFor(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return BAR_MIN_HEIGHT;
  const ratio = Math.min(1, Math.max(0, value / max));
  return BAR_MIN_HEIGHT + BAR_RANGE * ratio;
}

function finiteOrNull(v: number | null): number | null {
  return v !== null && Number.isFinite(v) ? v : null;
}

/**
 * 격자: cols = ceil(sqrt(n)), rows = ceil(n/cols). 셀 = min(폭/cols, 깊이/rows). 막대 한 변 = 셀 * 0.72.
 * 정렬: metricValue 내림차순(null 뒤, 같으면 입력 순서). 왼쪽 위(minX, minZ)부터 행 우선, 격자 전체를 경계 상자 중앙에.
 */
export function layoutBars(dongs: DongStat[], bounds: Bounds, metric: Metric): BarPlacement[] {
  const n = dongs.length;
  if (n === 0) return [];

  const items = dongs.map((d, i) => ({ d, i, v: finiteOrNull(metricValue(d, metric)) }));
  items.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    return b.v - a.v || a.i - b.i;
  });

  let max = 0;
  for (const it of items) if (it.v !== null && it.v > max) max = it.v;

  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const cell = Math.max(0, Math.min(width / cols, depth / rows));
  const x0 = bounds.minX + (width - cols * cell) / 2;
  const z0 = bounds.minZ + (depth - rows * cell) / 2;
  const size = cell * BAR_FILL;

  return items.map((it, k) => ({
    name: it.d.name,
    x: x0 + ((k % cols) + 0.5) * cell,
    z: z0 + (Math.floor(k / cols) + 0.5) * cell,
    size,
    height: heightFor(it.v, max),
    value: it.v,
  }));
}
