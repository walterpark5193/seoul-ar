import { describe, it, expect } from "vitest";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Sprite,
  Texture,
  Vector3,
} from "three";
import type { Group, Object3D } from "three";
import type { Geo, GuShape } from "../geo/types";
import type { DongStat, GuData, Stat } from "../data/types";
import { createSeoulScene } from "./seoulScene";
import { PALETTE } from "./colors";
import { boundsOf, layoutBars } from "./layout";
import { canvasTextTexture } from "./labels";

// 25구 이름(CONTRACTS 1절 순서). tiles.ts(Task 2)에 기대지 않는 자체 픽스처.
const NAMES = [
  "종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구", "강북구", "도봉구",
  "노원구", "은평구", "서대문구", "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구",
  "관악구", "서초구", "강남구", "송파구", "강동구",
];

/** 5x5 정사각 타일(한 변 0.16, 간격 0.02). 강남구만 두 링(MultiPolygon 흉내). */
function fixtureGeo(): Geo {
  const tile = 0.16;
  const pitch = 0.18;
  const x0 = -0.44;
  const z0 = -0.44;
  const gus: GuShape[] = NAMES.map((name, i) => {
    const minX = x0 + (i % 5) * pitch;
    const minZ = z0 + Math.floor(i / 5) * pitch;
    const maxX = minX + tile;
    const maxZ = minZ + tile;
    const rings: [number, number][][] =
      name === "강남구"
        ? [
            [[minX, minZ], [minX + 0.07, minZ], [minX + 0.07, maxZ], [minX, maxZ]],
            [[minX + 0.09, minZ], [maxX, minZ], [maxX, maxZ], [minX + 0.09, maxZ]],
          ]
        : [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]];
    return { name, code: String(11000 + i), centroid: [(minX + maxX) / 2, (minZ + maxZ) / 2], rings };
  });
  return { v: 1, crs: "tile", gus };
}

function dong(name: string, medPerM2: number | null, n: number): DongStat {
  return { name, n, cancelled: 0, nApt: 0, medPerM2, medPerM2Apt: null, medAmt: null, maxAmt: null, usage: {} };
}

function stat(medPerM2: number | null, n: number): Stat {
  return { n, cancelled: 0, medPerM2, medAmt: null, maxAmt: null, truncated: false };
}

function gangnam(dongs?: DongStat[]): GuData {
  return {
    v: 1,
    month: "202611",
    gu: "강남구",
    generatedAt: "2026-11-17T07:00:00.000Z",
    total: stat(3000, 33),
    dongs: dongs ?? [
      dong("압구정동", 4200, 3),
      dong("청담동", 3900, 4),
      dong("대치동", 3300, 7),
      dong("삼성동", 2800, 5),
      dong("역삼동", 2500, 12),
      dong("개포동", null, 2),
    ],
  };
}

const camera = new PerspectiveCamera();
const noText = { makeTextTexture: () => null };

function guMeshes(group: Group): Mesh[] {
  return group.children.filter((c): c is Mesh => (c as Mesh).isMesh === true && typeof c.userData.gu === "string");
}
function guMesh(group: Group, name: string): Mesh {
  const m = guMeshes(group).find((c) => c.name === name);
  if (!m) throw new Error(`no mesh for ${name}`);
  return m;
}
function bars(group: Group): InstancedMesh {
  const b = group.children.find((c) => (c as InstancedMesh).isInstancedMesh === true);
  if (!b) throw new Error("no bars InstancedMesh");
  return b as InstancedMesh;
}
function colorOf(m: Mesh): number {
  return (m.material as MeshStandardMaterial).color.getHex();
}
function hex(s: string): number {
  return new Color(s).getHex();
}
function sprites(root: Object3D): Sprite[] {
  const out: Sprite[] = [];
  root.traverse((o) => {
    if ((o as Sprite).isSprite) out.push(o as Sprite);
  });
  return out;
}
function instance(b: InstancedMesh, i: number): { pos: Vector3; scale: Vector3 } {
  const m = new Matrix4();
  b.getMatrixAt(i, m);
  const pos = new Vector3();
  const scale = new Vector3();
  m.decompose(pos, new Quaternion(), scale);
  return { pos, scale };
}

