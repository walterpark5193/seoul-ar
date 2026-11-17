import { describe, it, expect } from "vitest";
import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
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
import { GU_DEPTH, LAYOUT_SECONDS, LIFT_Y, createSeoulScene, easeOutCubic } from "./seoulScene";
import { spreadLayout } from "./spreadLayout";
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

// ── 무대 확장 (CONTRACTS-stage 6.2) ──────────────────────────────────────────

function priceSummary(): Record<string, Stat> {
  const s: Record<string, Stat> = {};
  NAMES.forEach((name, i) => (s[name] = stat(1000 + i * 100, 50 - i))); // 강동구 최고가, 종로구 최저가
  return s;
}
function centroidOf(geo: Geo, name: string): [number, number] {
  return geo.gus.find((g) => g.name === name)!.centroid;
}
/** 메시 변환(이동·스케일)을 거친 centroid의 월드 위치 */
function worldCentroid(m: Mesh, c: [number, number]): Vector3 {
  m.updateWorldMatrix(true, false);
  return m.localToWorld(new Vector3(c[0], 0, c[1]));
}
/** 메시 지오메트리만의 월드 경계 상자(자식 윤곽선 제외) */
function worldBox(m: Mesh): Box3 {
  m.updateWorldMatrix(true, false);
  m.geometry.computeBoundingBox();
  return m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
}
function edgeOf(m: Mesh): number {
  const o = m.getObjectByName(`${m.name}:outline`) as Mesh | undefined;
  if (!o) throw new Error(`no outline for ${m.name}`);
  return (o.material as LineBasicMaterial).color.getHex();
}
function shadowOf(group: Group): Mesh {
  const sh = group.getObjectByName("lift-shadow") as Mesh | undefined;
  if (!sh) throw new Error("no lift-shadow");
  return sh;
}
/** (x, z) 바로 위 높이 1에서 내려다보는 카메라 */
function lookDown(x: number, z: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(40, 1, 0.01, 10);
  cam.up.set(0, 0, -1);
  cam.position.set(x, 1, z);
  cam.lookAt(x, 0, z);
  return cam;
}
function labelFactory(calls?: string[]) {
  return (text: string) => {
    calls?.push(text);
    const t = new Texture();
    t.image = { width: 256, height: 64 };
    return t;
  };
}

describe("stage: lift", () => {
  it("exports LIFT_Y 0.12 and LAYOUT_SECONDS 0.8", () => {
    expect(LIFT_Y).toBe(0.12);
    expect(LAYOUT_SECONDS).toBe(0.8);
  });

  it("lift raises to LIFT_Y, dims the rest, and puts a translucent shadow disc under it", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, noText);
    s.setOverview(priceSummary(), "price");
    const own = colorOf(guMesh(s.group, "강남구"));
    s.lift("강남구");
    const m = guMesh(s.group, "강남구");
    expect(m.position.y).toBe(0);
    s.update(0.05, camera);
    expect(m.position.y).toBeGreaterThan(0);
    expect(m.position.y).toBeLessThan(LIFT_Y);
    s.update(1, camera);
    expect(m.position.y).toBeCloseTo(LIFT_Y, 10);
    expect(colorOf(m)).toBe(own); // 들어올린 구는 제 색
    expect(edgeOf(m)).toBe(hex(PALETTE.text));
    for (const other of guMeshes(s.group)) {
      if (other === m) continue;
      expect(other.position.y).toBe(0);
      expect(colorOf(other)).toBe(hex(PALETTE.guDim));
    }
    const sh = shadowOf(s.group);
    expect(sh.visible).toBe(true);
    const mat = sh.material as MeshBasicMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeGreaterThan(0);
    expect(mat.opacity).toBeLessThan(1);
    const c = centroidOf(geo, "강남구");
    expect(sh.position.x).toBeCloseTo(c[0], 6);
    expect(sh.position.z).toBeCloseTo(c[1], 6);
    expect(sh.position.y).toBeLessThan(GU_DEPTH); // 바닥
  });

  it("lift null restores height, colors and hides the shadow", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.setOverview(priceSummary(), "price");
    const before = guMeshes(s.group).map(colorOf);
    s.lift("강남구");
    s.update(1, camera);
    s.lift(null);
    s.update(1, camera);
    for (const m of guMeshes(s.group)) expect(m.position.y).toBeCloseTo(0, 10);
    expect(guMeshes(s.group).map(colorOf)).toEqual(before);
    expect(edgeOf(guMesh(s.group, "강남구"))).toBe(hex(PALETTE.bg));
    expect(shadowOf(s.group).visible).toBe(false);
    s.lift("없는구"); // 모르는 이름은 null과 같다
    expect(guMeshes(s.group).map(colorOf)).toEqual(before);
  });

  it("lift is absolute over focus and hover; focus bars ride along; release lands on focus + hover", () => {
    const s = createSeoulScene(fixtureGeo(), { ...noText, reducedMotion: true });
    s.focus("강남구", gangnam(), "price");
    s.setHover("강남구");
    s.lift("강남구");
    const m = guMesh(s.group, "강남구");
    expect(m.position.y).toBeCloseTo(LIFT_Y, 10);
    expect(instance(bars(s.group), 0).pos.y).toBeCloseTo(LIFT_Y + GU_DEPTH, 6);
    s.lift(null);
    expect(m.position.y).toBeCloseTo(0.03 + 0.01, 10); // focus 상승 + hover
    expect(instance(bars(s.group), 0).pos.y).toBeCloseTo(0.04 + GU_DEPTH, 6);
  });
});

