import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, Group, Mesh, PerspectiveCamera, Sprite, Texture, Vector3 } from "three";
import type { WebGLRenderer } from "three";
import {
  MAP_POSE, SPREAD_POSE, createStageRenderer, lerpPose, mapPoseFor, spreadPoseFor, type CameraPose,
} from "./stageRenderer";
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
});