describe("createSeoulScene", () => {
  it("puts 25 gu meshes (GU order, one material each) in group.children", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const meshes = guMeshes(s.group);
    expect(meshes.map((m) => m.name)).toEqual(NAMES);
    const mats = new Set(meshes.map((m) => m.material));
    expect(mats.size).toBe(25);
    for (const m of meshes) {
      expect(m.material).toBeInstanceOf(MeshStandardMaterial);
      expect(m.geometry.getAttribute("position").count).toBeGreaterThan(0);
      expect(m.position.y).toBe(0);
      expect(colorOf(m)).toBe(hex(PALETTE.guBase));
    }
  });

  it("keeps lights (and the directional light target) inside group", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    expect(s.group.children.some((c) => c instanceof HemisphereLight)).toBe(true);
    const dir = s.group.children.find((c): c is DirectionalLight => c instanceof DirectionalLight);
    expect(dir).toBeDefined();
    expect(dir!.target.parent).toBe(s.group);
  });

  it("lays gu geometry on XZ: x east, z south, y 0..0.02", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const g = guMesh(s.group, "종로구").geometry; // 북서쪽 첫 타일 x,z ∈ [-0.44, -0.28]
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.min.x).toBeCloseTo(-0.44, 6);
    expect(bb.max.x).toBeCloseTo(-0.28, 6);
    expect(bb.min.z).toBeCloseTo(-0.44, 6);
    expect(bb.max.z).toBeCloseTo(-0.28, 6);
    expect(bb.min.y).toBeCloseTo(0, 6);
    expect(bb.max.y).toBeCloseTo(0.02, 6);
  });

  it("builds one mesh from every ring of a multi-ring gu", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const g = guMesh(s.group, "강남구").geometry; // x ∈ [-0.08,-0.01] ∪ [0.01,0.08], z ∈ [0.28,0.44]
    g.computeBoundingBox();
    expect(g.boundingBox!.min.x).toBeCloseTo(-0.08, 6);
    expect(g.boundingBox!.max.x).toBeCloseTo(0.08, 6);
    expect(g.boundingBox!.min.z).toBeCloseTo(0.28, 6);
    expect(g.boundingBox!.max.z).toBeCloseTo(0.44, 6);
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i)) > 0.009).toBe(true); // 두 링 사이 틈에는 정점이 없다
    }
  });

  it("starts with no bars", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    expect(bars(s.group).count).toBe(0);
  });
});

describe("focus", () => {
  it("focus(강남구) lifts the gu to 0.03, dims the rest, and draws one bar per dong", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, { ...noText, reducedMotion: true });
    const data = gangnam();
    s.focus("강남구", data, "price");
    expect(bars(s.group).count).toBe(data.dongs.length);
    expect(guMesh(s.group, "강남구").position.y).toBeCloseTo(0.03, 10);
    expect(guMesh(s.group, "종로구").position.y).toBe(0);
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.guDim));
    expect(colorOf(guMesh(s.group, "강남구"))).not.toBe(hex(PALETTE.guDim));
  });

  it("places bars per layoutBars inside the gu bounds, standing on the lifted gu", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, { ...noText, reducedMotion: true });
    const data = gangnam();
    s.focus("강남구", data, "price");
    const ring = geo.gus.find((g) => g.name === "강남구")!.rings;
    const expected = layoutBars(data.dongs, boundsOf(ring), "price");
    const b = bars(s.group);
    expected.forEach((p, i) => {
      const { pos, scale } = instance(b, i);
      expect(pos.x).toBeCloseTo(p.x, 6);
      expect(pos.z).toBeCloseTo(p.z, 6);
      expect(scale.x).toBeCloseTo(p.size, 6);
      expect(scale.z).toBeCloseTo(p.size, 6);
      expect(scale.y).toBeCloseTo(p.height, 6);
      expect(pos.y).toBeCloseTo(0.03 + 0.02, 6); // 상승 0.03 + 돌출 0.02 위
    });
    // 인스턴스 색: 최댓값은 ramp 끝, 값 없는 동은 noData
    const c = new Color();
    b.getColorAt(0, c);
    expect(c.getHex()).toBe(hex(PALETTE.ramp[4]));
    b.getColorAt(expected.length - 1, c);
    expect(expected[expected.length - 1]!.value).toBeNull();
    expect(c.getHex()).toBe(hex(PALETTE.noData));
  });

  it("focus(null) returns to overview: bar count 0 and the gu comes back down", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.setOverview({ 종로구: stat(1000, 1), 강남구: stat(3000, 9) }, "price");
    const jongnoOverview = colorOf(guMesh(s.group, "종로구"));
    s.focus("강남구", gangnam(), "price");
    s.focus(null, null, "price");
    expect(bars(s.group).count).toBe(0);
    expect(guMesh(s.group, "강남구").position.y).toBe(0);
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(jongnoOverview);
  });

  it("unknown gu or data for another gu draws no bars", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.focus("없는구", gangnam(), "price");
    expect(bars(s.group).count).toBe(0);
    s.focus("서초구", gangnam(), "price"); // data.gu = 강남구
    expect(bars(s.group).count).toBe(0);
    expect(guMesh(s.group, "서초구").position.y).toBeCloseTo(0.03, 10);
    s.focus("서초구", null, "price"); // 로딩 중: 구만 떠오름
    expect(bars(s.group).count).toBe(0);
  });

  it("caps bars at 128 instances", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    const many = Array.from({ length: 140 }, (_, i) => dong(`동${i}`, 1000 + i, 1));
    s.focus("강남구", gangnam(many), "price");
    expect(bars(s.group).count).toBe(128);
  });
});

