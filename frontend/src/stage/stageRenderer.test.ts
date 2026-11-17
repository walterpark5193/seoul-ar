import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, Group, Mesh, PerspectiveCamera, Sprite, Texture, Vector3 } from "three";
import type { WebGLRenderer } from "three";
import {
  MAP_POSE, SPREAD_POSE, createStageRenderer, lerpPose, mapPoseFor, spreadPoseFor, type CameraPose,
} from "./stageRenderer";
import { createRotator } from "./rotate";
import { createSeoulScene } from "../scene/seoulScene";
import { spreadLayout } from "../scene/spreadLayout";
import type { Geo } from "../geo/types";
import type { Stat } from "../data/types";
import geoJson from "../geo/seoul-gu.json";
import indexJson from "../../public/data/index.json";

const pitchDeg = (p: CameraPose) =>
  (Math.atan2(p.pos[1] - p.target[1], p.pos[2] - p.target[2]) * 180) / Math.PI;

describe("stageRenderer poses", () => {
  it("MAP_POSE looks down about 55°", () => {
    const a = pitchDeg(MAP_POSE);
    expect(a).toBeGreaterThan(50);
    expect(a).toBeLessThan(60);
  });
  it("SPREAD_POSE about 15–25°", () => {
    const a = pitchDeg(SPREAD_POSE);
    expect(a).toBeGreaterThanOrEqual(15);
    expect(a).toBeLessThanOrEqual(25);
  });
  it("lerpPose endpoints and midpoint", () => {
    expect(lerpPose(MAP_POSE, SPREAD_POSE, 0)).toEqual(MAP_POSE);
    expect(lerpPose(MAP_POSE, SPREAD_POSE, 1)).toEqual(SPREAD_POSE);
    const m = lerpPose(MAP_POSE, SPREAD_POSE, 0.5);
    expect(m.pos[1]).toBeCloseTo((MAP_POSE.pos[1] + SPREAD_POSE.pos[1]) / 2);
    expect(m.target[2]).toBeCloseTo((MAP_POSE.target[2] + SPREAD_POSE.target[2]) / 2);
    expect(m.fov).toBeCloseTo(40);
  });
});

// ---- 화면 맞춤(G3): 실제 구 경계(seoul-gu.json)와 실제 요약(index.json)으로 three 투영 ----

const geo = geoJson as unknown as Geo;
const summary = (indexJson as unknown as { months: string[]; summary: Record<string, Record<string, Stat>> }).summary;
const month = (indexJson as unknown as { months: string[] }).months.at(-1)!;
const NAMES = geo.gus.map((g) => g.name);

/** labels.ts canvasTextTexture와 같은 비율(48px 글꼴, 좌우 20px, 높이 83px). 글자 폭은 넉넉히 한 글자 48px로 잡는다. */
function wideText(text: string): Texture {
  const t = new Texture();
  t.image = { width: [...text].length * 48 + 40, height: Math.ceil(48 * 1.3) + 20 };
  return t;
}

