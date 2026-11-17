import type { Vec3, Point } from "../types";

export interface OneEuro { filter(x: number, tMs: number): number; reset(): void; }

const alphaFor = (cutoff: number, te: number): number => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / te);
};

export function createOneEuro(opts: { minCutoff?: number; beta?: number; dCutoff?: number } = {}): OneEuro {
  const minCutoff = opts.minCutoff ?? 1.0;
  const beta = opts.beta ?? 0.02;
  const dCutoff = opts.dCutoff ?? 1.0;
  let prevX: number | null = null;
  let prevDx = 0;
  let prevT = 0;
  return {
    filter(x, tMs) {
      if (prevX === null) {
        prevX = x; prevDx = 0; prevT = tMs;
        return x;
      }
      const te = (tMs - prevT) / 1000;
      if (!(te > 0)) return prevX; // 시간이 안 흘렀거나 역행: 이전 값 유지
      const dx = (x - prevX) / te;
      const dxHat = prevDx + alphaFor(dCutoff, te) * (dx - prevDx);
      const cutoff = minCutoff + beta * Math.abs(dxHat);
      const xHat = prevX + alphaFor(cutoff, te) * (x - prevX);
      prevX = xHat; prevDx = dxHat; prevT = tMs;
      return xHat;
    },
    reset() { prevX = null; prevDx = 0; prevT = 0; },
  };
}

const PALM = [0, 5, 9, 13, 17] as const;

export function palmCenter(lm: Vec3[]): Point {
  let x = 0, y = 0;
  for (const i of PALM) { x += lm[i]![0]; y += lm[i]![1]; }
  return { x: x / PALM.length, y: y / PALM.length };
}

export function mapToScreen(p: Point, opts: { mirror?: boolean; margin?: number } = {}): Point {
  const mirror = opts.mirror ?? true;
  const margin = opts.margin ?? 0.1;
  const f = (v: number) => Math.min(1, Math.max(0, (v - margin) / (1 - 2 * margin)));
  return { x: f(mirror ? 1 - p.x : p.x), y: f(p.y) };
}

export interface CursorMapper { map(lm: Vec3[], tMs: number): Point; reset(): void; }

export function createCursorMapper(opts: { mirror?: boolean; margin?: number; minCutoff?: number; beta?: number } = {}): CursorMapper {
  // 0..1 정규화 좌표는 속도가 작아 OneEuro 기본 beta(0.02)로는 지연이 커서 기본 3을 쓴다.
  const beta = opts.beta ?? 3;
  const fx = createOneEuro({ minCutoff: opts.minCutoff, beta });
  const fy = createOneEuro({ minCutoff: opts.minCutoff, beta });
  return {
    map(lm, tMs) {
      const s = mapToScreen(palmCenter(lm), { mirror: opts.mirror, margin: opts.margin });
      return { x: fx.filter(s.x, tMs), y: fy.filter(s.y, tMs) };
    },
    reset() { fx.reset(); fy.reset(); },
  };
}

export function toNdc(p: Point): { x: number; y: number } {
  return { x: p.x * 2 - 1, y: -(p.y * 2 - 1) };
}