describe("animation", () => {
  it("rises and grows with ease-out 1-(1-t)^3 over 0.6 s", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const data = gangnam();
    s.focus("강남구", data, "price");
    const gu = guMesh(s.group, "강남구");
    const b = bars(s.group);
    expect(b.count).toBe(data.dongs.length);
    expect(gu.position.y).toBe(0);
    expect(instance(b, 0).scale.y).toBeLessThan(0.001);

    s.update(0.3, camera); // t = 0.5 → 1 - 0.5^3 = 0.875
    expect(gu.position.y).toBeCloseTo(0.03 * 0.875, 10);
    expect(instance(b, 0).scale.y).toBeCloseTo(0.35 * 0.875, 6);

    s.update(0.3, camera);
    expect(gu.position.y).toBeCloseTo(0.03, 10);
    expect(instance(b, 0).scale.y).toBeCloseTo(0.35, 6);

    s.update(1, camera);
    expect(gu.position.y).toBeCloseTo(0.03, 10);
  });

  it("animates the previous gu back down when focus moves", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.focus("강남구", gangnam(), "price");
    s.update(0.6, camera);
    s.focus("서초구", null, "price");
    s.update(0.3, camera);
    expect(guMesh(s.group, "강남구").position.y).toBeCloseTo(0.03 * (1 - 0.875), 10);
    expect(guMesh(s.group, "서초구").position.y).toBeCloseTo(0.03 * 0.875, 10);
  });

  it("reducedMotion applies the final state immediately", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.focus("강남구", gangnam(), "price");
    expect(instance(bars(s.group), 0).scale.y).toBeCloseTo(0.35, 6);
  });

  it("repeating the same focus or metric does not restart growth (state messages repeat)", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const data = gangnam();
    s.focus("강남구", data, "price");
    s.update(0.3, camera);
    const b = bars(s.group);
    const mid = instance(b, 0).scale.y;
    s.focus("강남구", data, "price");
    s.setMetric("price");
    expect(instance(b, 0).scale.y).toBeCloseTo(mid, 10);
    s.update(0.3, camera);
    expect(instance(b, 0).scale.y).toBeCloseTo(0.35, 6);
    // 새 데이터 객체(다른 달, 값은 같음)는 0부터 다시 자라지 않고 지금 높이에서 보간한다(CONTRACTS 11)
    s.focus("강남구", gangnam(), "price");
    expect(instance(b, 0).scale.y).toBeCloseTo(0.35, 6);
  });

  it("ignores bad dt values", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.focus("강남구", gangnam(), "price");
    s.update(Number.NaN, camera);
    s.update(-1, camera);
    expect(guMesh(s.group, "강남구").position.y).toBe(0);
  });
});

