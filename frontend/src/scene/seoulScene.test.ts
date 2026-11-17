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
    // 새 데이터 객체(다른 달)는 다시 자란다
    s.focus("강남구", gangnam(), "price");
    expect(instance(b, 0).scale.y).toBeLessThan(0.001);
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
    const jongno = colorOf(guMesh(s.group, "종로구"));
    const gangdong = colorOf(guMesh(s.group, "강동구"));
    expect(jongno).not.toBe(gangdong);
    expect(jongno).toBe(hex(PALETTE.ramp[0])); // 최솟값
    expect(gangdong).toBe(hex(PALETTE.ramp[4])); // 최댓값
    expect(colorOf(guMesh(s.group, "중구"))).toBe(hex(PALETTE.noData));

    s.setMetric("count"); // n은 종로구가 최대
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.ramp[4]));
    expect(colorOf(guMesh(s.group, "강동구"))).toBe(hex(PALETTE.ramp[0]));
  });

  it("price null in summary shows noData", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.setOverview({ 종로구: stat(null, 0), 중구: stat(2000, 3), 용산구: stat(4000, 1) }, "price");
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