describe("stage: setLayout", () => {
  it("setLayout spread moves each centroid to its slot over LAYOUT_SECONDS and scales height to slot.height", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, noText);
    const summary = priceSummary();
    const slots = spreadLayout(summary, "price", NAMES);
    const slot = slots.find((x) => x.gu === "강남구")!;
    const c = centroidOf(geo, "강남구");
    const m = guMesh(s.group, "강남구");
    s.setLayout("spread", summary, "price");
    expect(worldCentroid(m, c).x).toBeCloseTo(c[0], 10); // 아직 제자리
    s.update(LAYOUT_SECONDS / 2, camera);
    const e = easeOutCubic(0.5);
    const mid = worldCentroid(m, c);
    expect(mid.x).toBeCloseTo(c[0] + (slot.x - c[0]) * e, 6);
    expect(mid.z).toBeCloseTo(c[1] + (slot.z - c[1]) * e, 6);
    s.update(1, camera);
    for (const sl of slots) {
      const mesh = guMesh(s.group, sl.gu);
      const p = worldCentroid(mesh, centroidOf(geo, sl.gu));
      expect(Math.abs(p.x - sl.x)).toBeLessThan(1e-3);
      expect(Math.abs(p.z - sl.z)).toBeLessThan(1e-3);
      const box = worldBox(mesh);
      expect(box.min.y).toBeCloseTo(0, 6);
      expect(box.max.y).toBeCloseTo(sl.height, 6);
    }
  });

  it("setLayout map restores position and scale", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, noText);
    const summary = priceSummary();
    s.setLayout("spread", summary, "price");
    s.update(1, camera);
    s.setLayout("map", summary, "price");
    const m = guMesh(s.group, "강남구");
    const c = centroidOf(geo, "강남구");
    s.update(LAYOUT_SECONDS / 2, camera);
    expect(Math.abs(worldCentroid(m, c).x - c[0])).toBeGreaterThan(1e-3); // 돌아오는 중
    s.update(1, camera);
    for (const mesh of guMeshes(s.group)) {
      expect(mesh.position.x).toBeCloseTo(0, 10);
      expect(mesh.position.y).toBeCloseTo(0, 10);
      expect(mesh.position.z).toBeCloseTo(0, 10);
      expect(mesh.scale.x).toBeCloseTo(1, 10);
      expect(mesh.scale.y).toBeCloseTo(1, 10);
      expect(mesh.scale.z).toBeCloseTo(1, 10);
    }
    const box = worldBox(guMesh(s.group, "종로구"));
    expect(box.min.x).toBeCloseTo(-0.44, 6);
    expect(box.max.y).toBeCloseTo(GU_DEPTH, 6);
  });

  it("reducedMotion applies layout and lift instantly", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, { ...noText, reducedMotion: true });
    const summary = priceSummary();
    const slot = spreadLayout(summary, "price", NAMES).find((x) => x.gu === "강남구")!;
    const m = guMesh(s.group, "강남구");
    s.setLayout("spread", summary, "price");
    const p = worldCentroid(m, centroidOf(geo, "강남구"));
    expect(Math.abs(p.x - slot.x)).toBeLessThan(1e-3);
    expect(Math.abs(p.z - slot.z)).toBeLessThan(1e-3);
    expect(worldBox(m).max.y).toBeCloseTo(slot.height, 6);
    s.lift("강남구");
    expect(m.position.y).toBeCloseTo(LIFT_Y, 10);
    expect(shadowOf(s.group).visible).toBe(true);
    s.lift(null);
    s.setLayout("map", summary, "price");
    expect(m.position.x).toBe(0);
    expect(m.position.y).toBe(0);
    expect(m.scale.y).toBe(1);
    expect(shadowOf(s.group).visible).toBe(false);
  });

  it("repeating setLayout with the same summary and metric does not restart the move", () => {
    const summary = priceSummary();
    const a = createSeoulScene(fixtureGeo(), noText);
    const b = createSeoulScene(fixtureGeo(), noText);
    a.setLayout("spread", summary, "price");
    b.setLayout("spread", summary, "price");
    a.update(0.2, camera);
    b.update(0.2, camera);
    a.setLayout("spread", summary, "price");
    a.setLayout("spread", summary, "price");
    a.update(0.2, camera);
    b.update(0.2, camera);
    expect(guMesh(a.group, "강남구").position.x).toBe(guMesh(b.group, "강남구").position.x);
    // 지표가 바뀌면 다시 정렬한다
    a.setLayout("spread", summary, "count");
    a.update(1, camera);
    const slot = spreadLayout(summary, "count", NAMES).find((x) => x.gu === "종로구")!;
    expect(slot.rank).toBe(1);
    const geo = fixtureGeo();
    const p = worldCentroid(guMesh(a.group, "종로구"), centroidOf(geo, "종로구"));
    expect(Math.abs(p.x - slot.x)).toBeLessThan(1e-3);
  });

  it("spread draws a rank and a name label per gu (no rank for no value), removed on map", () => {
    const calls: string[] = [];
    const s = createSeoulScene(fixtureGeo(), { reducedMotion: true, makeTextTexture: labelFactory(calls) });
    const summary = priceSummary();
    delete summary["중구"];
    s.setLayout("spread", summary, "price");
    const sp = sprites(s.group);
    expect(sp).toHaveLength(25 + 24);
    for (const name of NAMES) expect(calls).toContain(name);
    expect(calls).toContain("1위");
    expect(calls).toContain("24위");
    expect(calls).not.toContain("25위");
    const slots = spreadLayout(summary, "price", NAMES);
    const first = sp.find((x) => x.name === "label:1위")!;
    expect(first.position.x).toBeCloseTo(slots[0]!.x, 6);
    expect(first.position.z).toBeCloseTo(slots[0]!.z, 6);
    expect(first.position.y).toBeGreaterThan(slots[0]!.height); // 기둥 위
    expect(first.material.opacity).toBeCloseTo(1, 10);
    s.setLayout("map", summary, "price");
    expect(sprites(s.group)).toHaveLength(0);
  });

  it("spread hides focus bars and dimming; map brings them back", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, { ...noText, reducedMotion: true });
    const summary = priceSummary();
    s.setOverview(summary, "price");
    const data = gangnam();
    s.focus("강남구", data, "price");
    s.setLayout("spread", summary, "price");
    expect(bars(s.group).visible).toBe(false);
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.ramp[0])); // 전체 보기 색
    expect(guMesh(s.group, "강남구").position.y).toBeCloseTo(0, 10);
    s.setLayout("map", summary, "price");
    expect(bars(s.group).visible).toBe(true);
    expect(colorOf(guMesh(s.group, "종로구"))).toBe(hex(PALETTE.guDim));
    expect(guMesh(s.group, "강남구").position.y).toBeCloseTo(0.03, 10);
    const ring = geo.gus.find((g) => g.name === "강남구")!.rings;
    const p0 = layoutBars(data.dongs, boundsOf(ring), "price")[0]!;
    expect(instance(bars(s.group), 0).pos.x).toBeCloseTo(p0.x, 6);
    expect(instance(bars(s.group), 0).scale.y).toBeCloseTo(p0.height, 6);
  });
});