describe("setOverview / setMetric", () => {
  it("setOverview recolors the 25 gu materials by value", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const summary: Record<string, Stat> = {};
    NAMES.forEach((name, i) => (summary[name] = stat(1000 + i * 100, 50 - i)));
    delete summary["중구"];
    s.setOverview(summary, "price");
    s.update(0.6, camera); // 구 색은 보간된다(CONTRACTS 11)
    const jongno = colorOf(guMesh(s.group, "종로구"));
    const gangdong = colorOf(guMesh(s.group, "강동구"));
    expect(jongno).not.toBe(gangdong);
    expect(jongno).toBe(hex(PALETTE.ramp[0])); // 최솟값
    expect(gangdong).toBe(hex(PALETTE.ramp[4])); // 최댓값
    expect(colorOf(guMesh(s.group, "중구"))).toBe(hex(PALETTE.noData));

    s.setMetric("count"); // n은 종로구가 최대
    s.update(0.6, camera);
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.ramp[4]));
    expect(colorOf(guMesh(s.group, "강동구"))).toBe(hex(PALETTE.ramp[0]));
  });

  it("price null in summary shows noData", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.setOverview({ 종로구: stat(null, 0), 중구: stat(2000, 3), 용산구: stat(4000, 1) }, "price");
    s.update(0.6, camera);
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.noData));
    expect(colorOf(guMesh(s.group, "중구"))).toBe(hex(PALETTE.ramp[0]));
  });

  it("setOverview while focused keeps the focus look until focus(null)", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.focus("강남구", gangnam(), "price");
    s.setOverview({ 종로구: stat(1000, 1), 중구: stat(3000, 1) }, "price");
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.guDim));
    s.focus(null, null, "price");
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.ramp[0]));
  });

  it("setMetric redraws the focused gu bars with the new metric", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, { ...noText, reducedMotion: true });
    const data = gangnam();
    s.focus("강남구", data, "price");
    s.setMetric("count");
    const ring = geo.gus.find((g) => g.name === "강남구")!.rings;
    const expected = layoutBars(data.dongs, boundsOf(ring), "count");
    expect(expected[0]!.name).toBe("역삼동");
    const b = bars(s.group);
    expect(b.count).toBe(data.dongs.length);
    expected.forEach((p, i) => {
      const { pos, scale } = instance(b, i);
      expect(pos.x).toBeCloseTo(p.x, 6);
      expect(pos.z).toBeCloseTo(p.z, 6);
      expect(scale.y).toBeCloseTo(p.height, 6);
    });
  });
});