function cameraFor(pose: CameraPose, aspect: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(pose.fov, aspect, 0.01, 20);
  cam.position.set(...pose.pos);
  cam.lookAt(...pose.target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

interface Extent { minX: number; maxX: number; minY: number; maxY: number; }
const empty = (): Extent => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
function add(e: Extent, v: Vector3): void {
  e.minX = Math.min(e.minX, v.x); e.maxX = Math.max(e.maxX, v.x);
  e.minY = Math.min(e.minY, v.y); e.maxY = Math.max(e.maxY, v.y);
}

/** 기둥(구 메시 + 윤곽선)의 경계 상자 8꼭짓점을 NDC로. */
function meshExtent(mesh: Mesh, cam: PerspectiveCamera): Extent {
  const box = new Box3().setFromObject(mesh);
  const e = empty();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    add(e, new Vector3(x, y, z).project(cam));
  }
  return e;
}

/** 스프라이트는 시점 공간에서 화면과 나란한 사각형이다(center 0.5,0 → 가로 ±0.5·sx, 세로 0..sy). */
function spriteExtent(s: Sprite, cam: PerspectiveCamera): Extent {
  const c = s.getWorldPosition(new Vector3()).applyMatrix4(cam.matrixWorldInverse);
  const sc = s.getWorldScale(new Vector3());
  const e = empty();
  for (const dx of [-0.5, 0.5]) for (const dy of [0, 1]) {
    const v = new Vector3(c.x + (dx + 0.5 - s.center.x) * sc.x, c.y + (dy - s.center.y) * sc.y, c.z);
    add(e, v.applyMatrix4(cam.projectionMatrix));
  }
  return e;
}

function guMesh(group: Group, name: string): Mesh {
  const m = group.children.find((c) => (c as Mesh).isMesh === true && c.userData.gu === name);
  if (!m) throw new Error(`no mesh for ${name}`);
  return m as Mesh;
}
function sprite(group: Group, text: string): Sprite {
  let found: Sprite | null = null;
  group.traverse((o) => { if ((o as Sprite).isSprite && o.name === `label:${text}`) found = o as Sprite; });
  if (!found) throw new Error(`no label ${text}`);
  return found;
}

const LIMIT = 0.95;
const inside = (e: Extent) => e.minX >= -LIMIT && e.maxX <= LIMIT && e.minY >= -LIMIT && e.maxY <= LIMIT;
const fmt = (e: Extent) => `x ${e.minX.toFixed(3)}..${e.maxX.toFixed(3)} y ${e.minY.toFixed(3)}..${e.maxY.toFixed(3)}`;

const ASPECTS: [string, number][] = [["16:9", 16 / 9], ["16:10", 16 / 10], ["4:3", 4 / 3]];

describe("spreadPoseFor: 펼친 호가 프로젝터 화면 안에 들어온다", () => {
  const s = createSeoulScene(geo, { reducedMotion: true, makeTextTexture: wideText });
  const sum = summary[month]!;
  s.setLayout("spread", sum, "price");
  s.group.updateMatrixWorld(true);
  const slots = spreadLayout(sum, "price", NAMES);
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;

  it("실제 데이터의 1위·25위가 있다", () => {
    expect(first.rank).toBe(1);
    expect(last.rank).toBe(25);
  });

  for (const [label, aspect] of ASPECTS) {
    it(`${label}: 1위·25위 기둥과 순위·이름 라벨이 NDC ±${LIMIT} 안`, () => {
      const cam = cameraFor(spreadPoseFor(aspect), aspect);
      const parts: [string, Extent][] = [
        [`${first.gu} 기둥`, meshExtent(guMesh(s.group, first.gu), cam)],
        ["1위 라벨", spriteExtent(sprite(s.group, "1위"), cam)],
        [`${first.gu} 라벨`, spriteExtent(sprite(s.group, first.gu), cam)],
        [`${last.gu} 기둥`, meshExtent(guMesh(s.group, last.gu), cam)],
        ["25위 라벨", spriteExtent(sprite(s.group, "25위"), cam)],
        [`${last.gu} 라벨`, spriteExtent(sprite(s.group, last.gu), cam)],
      ];
      for (const [what, e] of parts) expect(inside(e), `${label} ${what}: ${fmt(e)}`).toBe(true);
    });
  }

  it("모든 구의 기둥과 라벨도 16:10에서 화면 안", () => {
    const aspect = 16 / 10;
    const cam = cameraFor(spreadPoseFor(aspect), aspect);
    for (const slot of slots) {
      const e = meshExtent(guMesh(s.group, slot.gu), cam);
      expect(inside(e), `${slot.gu}: ${fmt(e)}`).toBe(true);
      const n = spriteExtent(sprite(s.group, slot.gu), cam);
      expect(inside(n), `${slot.gu} 라벨: ${fmt(n)}`).toBe(true);
    }
  });

  it("넓은 화면(2:1 이상)에서는 원래 포즈 그대로, 좁을수록 target은 두고 뒤로만 물린다", () => {
    expect(spreadPoseFor(2)).toEqual(SPREAD_POSE);
    expect(spreadPoseFor(2.4)).toEqual(SPREAD_POSE);
    const p = spreadPoseFor(4 / 3);
    expect(p.target).toEqual(SPREAD_POSE.target);
    expect(p.fov).toBe(SPREAD_POSE.fov);
    expect(pitchDeg(p)).toBeCloseTo(pitchDeg(SPREAD_POSE), 6);
    const dist = (q: CameraPose) => Math.hypot(q.pos[0] - q.target[0], q.pos[1] - q.target[1], q.pos[2] - q.target[2]);
    expect(dist(p)).toBeGreaterThan(dist(spreadPoseFor(16 / 9)));
    expect(dist(spreadPoseFor(16 / 9))).toBeGreaterThan(dist(SPREAD_POSE));
  });

  it("잘못된 비율(0, NaN)은 원래 포즈", () => {
    expect(spreadPoseFor(0)).toEqual(SPREAD_POSE);
    expect(spreadPoseFor(Number.NaN)).toEqual(SPREAD_POSE);
    expect(mapPoseFor(Number.NaN)).toEqual(MAP_POSE);
  });
});

describe("mapPoseFor: 지도 포즈에서 서울 전체가 화면 안", () => {
  const s = createSeoulScene(geo, { reducedMotion: true, makeTextTexture: () => null });
  s.setOverview(summary[month]!, "price");
  s.group.updateMatrixWorld(true);
  for (const [label, aspect] of [...ASPECTS, ["2:1", 2] as [string, number]]) {
    it(`${label}: 25개 구가 모두 NDC ±${LIMIT} 안`, () => {
      const cam = cameraFor(mapPoseFor(aspect), aspect);
      for (const name of NAMES) {
        const e = meshExtent(guMesh(s.group, name), cam);
        expect(inside(e), `${label} ${name}: ${fmt(e)}`).toBe(true);
      }
    });
  }
});

// ---- 렌더러: resize가 현재 모드의 포즈를 새 비율로 다시 맞춘다 ----

function fakeRenderer() {
  const canvas = { setAttribute: vi.fn(), remove: vi.fn() };
  return {
    domElement: canvas,
    setPixelRatio: vi.fn(), setClearColor: vi.fn(), setSize: vi.fn(),
    setAnimationLoop: vi.fn(), render: vi.fn(), dispose: vi.fn(),
  } as unknown as WebGLRenderer;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("createStageRenderer", () => {
  it("returns null without WebGL", () => {
    const r = createStageRenderer({} as HTMLElement, {
      reducedMotion: false,
      makeRenderer: () => null,
    });
    expect(r).toBeNull();
  });

  it("resize()가 펼치기 포즈를 새 화면 비율로 다시 계산한다", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768 });
    const box = { clientWidth: 1024, clientHeight: 768, append: vi.fn() };
    const r = createStageRenderer(box as unknown as HTMLElement, { reducedMotion: false, makeRenderer: fakeRenderer })!;
    expect(r.camera.aspect).toBeCloseTo(4 / 3);
    const near = (a: Vector3, b: readonly number[]) => a.distanceTo(new Vector3(...b)) < 1e-9;
    expect(near(r.camera.position, mapPoseFor(4 / 3).pos)).toBe(true);
    r.setMode("spread", true);
    expect(near(r.camera.position, spreadPoseFor(4 / 3).pos)).toBe(true);
    box.clientWidth = 1280; box.clientHeight = 720;
    r.resize();
    expect(r.camera.aspect).toBeCloseTo(16 / 9);
    expect(near(r.camera.position, spreadPoseFor(16 / 9).pos)).toBe(true);
    r.setMode("map", true);
    expect(near(r.camera.position, mapPoseFor(16 / 9).pos)).toBe(true);
    r.dispose();
  });

  it("보간 중 resize는 목적지만 바꾸고 순간이동하지 않는다", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
    const box = { clientWidth: 1280, clientHeight: 720, append: vi.fn() };
    const gl = fakeRenderer();
    const r = createStageRenderer(box as unknown as HTMLElement, { reducedMotion: false, makeRenderer: () => gl })!;
    const loop = vi.mocked(gl.setAnimationLoop).mock.calls[0]![0] as (t: number) => void;
    loop(0);
    r.setMode("spread");
    const before = r.camera.position.clone();
    box.clientWidth = 1024; box.clientHeight = 768;
    r.resize();
    expect(r.camera.position.distanceTo(before)).toBeLessThan(1e-9);
    for (let t = 100; t <= 2000; t += 100) loop(t);
    expect(r.camera.position.distanceTo(new Vector3(...spreadPoseFor(4 / 3).pos))).toBeLessThan(1e-9);
    r.dispose();
  });
  describe("setZoom", () => {
    const mk = (w = 1280, h = 720) => {
      vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: w, innerHeight: h });
      const box = { clientWidth: w, clientHeight: h, append: vi.fn() };
      const gl = fakeRenderer();
      const r = createStageRenderer(box as unknown as HTMLElement, { reducedMotion: false, makeRenderer: () => gl })!;
      const loop = vi.mocked(gl.setAnimationLoop).mock.calls[0]![0] as (t: number) => void;
      return { r, box, loop };
    };
    const dist = (r: { camera: PerspectiveCamera }, p: CameraPose) =>
      r.camera.position.distanceTo(new Vector3(...p.target));
    it("setZoom 2 halves distance to target", () => {
      // 계약상 상한이 1.6이라 2배는 불가: 1.25배로 거리가 1/1.25. (2는 1.6으로 잘림은 아래 clamp 테스트)
      const { r } = mk();
      const base = dist(r, mapPoseFor(16 / 9));
      r.setZoom(1.25);
      expect(dist(r, mapPoseFor(16 / 9))).toBeCloseTo(base / 1.25, 9);
      r.dispose();
    });
    it("zoom clamped", () => {
      const { r } = mk();
      const base = dist(r, mapPoseFor(16 / 9));
      r.setZoom(5);
      expect(dist(r, mapPoseFor(16 / 9))).toBeCloseTo(base / 1.6, 9);
      r.setZoom(0.1);
      expect(dist(r, mapPoseFor(16 / 9))).toBeCloseTo(base / 0.7, 9);
      r.setZoom(NaN);
      expect(dist(r, mapPoseFor(16 / 9))).toBeCloseTo(base, 9);
      r.dispose();
    });
    it("zoom kept across setMode tween and resize", () => {
      const { r, box, loop } = mk();
      loop(0);
      r.setZoom(1.5);
      r.setMode("spread");
      for (let t = 100; t <= 2000; t += 100) loop(t);
      const q = spreadPoseFor(16 / 9);
      expect(dist(r, q)).toBeCloseTo(new Vector3(...q.pos).distanceTo(new Vector3(...q.target)) / 1.5, 9);
      box.clientWidth = 1024; box.clientHeight = 768;
      r.resize();
      for (let t = 2100; t <= 4000; t += 100) loop(t);
      const p = spreadPoseFor(4 / 3);
      expect(dist(r, p)).toBeCloseTo(new Vector3(...p.pos).distanceTo(new Vector3(...p.target)) / 1.5, 9);
      r.dispose();
    });
  });
});

