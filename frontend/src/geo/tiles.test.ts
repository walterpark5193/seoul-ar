import { describe, it, expect } from "vitest";
import { tileGeo } from "./tiles";
import generated from "./seoul-gu.json";

const GU_ORDER = [
  "종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구",
  "노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구",
  "관악구","서초구","강남구","송파구","강동구",
];
const GU_CODE: Record<string, string> = { 종로구:"11110", 중구:"11140", 용산구:"11170", 성동구:"11200", 광진구:"11215", 동대문구:"11230", 중랑구:"11260", 성북구:"11290", 강북구:"11305", 도봉구:"11320", 노원구:"11350", 은평구:"11380", 서대문구:"11410", 마포구:"11440", 양천구:"11470", 강서구:"11500", 구로구:"11530", 금천구:"11545", 영등포구:"11560", 동작구:"11590", 관악구:"11620", 서초구:"11650", 강남구:"11680", 송파구:"11710", 강동구:"11740" };

const box = (ring: [number, number][]) => {
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
};

describe("tileGeo", () => {
  const geo = tileGeo();
  it("25구 전부, GU_ORDER 순서, 코드 일치", () => {
    expect(geo.v).toBe(1);
    expect(geo.crs).toBe("tile");
    expect(geo.gus.map((g) => g.name)).toEqual(GU_ORDER);
    for (const g of geo.gus) expect(g.code).toBe(GU_CODE[g.name]);
  });
  it("각 타일은 4점 링 하나, 한 변 0.16, 닫히지 않음", () => {
    for (const g of geo.gus) {
      expect(g.rings).toHaveLength(1);
      const r = g.rings[0]!;
      expect(r).toHaveLength(4);
      const b = box(r);
      expect(b.maxX - b.minX).toBeCloseTo(0.16, 6);
      expect(b.maxZ - b.minZ).toBeCloseTo(0.16, 6);
    }
  });
  it("타일끼리 겹치지 않는다", () => {
    const bs = geo.gus.map((g) => box(g.rings[0]!));
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!, b = bs[j]!;
        const overlap = a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9;
        expect(overlap).toBe(false);
      }
  });
  it("전체가 [-0.5,0.5]^2 안", () => {
    for (const g of geo.gus) for (const [x, z] of g.rings[0]!) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.5);
    }
  });
  it("centroid가 링 중심", () => {
    for (const g of geo.gus) {
      const b = box(g.rings[0]!);
      expect(g.centroid[0]).toBeCloseTo((b.minX + b.maxX) / 2, 6);
      expect(g.centroid[1]).toBeCloseTo((b.minZ + b.maxZ) / 2, 6);
    }
  });
  it("서울 지리 대략 확인: 도봉은 강남보다 북쪽, 강서는 강동보다 서쪽", () => {
    const c = (n: string) => geo.gus.find((g) => g.name === n)!.centroid;
    expect(c("도봉구")[1]).toBeLessThan(c("강남구")[1]);
    expect(c("강서구")[0]).toBeLessThan(c("강동구")[0]);
  });
  it("생성 파일 seoul-gu.json이 타일 버전이면 tileGeo()와 같다", () => {
    const file = generated as { crs: string; gus: { name: string }[] };
    if (file.crs === "tile") expect(file).toEqual(geo);
    expect(file.gus.map((g) => g.name)).toEqual(GU_ORDER);
  });
});