describe("stage: setHover", () => {
  it("setHover brightens the outline, raises 0.01, keeps colors, and is idempotent", () => {
    const summary = priceSummary();
    const a = createSeoulScene(fixtureGeo(), noText);
    const b = createSeoulScene(fixtureGeo(), noText);
    a.setOverview(summary, "price");
    b.setOverview(summary, "price");
    const before = guMeshes(a.group).map(colorOf);
    a.setHover("강남구");
    b.setHover("강남구");
    const m = guMesh(a.group, "강남구");
    expect(edgeOf(m)).toBe(hex(PALETTE.text));
    expect(edgeOf(guMesh(a.group, "종로구"))).toBe(hex(PALETTE.bg));
    expect(guMeshes(a.group).map(colorOf)).toEqual(before); // 채움색은 그대로, 다른 구도 어두워지지 않는다
    a.update(0.02, camera);
    b.update(0.02, camera);
    a.setHover("강남구"); // 같은 값 반복(매 프레임 hover): 처음부터 다시 하지 않는다
    a.setHover("강남구");
    a.update(0.02, camera);
    b.update(0.02, camera);
    expect(m.position.y).toBe(guMesh(b.group, "강남구").position.y);
    expect(m.position.y).toBeGreaterThan(0);
    expect(m.position.y).toBeLessThan(0.01);
    a.update(1, camera);
    expect(m.position.y).toBeCloseTo(0.01, 10);
    a.setHover("서초구");
    a.update(1, camera);
    expect(m.position.y).toBeCloseTo(0, 10);
    expect(edgeOf(m)).toBe(hex(PALETTE.bg));
    expect(guMesh(a.group, "서초구").position.y).toBeCloseTo(0.01, 10);
    a.setHover(null);
    a.update(1, camera);
    expect(guMesh(a.group, "서초구").position.y).toBeCloseTo(0, 10);
    expect(edgeOf(guMesh(a.group, "서초구"))).toBe(hex(PALETTE.bg));
  });
});