describe("time travel morph (CONTRACTS 11)", () => {
  // 10월: 개포동 있음. 11월: 개포동 사라짐, 세곡동 새로 생김, 대치동이 3위 → 1위(칸 이동).
  const october = (): GuData => ({
    ...gangnam([
      dong("압구정동", 4200, 3),
      dong("청담동", 3900, 4),
      dong("대치동", 3300, 7),
      dong("삼성동", 2800, 5),
      dong("역삼동", 2500, 12),
      dong("개포동", 2200, 2),
    ]),
    month: "202610",
  });
  const november = (): GuData =>
    gangnam([
      dong("대치동", 4400, 9),
      dong("압구정동", 4000, 2),
      dong("청담동", 3600, 4),
      dong("삼성동", 2900, 6),
      dong("역삼동", 2600, 10),
      dong("세곡동", 2000, 3),
    ]);
  const gangnamRings = () => fixtureGeo().gus.find((g) => g.name === "강남구")!.rings;
  const slot = (data: GuData, name: string) =>
    layoutBars(data.dongs, boundsOf(gangnamRings()), "price").find((p) => p.name === name)!;

  function names(b: InstancedMesh): string[] {
    return (b.userData.names as string[]).slice(0, b.count);
  }
  function byName(b: InstancedMesh, name: string): { pos: Vector3; scale: Vector3; color: Color } {
    const i = names(b).indexOf(name);
    if (i < 0) throw new Error(`no bar ${name}`);
    const color = new Color();
    b.getColorAt(i, color);
    return { ...instance(b, i), color };
  }
  function settled() {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.focus("강남구", october(), "price");
    s.update(0.6, camera);
    return s;
  }

  it("bars expose instance → dong name in userData.names", () => {
    const s = settled();
    const b = bars(s.group);
    expect(names(b)).toEqual(layoutBars(october().dongs, boundsOf(gangnamRings()), "price").map((p) => p.name));
  });

  it("month switch interpolates a matched dong's height and slides it to its new slot", () => {
    const s = settled();
    const b = bars(s.group);
    const from = slot(october(), "대치동");
    const to = slot(november(), "대치동");
    expect(to.height).toBeGreaterThan(from.height);
    expect(to.x).not.toBeCloseTo(from.x, 3); // 칸이 바뀐다
    expect(byName(b, "대치동").scale.y).toBeCloseTo(from.height, 6);

    s.focus("강남구", november(), "price");
    // 0으로 돌아가지 않는다: 같은 동은 지금 높이에서 출발
    expect(byName(b, "대치동").scale.y).toBeCloseTo(from.height, 6);
    expect(byName(b, "대치동").pos.x).toBeCloseTo(from.x, 6);

    s.update(0.3, camera); // e = 0.875
    const mid = byName(b, "대치동");
    expect(mid.scale.y).toBeCloseTo(from.height + (to.height - from.height) * 0.875, 6);
    expect(mid.scale.y).toBeGreaterThan(from.height);
    expect(mid.scale.y).toBeLessThan(to.height);
    expect(mid.pos.x).toBeCloseTo(from.x + (to.x - from.x) * 0.875, 6);

    s.update(0.3, camera);
    const end = byName(b, "대치동");
    expect(end.scale.y).toBeCloseTo(to.height, 6);
    expect(end.pos.x).toBeCloseTo(to.x, 6);
    expect(end.pos.z).toBeCloseTo(to.z, 6);
    expect(end.scale.x).toBeCloseTo(to.size, 6);
    // 구는 그대로 떠 있다(구가 바뀐 것이 아님)
    expect(guMesh(s.group, "강남구").position.y).toBeCloseTo(0.03, 10);
  });

  it("a dong missing from the new month shrinks to 0.02, then leaves the instanced set", () => {
    const s = settled();
    const b = bars(s.group);
    const start = slot(october(), "개포동").height;
    s.focus("강남구", november(), "price");
    expect(b.count).toBe(7); // 대상 6 + 떠나는 1
    expect(names(b)[6]).toBe("개포동");
    expect(byName(b, "개포동").scale.y).toBeCloseTo(start, 6);
    s.update(0.3, camera);
    expect(byName(b, "개포동").scale.y).toBeCloseTo(start + (0.02 - start) * 0.875, 6);
    s.update(0.3, camera);
    expect(b.count).toBe(6);
    expect(names(b)).not.toContain("개포동");
    expect(names(b)).toEqual(layoutBars(november().dongs, boundsOf(gangnamRings()), "price").map((p) => p.name));
  });

  it("a dong new in the target starts near 0.02 (noData) and grows", () => {
    const s = settled();
    const b = bars(s.group);
    s.focus("강남구", november(), "price");
    const born = byName(b, "세곡동");
    expect(born.scale.y).toBeCloseTo(0.02, 6);
    expect(born.color.getHex()).toBe(hex(PALETTE.noData));
    s.update(0.6, camera);
    expect(byName(b, "세곡동").scale.y).toBeCloseTo(slot(november(), "세곡동").height, 6);
  });

  it("bar colors change gradually", () => {
    const s = settled();
    const b = bars(s.group);
    const c0 = byName(b, "대치동").color; // 10월: 램프 중간
    s.focus("강남구", november(), "price");
    s.update(0.15, camera);
    const cMid = byName(b, "대치동").color;
    s.update(0.45, camera);
    const c1 = byName(b, "대치동").color; // 11월: 최댓값 → 램프 끝
    expect(c1.getHex()).toBe(hex(PALETTE.ramp[4]));
    expect(cMid.getHex()).not.toBe(c0.getHex());
    expect(cMid.getHex()).not.toBe(c1.getHex());
    for (const k of ["r", "g", "b"] as const) {
      expect(cMid[k]).toBeGreaterThanOrEqual(Math.min(c0[k], c1[k]) - 1e-6);
      expect(cMid[k]).toBeLessThanOrEqual(Math.max(c0[k], c1[k]) + 1e-6);
    }
  });

  it("reducedMotion applies the new month immediately (no leaving bars)", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.focus("강남구", october(), "price");
    s.focus("강남구", november(), "price");
    const b = bars(s.group);
    const expected = layoutBars(november().dongs, boundsOf(gangnamRings()), "price");
    expect(b.count).toBe(6);
    expect(names(b)).toEqual(expected.map((p) => p.name));
    expected.forEach((p, i) => {
      const { pos, scale } = instance(b, i);
      expect(pos.x).toBeCloseTo(p.x, 6);
      expect(scale.y).toBeCloseTo(p.height, 6);
    });
    const c = new Color();
    b.getColorAt(0, c);
    expect(c.getHex()).toBe(hex(PALETTE.ramp[4]));
  });

  it("a gu change still rises/falls and regrows from zero", () => {
    const s = settled();
    const seocho: GuData = { ...gangnam([dong("서초동", 3000, 5), dong("반포동", 5000, 8)]), gu: "서초구" };
    s.focus("서초구", seocho, "price");
    const b = bars(s.group);
    expect(b.count).toBe(2);
    expect(names(b)).toEqual(["반포동", "서초동"]);
    expect(instance(b, 0).scale.y).toBeLessThan(0.001);
    s.update(0.3, camera);
    expect(guMesh(s.group, "서초구").position.y).toBeCloseTo(0.03 * 0.875, 10);
    expect(guMesh(s.group, "강남구").position.y).toBeCloseTo(0.03 * 0.125, 10);
    expect(instance(b, 0).scale.y).toBeCloseTo(0.35 * 0.875, 6);
  });

  it("losing the data for the same gu shrinks every bar out", () => {
    const s = settled();
    const b = bars(s.group);
    s.focus("강남구", null, "price"); // 다음 달 로드 실패
    expect(b.count).toBe(6);
    s.update(0.6, camera);
    expect(b.count).toBe(0);
  });

  it("setOverview interpolates gu colors from current to target", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    const s1 = { 종로구: stat(1000, 1), 강동구: stat(3000, 1) };
    const s2 = { 종로구: stat(3000, 1), 강동구: stat(1000, 1) };
    s.setOverview(s1, "price");
    s.update(0.6, camera);
    const jongno = () => (guMesh(s.group, "종로구").material as MeshStandardMaterial).color.clone();
    const c0 = jongno();
    expect(c0.getHex()).toBe(hex(PALETTE.ramp[0]));
    s.setOverview(s2, "price");
    expect(jongno().getHex()).toBe(c0.getHex()); // 아직 출발점
    s.update(0.15, camera);
    const cMid = jongno();
    expect(cMid.getHex()).not.toBe(hex(PALETTE.ramp[0]));
    expect(cMid.getHex()).not.toBe(hex(PALETTE.ramp[4]));
    // 같은 요약 객체가 다시 와도 다시 시작하지 않는다
    s.setOverview(s2, "price");
    expect(jongno().getHex()).toBe(cMid.getHex());
    s.update(0.45, camera);
    expect(jongno().getHex()).toBe(hex(PALETTE.ramp[4]));
  });

  it("setOverview with reducedMotion recolors immediately", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.setOverview({ 종로구: stat(1000, 1), 강동구: stat(3000, 1) }, "price");
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.ramp[0]));
    s.setOverview({ 종로구: stat(3000, 1), 강동구: stat(1000, 1) }, "price");
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.ramp[4]));
  });
});

