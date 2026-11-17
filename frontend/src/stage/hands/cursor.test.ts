import { describe, it, expect } from "vitest";
import { createOneEuro, palmCenter, mapToScreen, toNdc, createCursorMapper } from "./cursor";
import type { Vec3 } from "../types";

function lmWith(pts: Record<number, [number, number]>): Vec3[] {
  const lm: Vec3[] = Array.from({ length: 21 }, () => [0.9, 0.9, 0] as Vec3);
  for (const [i, [x, y]] of Object.entries(pts)) lm[Number(i)] = [x, y, 0];
  return lm;
}

describe("palmCenter", () => {
  it("랜드마크 0,5,9,13,17의 x,y 평균", () => {
    const lm = lmWith({ 0: [0.1, 0.2], 5: [0.3, 0.4], 9: [0.5, 0.6], 13: [0.7, 0.8], 17: [0.4, 0.5] });
    const p = palmCenter(lm);
    expect(p.x).toBeCloseTo(0.4, 10);
    expect(p.y).toBeCloseTo(0.5, 10);
  });
});

describe("mapToScreen", () => {
  it("거울 + margin 0.1: x 0.2 -> 0.875, y 0.5 -> 0.5", () => {
    const p = mapToScreen({ x: 0.2, y: 0.5 });
    expect(p.x).toBeCloseTo(0.875, 10);
    expect(p.y).toBeCloseTo(0.5, 10);
  });
  it("가장자리는 [0,1]로 자른다", () => {
    expect(mapToScreen({ x: 0.05, y: 0.5 }).x).toBe(1);
    expect(mapToScreen({ x: 0.99, y: 0.5 }).x).toBe(0);
    expect(mapToScreen({ x: 0.5, y: -0.2 }).y).toBe(0);
  });
  it("mirror:false", () => {
    expect(mapToScreen({ x: 0.2, y: 0.5 }, { mirror: false }).x).toBeCloseTo(0.125, 10);
  });
});

describe("toNdc", () => {
  it("(0,0) -> (-1, 1), (1,1) -> (1,-1)", () => {
    expect(toNdc({ x: 0, y: 0 })).toEqual({ x: -1, y: 1 });
    const q = toNdc({ x: 1, y: 1 });
    expect(q.x).toBe(1);
    expect(q.y).toBe(-1);
  });
});

describe("createOneEuro", () => {
  it("상수 입력은 같은 값", () => {
    const f = createOneEuro();
    let y = 0;
    for (let i = 0; i < 30; i++) y = f.filter(0.42, i * 16.67);
    expect(y).toBeCloseTo(0.42, 10);
  });
  it("고주파 지터(±0.01, 60Hz) 출력 진폭이 입력의 50% 미만", () => {
    const f = createOneEuro();
    const out: number[] = [];
    for (let i = 0; i < 120; i++) out.push(f.filter(0.5 + (i % 2 ? 0.01 : -0.01), i * (1000 / 60)));
    const tail = out.slice(60);
    const amp = Math.max(...tail) - Math.min(...tail);
    expect(amp).toBeLessThan(0.02 * 0.5);
  });
  it("큰 계단 이동(100 단위)은 200ms 안에 90% 따라간다", () => {
    const f = createOneEuro();
    const dt = 1000 / 60;
    let t = 0;
    for (let i = 0; i < 30; i++, t += dt) f.filter(0, t);
    let y = 0;
    for (let k = 0; k * dt <= 200; k++, t += dt) y = f.filter(100, t);
    expect(y).toBeGreaterThanOrEqual(90);
  });
  it("reset 뒤 첫 값은 그대로 통과", () => {
    const f = createOneEuro();
    f.filter(0, 0); f.filter(0, 16);
    f.reset();
    expect(f.filter(0.8, 32)).toBe(0.8);
  });
});

describe("createCursorMapper", () => {
  it("reset 뒤 첫 값은 필터 지연 없음", () => {
    const m = createCursorMapper();
    const a = lmWith({ 0: [0.5, 0.5], 5: [0.5, 0.5], 9: [0.5, 0.5], 13: [0.5, 0.5], 17: [0.5, 0.5] });
    const b = lmWith({ 0: [0.2, 0.3], 5: [0.2, 0.3], 9: [0.2, 0.3], 13: [0.2, 0.3], 17: [0.2, 0.3] });
    m.map(a, 0); m.map(a, 16);
    m.reset();
    const p = m.map(b, 100);
    expect(p).toEqual(mapToScreen({ x: 0.2, y: 0.3 }));
  });
});

describe("createCursorMapper 기본 beta", () => {
  const flat = (x: number, y: number) => lmWith({ 0: [x, y], 5: [x, y], 9: [x, y], 13: [x, y], 17: [x, y] });
  const opts = { mirror: false, margin: 0 };
  const dt = 1000 / 60;

  it("0->1 단위 계단은 200ms 안에 90% 따라간다", () => {
    const m = createCursorMapper(opts);
    let t = 0;
    for (let i = 0; i < 30; i++, t += dt) m.map(flat(0, 0.5), t);
    let p = { x: 0, y: 0 };
    for (let k = 0; k * dt <= 200; k++, t += dt) p = m.map(flat(1, 0.5), t);
    expect(p.x).toBeGreaterThanOrEqual(0.9);
  });

  it("정지 상태 +-0.01 지터는 입력 진폭의 50% 미만으로 줄인다", () => {
    const m = createCursorMapper(opts);
    const out: number[] = [];
    for (let i = 0; i < 120; i++) out.push(m.map(flat(0.5 + (i % 2 ? 0.01 : -0.01), 0.5), i * dt).x);
    const tail = out.slice(60);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.02 * 0.5);
  });
});