describe("stage: pick", () => {
  it("pick returns gu under ndc", () => {
    // 픽스처의 강남구는 두 링 사이 틈에 centroid가 있으니 여기서는 한 링으로 바꾼다.
    const geo = fixtureGeo();
    const gn = geo.gus.find((g) => g.name === "강남구")!;
    gn.rings = [[[-0.08, 0.28], [0.08, 0.28], [0.08, 0.44], [-0.08, 0.44]]];
    const s = createSeoulScene(geo, noText);
    const cam = lookDown(gn.centroid[0], gn.centroid[1]);
    expect(s.pick(0, 0, cam)).toBe("강남구");
    // 같은 카메라로 화면 다른 곳: 서초구 centroid를 투영한 ndc
    const sc = centroidOf(geo, "서초구");
    cam.updateMatrixWorld();
    const ndc = new Vector3(sc[0], GU_DEPTH, sc[1]).project(cam);
    expect(Math.abs(ndc.x)).toBeGreaterThan(0.1);
    expect(s.pick(ndc.x, ndc.y, cam)).toBe("서초구");
    expect(s.pick(0, 0, lookDown(0.9, 0.9))).toBeNull(); // 도시 밖
    // 들어올린 구도 맞힌다
    s.lift("서초구");
    s.update(1, camera);
    expect(s.pick(0, 0, lookDown(sc[0], sc[1]))).toBe("서초구");
    s.lift(null);
    // 펼친 뒤에는 옮겨 간 자리에서 맞힌다
    const summary = priceSummary();
    s.setLayout("spread", summary, "price");
    s.update(1, camera);
    const slot = spreadLayout(summary, "price", NAMES).find((x) => x.gu === "서초구")!;
    expect(s.pick(0, 0, lookDown(slot.x, slot.z))).toBe("서초구");
    expect(s.pick(0, 0, lookDown(sc[0], sc[1]))).not.toBe("서초구");
  });

  it("pick ignores outlines and labels (and bars, leaders, the shadow); hits faces, not bounding boxes", () => {
    const geo = fixtureGeo();
    const s = createSeoulScene(geo, { reducedMotion: true, makeTextTexture: labelFactory() });
    s.focus("강남구", gangnam(), "price"); // 막대, 법정동 라벨, 지시선, 구 이름 라벨
    s.lift("서초구"); // 이웃 구 윤곽선이 카메라 가까이 뜬다, 그 아래 그림자 원판
    expect(sprites(s.group).length).toBeGreaterThan(0);
    // 강남구 centroid는 두 링 사이 틈이고, 그 위에는 구 이름 라벨만 있다 → 아무 구도 아님
    const c = centroidOf(geo, "강남구");
    expect(s.pick(0, 0, lookDown(c[0], c[1]))).toBeNull();
    // 1위 법정동 막대(그 위 라벨과 지시선) 바로 위: 막대 아래는 강남구 서쪽 링
    const ring = geo.gus.find((g) => g.name === "강남구")!.rings;
    const top = layoutBars(gangnam().dongs, boundsOf(ring), "price")[0]!;
    expect(top.x).toBeGreaterThan(-0.08);
    expect(top.x).toBeLessThan(-0.01);
    expect(s.pick(0, 0, lookDown(top.x, top.z))).toBe("강남구");
    // 들어올린 서초구 위: 그림자 원판이 아니라 구
    const sc = centroidOf(geo, "서초구");
    expect(s.pick(0, 0, lookDown(sc[0], sc[1]))).toBe("서초구");
  });

  it("after dispose the stage methods are quiet no-ops", () => {
    const s = createSeoulScene(fixtureGeo(), noText);
    s.dispose();
    expect(() => {
      s.setHover("강남구");
      s.lift("강남구");
      s.setLayout("spread", priceSummary(), "price");
    }).not.toThrow();
    expect(s.pick(0, 0, lookDown(0, 0))).toBeNull();
    expect(s.group.children).toHaveLength(0);
  });
});
