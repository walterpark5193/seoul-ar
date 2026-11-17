import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { convertGeoJson } from "./convert.mjs";
import { GU_CODE } from "./gu.mjs";

const mini = JSON.parse(readFileSync(new URL("./fixtures/mini.geojson", import.meta.url), "utf8"));
const allPts = (geo) => geo.gus.flatMap((g) => g.rings.flat());

describe("convertGeoJson", () => {
  const geo = convertGeoJson(mini);
  it("형식과 crs", () => {
    expect(geo.v).toBe(1);
    expect(geo.crs).toBe("unit-square");
  });
  it("GU_ORDER 순서(픽스처에 있는 구만), 코드 채움", () => {
    expect(geo.gus.map((g) => g.name)).toEqual(["종로구", "마포구", "강남구"]);
    for (const g of geo.gus) expect(g.code).toBe(GU_CODE[g.name]);
  });
  it("이름 속성 3가지 모두 인식", () => {
    expect(geo.gus).toHaveLength(3);
  });
  it("경계 상자가 [-0.5,0.5]^2 안, 긴 축 1.0", () => {
    const pts = allPts(geo);
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...zs) - Math.min(...zs);
    expect(Math.max(w, h)).toBeCloseTo(1, 6);
    for (const v of [...xs, ...zs]) expect(Math.abs(v)).toBeLessThanOrEqual(0.5 + 1e-9);
  });
  it("북쪽이 -z, 동쪽이 +x", () => {
    const g = (n) => geo.gus.find((x) => x.name === n);
    expect(g("종로구").centroid[1]).toBeLessThan(g("강남구").centroid[1]);
    expect(g("강남구").centroid[0]).toBeGreaterThan(g("마포구").centroid[0]);
  });
  it("링 첫 점 반복 제거, 바깥 링만", () => {
    const mapo = geo.gus.find((x) => x.name === "마포구");
    expect(mapo.rings).toHaveLength(1);
    expect(mapo.rings[0]).toHaveLength(4);
    for (const g of geo.gus) for (const r of g.rings) expect(r[0]).not.toEqual(r[r.length - 1]);
  });
  it("MultiPolygon은 링 여러 개", () => {
    expect(geo.gus.find((x) => x.name === "종로구").rings).toHaveLength(2);
  });
  it("400점 초과 링은 400 이하로 균등 추출", () => {
    const n = 1000;
    const ring = Array.from({ length: n }, (_, i) => [127 + 0.05 * Math.cos((2 * Math.PI * i) / n), 37.5 + 0.05 * Math.sin((2 * Math.PI * i) / n)]);
    ring.push(ring[0]);
    const out = convertGeoJson({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "중구" }, geometry: { type: "Polygon", coordinates: [ring] } }] });
    const len = out.gus[0].rings[0].length;
    expect(len).toBeLessThanOrEqual(400);
    expect(len).toBeGreaterThan(300);
  });
  it("centroid는 유한 숫자 쌍", () => {
    for (const g of geo.gus) for (const v of g.centroid) expect(Number.isFinite(v)).toBe(true);
  });
});