describe("labels", () => {
  it("default canvas texture factory returns null without document", () => {
    expect(typeof document).toBe("undefined");
    expect(canvasTextTexture("강남구", PALETTE.text)).toBeNull();
    const s = createSeoulScene(fixtureGeo()); // 기본 팩토리
    expect(() => s.focus("강남구", gangnam(), "price")).not.toThrow();
    expect(sprites(s.group)).toHaveLength(0);
  });

  it("injected factory: gu name + top 5 dongs as sprites, removed on focus(null)", () => {
    const calls: [string, string][] = [];
    const s = createSeoulScene(fixtureGeo(), {
      reducedMotion: true,
      makeTextTexture: (text, color) => {
        calls.push([text, color]);
        const t = new Texture();
        t.image = { width: 256, height: 64 };
        return t;
      },
    });
    s.focus("강남구", gangnam(), "price");
    expect(sprites(s.group)).toHaveLength(6);
    const texts = calls.map(([t]) => t);
    expect(texts.some((t) => t.includes("강남구"))).toBe(true);
    for (const name of ["압구정동", "청담동", "대치동", "삼성동", "역삼동"]) {
      expect(texts.some((t) => t.includes(name))).toBe(true);
    }
    expect(texts.some((t) => t.includes("개포동"))).toBe(false); // 값 없는 동은 상위 5 밖
    expect(calls.every(([, c]) => c === PALETTE.text)).toBe(true);
    s.update(0.016, camera);
    s.focus(null, null, "price");
    expect(sprites(s.group)).toHaveLength(0);
  });
});

describe("dispose", () => {
  it("empties group.children and disposes geometries and materials", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.focus("강남구", gangnam(), "price");
    let disposed = 0;
    for (const m of guMeshes(s.group)) {
      m.geometry.addEventListener("dispose", () => disposed++);
      (m.material as MeshStandardMaterial).addEventListener("dispose", () => disposed++);
    }
    s.dispose();
    expect(s.group.children).toHaveLength(0);
    expect(disposed).toBe(50);
    // 이후 호출은 조용히 무시
    expect(() => {
      s.update(0.1, camera);
      s.focus("강남구", gangnam(), "price");
      s.setOverview({}, "price");
      s.setMetric("count");
      s.dispose();
    }).not.toThrow();
    expect(s.group.children).toHaveLength(0);
  });
});