// ---- 13.8 setPan: 확대 1배 절반 폭 W1 단위로 카메라 오른쪽 축을 따라 옆으로 ----

describe("setPan (13.8)", () => {
  const mk = (w = 1280, h = 720) => {
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: w, innerHeight: h });
    const box = { clientWidth: w, clientHeight: h, append: vi.fn() };
    const gl = fakeRenderer();
    const r = createStageRenderer(box as unknown as HTMLElement, { reducedMotion: false, makeRenderer: () => gl })!;
    const loop = vi.mocked(gl.setAnimationLoop).mock.calls[0]![0] as (t: number) => void;
    return { r, box, loop };
  };
  /** 포즈의 확대 1배 절반 폭: tan(hfov/2)·D1. */
  const w1 = (p: CameraPose, aspect: number) =>
    Math.tan((p.fov * Math.PI) / 360) * aspect * new Vector3(...p.pos).distanceTo(new Vector3(...p.target));
  /** 확대 z·옆 이동 pan일 때 기대 카메라 위치(오른쪽 축 = 시선 × 위). */
  function expected(p: CameraPose, aspect: number, z: number, pan: number): { pos: Vector3; target: Vector3 } {
    const t = new Vector3(...p.target);
    const off = new Vector3(...p.pos).sub(t);
    const right = off.clone().negate().cross(new Vector3(0, 1, 0)).normalize();
    const shift = right.multiplyScalar(pan * w1(p, aspect));
    return { pos: t.clone().add(off.divideScalar(z)).add(shift), target: t.clone().add(shift) };
  }
  /** 카메라가 보는 점(시선 위, 거리 d). */
  const lookPoint = (cam: PerspectiveCamera, d: number) =>
    cam.position.clone().add(cam.getWorldDirection(new Vector3()).multiplyScalar(d));

  it("shifts camera and target by p·W1 along the camera right axis; view direction unchanged", () => {
    for (const mode of ["map", "spread"] as const) {
      const { r } = mk();
      r.setMode(mode, true);
      const pose = mode === "map" ? mapPoseFor(16 / 9) : spreadPoseFor(16 / 9);
      r.camera.updateMatrixWorld();
      const dir0 = r.camera.getWorldDirection(new Vector3());
      const right0 = new Vector3().setFromMatrixColumn(r.camera.matrixWorld, 0);
      const pos0 = r.camera.position.clone();
      r.setPan(0.5);
      r.camera.updateMatrixWorld();
      const W1 = w1(pose, 16 / 9);
      expect(r.camera.position.clone().sub(pos0).distanceTo(right0.clone().multiplyScalar(0.5 * W1))).toBeLessThan(1e-9);
      expect(r.camera.getWorldDirection(new Vector3()).distanceTo(dir0)).toBeLessThan(1e-9);
      const D1 = new Vector3(...pose.pos).distanceTo(new Vector3(...pose.target));
      const e = expected(pose, 16 / 9, 1, 0.5);
      expect(lookPoint(r.camera, D1).distanceTo(e.target)).toBeLessThan(1e-9); // target도 같이 옮겨졌다
      // setZoom 뒤에 적용: 확대한 거리 + 같은 W1(확대 1배 기준) 이동
      r.setZoom(1.6);
      r.camera.updateMatrixWorld();
      const ez = expected(pose, 16 / 9, 1.6, 0.5);
      expect(r.camera.position.distanceTo(ez.pos)).toBeLessThan(1e-9);
      expect(lookPoint(r.camera, D1 / 1.6).distanceTo(ez.target)).toBeLessThan(1e-9);
      r.setPan(-0.25);
      expect(r.camera.position.distanceTo(expected(pose, 16 / 9, 1.6, -0.25).pos)).toBeLessThan(1e-9);
      r.dispose();
    }
  });

  it("pan 0 (and NaN) is exactly the unpanned pose; clamped to [−1, 1]", () => {
    const { r } = mk();
    const pose = mapPoseFor(16 / 9);
    r.setZoom(1.3);
    const unpanned = r.camera.position.clone();
    r.setPan(0.4);
    r.setPan(0);
    expect(r.camera.position.equals(unpanned)).toBe(true);
    r.setPan(0.4);
    r.setPan(NaN);
    expect(r.camera.position.equals(unpanned)).toBe(true);
    r.setPan(5);
    expect(r.camera.position.distanceTo(expected(pose, 16 / 9, 1.3, 1).pos)).toBeLessThan(1e-9);
    r.setPan(-5);
    expect(r.camera.position.distanceTo(expected(pose, 16 / 9, 1.3, -1).pos)).toBeLessThan(1e-9);
    r.dispose();
  });

  it("pan kept across setMode tween and resize (W1 of the current fitted pose)", () => {
    const { r, box, loop } = mk();
    loop(0);
    r.setZoom(1.5);
    r.setPan(-0.2);
    r.setMode("spread");
    loop(100); // 보간 중에도 옆 이동이 얹혀 있다
    r.camera.updateMatrixWorld();
    const right = new Vector3().setFromMatrixColumn(r.camera.matrixWorld, 0);
    expect(right.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
    for (let t = 200; t <= 2000; t += 100) loop(t);
    expect(r.camera.position.distanceTo(expected(spreadPoseFor(16 / 9), 16 / 9, 1.5, -0.2).pos)).toBeLessThan(1e-9);
    box.clientWidth = 1024; box.clientHeight = 768;
    r.resize();
    for (let t = 2100; t <= 4000; t += 100) loop(t);
    const e = expected(spreadPoseFor(4 / 3), 4 / 3, 1.5, -0.2);
    expect(r.camera.position.distanceTo(e.pos)).toBeLessThan(1e-9);
    r.camera.updateMatrixWorld();
    const D1 = new Vector3(...spreadPoseFor(4 / 3).pos).distanceTo(new Vector3(...spreadPoseFor(4 / 3).target));
    expect(lookPoint(r.camera, D1 / 1.5).distanceTo(e.target)).toBeLessThan(1e-9);
    r.setMode("map", true);
    expect(r.camera.position.distanceTo(expected(mapPoseFor(4 / 3), 4 / 3, 1.5, -0.2).pos)).toBeLessThan(1e-9);
    r.dispose();
  });

  describe("three projection: spread 16:9, zoom 1.6 anchored at ndc −0.9 (rotator zoomAt → setZoom/setPan)", () => {
    const s = createSeoulScene(geo, { reducedMotion: true, makeTextTexture: wideText });
    const sum = summary[month]!;
    s.setLayout("spread", sum, "price");
    s.group.updateMatrixWorld(true);
    const first = spreadLayout(sum, "price", NAMES)[0]!;

    const view = (z: number, pan: number) => {
      const { r } = mk();
      r.setMode("spread", true);
      r.setZoom(z);
      r.setPan(pan);
      r.camera.updateMatrixWorld();
      return r;
    };
    const rot = createRotator();
    rot.zoomAt(1.6, -0.9);

    it("rank-1 slot is the left end of the arc (x = −0.9·sin50°)", () => {
      expect(first.rank).toBe(1);
      expect(first.x).toBeCloseTo(-0.9 * Math.sin((50 * Math.PI) / 180), 9);
      expect(rot.state.zoom).toBeCloseTo(1.6, 12);
      expect(rot.state.panX).toBeLessThan(0);
    });

    it("the target-plane point under the anchor stays at ndc −0.9 (rotator and renderer units agree)", () => {
      const base = view(1, 0);
      const pose = spreadPoseFor(16 / 9);
      const anchored = expected(pose, 16 / 9, 1, -0.9).target; // target 평면에서 ndc −0.9 아래
      expect(anchored.clone().project(base.camera).x).toBeCloseTo(-0.9, 9);
      const r = view(rot.state.zoom, rot.state.panX);
      expect(anchored.clone().project(r.camera).x).toBeCloseTo(-0.9, 9);
      base.dispose();
      r.dispose();
    });

    it("rank-1 pillar stays inside NDC ±1 and comes toward the centre compared with no pan", () => {
      const panned = view(rot.state.zoom, rot.state.panX);
      const plain = view(rot.state.zoom, 0);
      const ep = meshExtent(guMesh(s.group, first.gu), panned.camera);
      const e0 = meshExtent(guMesh(s.group, first.gu), plain.camera);
      expect(ep.minX >= -1 && ep.maxX <= 1 && ep.minY >= -1 && ep.maxY <= 1, `panned ${fmt(ep)}`).toBe(true);
      const cx = (e: Extent) => (e.minX + e.maxX) / 2;
      expect(Math.abs(cx(ep)), `panned ${fmt(ep)} vs plain ${fmt(e0)}`).toBeLessThan(Math.abs(cx(e0)));
      // 슬롯 바닥 중심점도
      const slot = new Vector3(first.x, 0, first.z);
      expect(Math.abs(slot.clone().project(panned.camera).x)).toBeLessThan(Math.abs(slot.clone().project(plain.camera).x));
      expect(Math.abs(slot.clone().project(panned.camera).x)).toBeLessThan(1);
      panned.dispose();
      plain.dispose();
    });

    it("centre anchor keeps panX 0: identical to plain zoom", () => {
      const c = createRotator();
      c.zoomAt(1.6, 0);
      expect(c.state.panX).toBe(0);
      const a = view(c.state.zoom, c.state.panX);
      const b = view(1.6, 0);
      expect(a.camera.position.equals(b.camera.position)).toBe(true);
      a.dispose();
      b.dispose();
    });
  });
});
