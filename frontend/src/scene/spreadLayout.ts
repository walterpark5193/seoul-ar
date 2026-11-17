// 펼치기 배치: 25구를 지표 내림차순으로 완만한 호 위에 늘어놓는 순수 함수 (CONTRACTS-stage 6.1).
// 좌표는 씬과 같다(x 동쪽, z 남쪽). 호의 가운데가 원점이고 양 끝이 +z(무대 카메라 쪽)로 휜다.
import type { Metric, Stat } from "../data/types";

export interface SpreadSlot { gu: string; x: number; z: number; height: number; rank: number | null; value: number | null; }

export const SPREAD_RADIUS = 0.9;
export const SPREAD_ANGLE_DEG = 50;
export const SPREAD_MIN_H = 0.02;
export const SPREAD_MAX_H = 0.30;

/** price → medPerM2, count → n. 요약에 없거나 유한하지 않으면 null. */
function valueOf(s: Stat | undefined, metric: Metric): number | null {
  if (!s) return null;
  const v = metric === "price" ? s.medPerM2 : s.n;
  return v !== null && Number.isFinite(v) ? v : null;
}

/** null·max<=0이면 MIN, 그 외 MIN + (MAX-MIN)·value/max. 비율은 0..1로 자른다. */
function heightOf(value: number | null, max: number): number {
  if (value === null || max <= 0) return SPREAD_MIN_H;
  const ratio = Math.min(1, Math.max(0, value / max));
  return SPREAD_MIN_H + (SPREAD_MAX_H - SPREAD_MIN_H) * ratio;
}

/**
 * 정렬: 값 내림차순, 동률·null은 gus 순서, null은 뒤(rank null). rank는 1부터 자리 순서.
 * i번째(k = gus.length) θ = -50° + 100°·i/(k-1), x = R·sinθ, z = R·(1-cosθ). 왼쪽(x<0)이 1위. k=1이면 θ=0.
 */
export function spreadLayout(summary: Record<string, Stat>, metric: Metric, gus: readonly string[]): SpreadSlot[] {
  const k = gus.length;
  const items = gus.map((gu, i) => ({ gu, i, v: valueOf(summary[gu], metric) }));
  items.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    return b.v - a.v || a.i - b.i;
  });

  let max = 0;
  for (const it of items) if (it.v !== null && it.v > max) max = it.v;

  const span = (SPREAD_ANGLE_DEG * Math.PI) / 180;
  return items.map((it, j) => {
    const theta = k > 1 ? -span + (2 * span * j) / (k - 1) : 0;
    return {
      gu: it.gu,
      x: SPREAD_RADIUS * Math.sin(theta),
      z: SPREAD_RADIUS * (1 - Math.cos(theta)),
      height: heightOf(it.v, max),
      rank: it.v === null ? null : j + 1,
      value: it.v,
    };
  });
}
