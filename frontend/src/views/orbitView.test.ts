// #/3d 마운트 스모크. three/WebGL은 노드에 없으므로 WebGLRenderer는 기본으로 던지게 하고(= 폴백 경로),
// DOM은 orbitView가 쓰는 만큼만 흉내 낸 가짜를 쓴다(jsdom 없음).
// 회귀: 큰 화면 모드(stage=1)가 .viewer 요소 자신에게 .viewer 자손 검색을 해서 마운트에서 터졌다.
// gl.ok를 켜면 가짜 렌더러(그리기 없음)로 진짜 OrbitControls·카메라·애니메이션 루프 경로를 돈다(큰 화면 자동 회전 배선).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gl = vi.hoisted(() => ({
  ok: false,
  loop: null as ((t: number) => void) | null,
  controls: null as null | { autoRotate: boolean; enabled: boolean; enableDamping: boolean; getAzimuthalAngle(): number },
}));

vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    readonly domElement = {
      style: {} as Record<string, string>,
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      ownerDocument: { addEventListener() {}, removeEventListener() {} },
    };
    constructor() { if (!gl.ok) throw new Error("no webgl (test)"); }
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    render() {}
    dispose() {}
    forceContextLoss() {}
    setAnimationLoop(fn: ((t: number) => void) | null) { gl.loop = fn; }
  },
}));
vi.mock("three/addons/controls/OrbitControls.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("three/addons/controls/OrbitControls.js")>();
  return {
    OrbitControls: class extends real.OrbitControls {
      constructor(...args: ConstructorParameters<typeof real.OrbitControls>) {
        super(...args);
        gl.controls = this;
      }
    },
  };
});
vi.mock("../ui/qr", () => ({ drawQr: vi.fn(() => Promise.resolve()) }));
vi.mock("../ui/sheetDom", () => ({ mountSheet: vi.fn(() => ({ render: vi.fn(), destroy: vi.fn() })) }));
vi.mock("./viewerSync", () => ({ bindViewer: vi.fn(() => vi.fn()), drawCity: vi.fn() }));
vi.mock("./stageFollow", () => ({
  bindStageFollow: vi.fn(() => vi.fn()),
  createVoteLine: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
  followLayout: vi.fn(),
}));

import { Group } from "three";
import { createStore } from "../state/store";
import { drawQr } from "../ui/qr";
import { createStageOrbit, createViewFollower, mountOrbitView } from "./orbitView";
import { bindStageFollow, type StageFollowOptions } from "./stageFollow";
import type { ViewContext } from "./types";

type Listener = () => void;

/** querySelector는 "자기 자손의 html에 그 표식이 있을 때만" 요소를 돌려준다(진짜 DOM처럼 자기 자신은 찾지 않는다). */
class FakeEl {
  html = "";
  hidden = false;
  textContent = "";
  readonly cls = new Set<string>();
  readonly listeners = new Map<string, Set<Listener>>();
  readonly style = { setProperty: vi.fn() };
  private readonly kids = new Map<string, FakeEl>();
  readonly classList = {
    add: (c: string) => { this.cls.add(c); },
    remove: (c: string) => { this.cls.delete(c); },
    contains: (c: string) => this.cls.has(c),
  };
  get innerHTML() { return this.html; }
  set innerHTML(v: string) { this.html = v; this.kids.clear(); }
  insertAdjacentHTML(_pos: string, v: string) { this.html += v; }
  querySelector(sel: string): FakeEl | null {
    const found = sel.startsWith("[") ? new RegExp(`[\\s"]${sel.slice(1, -1)}(?=[\\s>=])`).test(this.html)
      : new RegExp(`class="[^"]*\\b${sel.slice(1)}\\b`).test(this.html);
    if (!found) return null;
    let kid = this.kids.get(sel);
    if (!kid) {
      kid = new FakeEl();
      if (sel === ".viewer") kid.html = ""; // 큰 화면 모드에서 viewer 자손에는 viewer가 없다
      this.kids.set(sel, kid);
    }
    return kid;
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: Listener) { this.listeners.get(type)?.delete(fn); }
  getBoundingClientRect() { return { height: 0 }; }
  append() {}
  emit(type: string) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); }
  count(type: string) { return this.listeners.get(type)?.size ?? 0; }
}

function makeCtx(query?: string, reducedMotion = false, group = new Group()): ViewContext {
  return {
    store: createStore(),
    index: { v: 1, generatedAt: "", source: "", months: [], gus: [], summary: {} },
    config: { appUrl: "https://example.test/app" },
    loadGu: vi.fn(),
    reducedMotion,
    query,
    createScene: () => ({ group, update: vi.fn(), dispose: vi.fn(), lift: vi.fn(), setLayout: vi.fn() }),
  } as unknown as ViewContext;
}

describe("mountOrbitView 마운트 스모크", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "https://example.test", pathname: "/app/" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("#/3d?stage=1: 던지지 않고 마운트하고 QR을 그린다(WebGL 없는 폴백 경로)", () => {
    const root = new FakeEl();
    const ctx = makeCtx("stage=1");
    let unmount!: () => void;
    expect(() => { unmount = mountOrbitView(root as unknown as HTMLElement, ctx); }).not.toThrow();
    expect(root.html).toContain("viewer--stage");
    expect(root.querySelector("[data-stage]")!.html).toContain("stage-fail");
    expect(drawQr).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("큰 화면 모드: 움직임이 없으면 is-idle, 포인터가 움직이면 풀린다", () => {
    const root = new FakeEl();
    const unmount = mountOrbitView(root as unknown as HTMLElement, makeCtx("stage=1"));
    const viewer = root.querySelector(".viewer")!;
    expect(viewer.classList.contains("is-idle")).toBe(false);
    vi.advanceTimersByTime(2600);
    expect(viewer.classList.contains("is-idle")).toBe(true);
    viewer.emit("pointermove");
    expect(viewer.classList.contains("is-idle")).toBe(false);
    vi.advanceTimersByTime(2600);
    expect(viewer.classList.contains("is-idle")).toBe(true);
    unmount();
  });

  it("해제하면 리스너·타이머·내용을 정리한다", () => {
    const root = new FakeEl();
    const unmount = mountOrbitView(root as unknown as HTMLElement, makeCtx("stage=1"));
    const viewer = root.querySelector(".viewer")!;
    expect(viewer.count("pointermove")).toBe(1);
    unmount();
    expect(viewer.count("pointermove")).toBe(0);
    expect(root.html).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("일반 #/3d(바텀시트)도 던지지 않고 마운트·해제된다", () => {
    const root = new FakeEl();
    let unmount!: () => void;
    expect(() => { unmount = mountOrbitView(root as unknown as HTMLElement, makeCtx()); }).not.toThrow();
    expect(root.html).not.toContain("viewer--stage");
    expect(root.querySelector("[data-stage]")!.html).toContain("stage-fail");
    unmount();
    expect(root.html).toBe("");
  });
});

describe("createViewFollower: 큰 화면만 무대 yaw·zoom을 따른다", () => {
  const mkGroup = () => {
    const g = { rotation: { y: 0 }, scale: { v: 1, setScalar(n: number) { this.v = n; } } };
    return g;
  };

  it("큰 화면: 여러 프레임 뒤 목표 yaw·zoom에 닿는다(처음엔 중간값)", () => {
    const g = mkGroup();
    const f = createViewFollower(g, true);
    f.set(1, 1.5);
    f.step(1 / 60);
    expect(g.rotation.y).toBeGreaterThan(0);
    expect(g.rotation.y).toBeLessThan(1);
    expect(g.scale.v).toBeGreaterThan(1);
    expect(g.scale.v).toBeLessThan(1.5);
    for (let i = 0; i < 300; i++) f.step(1 / 60);
    expect(g.rotation.y).toBeCloseTo(1, 3);
    expect(g.scale.v).toBeCloseTo(1.5, 3);
  });

  it("일반 3D(관객 폰): 값을 받아도 group은 그대로", () => {
    const g = mkGroup();
    const f = createViewFollower(g, false);
    f.set(2, 1.6);
    for (let i = 0; i < 60; i++) f.step(1 / 60);
    expect(g.rotation.y).toBe(0);
    expect(g.scale.v).toBe(1);
  });

  it("π 경계를 넘으면 가까운 쪽으로 돈다", () => {
    const g = mkGroup();
    const f = createViewFollower(g, true);
    f.set(3.0, 1);
    for (let i = 0; i < 300; i++) f.step(1 / 60);
    f.set(-3.0, 1); // 3.0 → -3.0은 짧게 0.28 rad(π 너머)
    f.step(1 / 60);
    expect(g.rotation.y).toBeGreaterThan(3.0); // 0쪽으로 되감지 않는다
    for (let i = 0; i < 300; i++) f.step(1 / 60);
    expect(Math.cos(g.rotation.y)).toBeCloseTo(Math.cos(-3.0), 3);
  });

  it("(0, 1)로 돌아간다", () => {
    const g = mkGroup();
    const f = createViewFollower(g, true);
    f.set(1, 1.4);
    for (let i = 0; i < 300; i++) f.step(1 / 60);
    f.set(0, 1);
    for (let i = 0; i < 300; i++) f.step(1 / 60);
    expect(g.rotation.y).toBeCloseTo(0, 3);
    expect(g.scale.v).toBeCloseTo(1, 3);
  });

  // final M-1: 목표를 늦게 따라가는 표시 yaw 기준으로 감싸면, 720°/s에서 목표 사이(144°)와 지연이 합쳐져 180°를 넘을 때
  // 짧은 쪽(거꾸로)으로 돈다. 새 목표는 직전 목표 기준으로 이어 붙인다.
  it("빠른 회전(720°/s, 5Hz 발행, 도착 30~200ms 흔들림)에서도 표시 yaw가 한 방향으로만 간다", () => {
    const wrapA = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
    const speed = 4 * Math.PI; // 720°/s
    const delays = [30, 200, 60, 180, 120, 40, 200, 90]; // ms
    const sends = Array.from({ length: 25 }, (_, i) => ({ at: i * 200 + delays[i % delays.length]!, yaw: wrapA(speed * i * 0.2) }));
    for (const fps of [60, 30]) {
      const g = mkGroup();
      const f = createViewFollower(g, true);
      let prev = 0, back = 0, total = 0, si = 0;
      for (let t = 0; t <= 5500; t += 1000 / fps) {
        while (si < sends.length && sends[si]!.at <= t) { f.set(sends[si]!.yaw, 1); si++; }
        f.step(1 / fps);
        const d = wrapA(g.rotation.y - prev);
        prev = g.rotation.y;
        if (d < -1e-9) back++;
        total += d;
        expect(Math.abs(g.rotation.y)).toBeLessThanOrEqual(Math.PI + 1e-9); // 여러 바퀴 돌아도 값이 커지지 않는다
      }
      expect(back).toBe(0);
      expect(total).toBeCloseTo(speed * 24 * 0.2, 1); // 마지막 목표(4.8초 = 9.6바퀴)까지 앞으로 갔다
    }
  });

  it("reduced-motion: 보간 없이 다음 프레임에 목표 그대로", () => {
    const g = mkGroup();
    const f = createViewFollower(g, true, { reducedMotion: true });
    f.set(1.2, 1.5);
    f.step(1 / 60);
    expect(g.rotation.y).toBeCloseTo(1.2, 9);
    expect(g.scale.v).toBeCloseTo(1.5, 9);
    f.set(-3.1, 0.7);
    f.step(1 / 60);
    expect(Math.cos(g.rotation.y)).toBeCloseTo(Math.cos(-3.1), 9);
    expect(Math.sin(g.rotation.y)).toBeCloseTo(Math.sin(-3.1), 9);
    expect(g.scale.v).toBeCloseTo(0.7, 9);
  });
});

describe("createStageOrbit: 큰 화면 자동 회전 정지·정면 복귀(계약 13.6)", () => {
  /** OrbitControls 중 쓰는 만큼: 방위 theta, rotateLeft는 theta를 줄인다(진짜와 같은 부호). */
  const mkControls = (theta: number, autoRotate = true) => ({
    autoRotate, theta,
    getAzimuthalAngle() { return this.theta; },
    rotateLeft(a: number) { this.theta -= a; },
  });

  it("무대가 살아 있으면 자동 회전을 멈추고 가까운 쪽으로 부드럽게 정면(방위 0)에 선다", () => {
    const c = mkControls(2.5);
    const o = createStageOrbit(c, false);
    o.step(1 / 60);
    expect(c.theta).toBe(2.5); // 무대가 오기 전에는 손대지 않는다
    o.setLive(true);
    expect(c.autoRotate).toBe(false);
    o.step(1 / 60);
    expect(c.theta).toBeLessThan(2.5);
    expect(c.theta).toBeGreaterThan(0);
    for (let i = 0; i < 240; i++) o.step(1 / 60);
    expect(c.theta).toBeCloseTo(0, 4);
    // π 너머(방위 4.0 = -2.28)는 되감지 않고 가까운 쪽(2π)으로
    const c2 = mkControls(4.0);
    const o2 = createStageOrbit(c2, false);
    o2.setLive(true);
    o2.step(1 / 60);
    expect(c2.theta).toBeGreaterThan(4.0);
    for (let i = 0; i < 240; i++) o2.step(1 / 60);
    expect(Math.cos(c2.theta)).toBeCloseTo(1, 6);
  });

  it("무대가 끊기면 자동 회전을 다시 켜고 정면 복귀를 멈춘다", () => {
    const c = mkControls(1.0);
    const o = createStageOrbit(c, false);
    o.setLive(true);
    o.setLive(false);
    expect(c.autoRotate).toBe(true);
    o.step(1 / 60);
    expect(c.theta).toBe(1.0);
  });

  it("reduced-motion: 자동 회전은 늘 꺼져 있고 정면 복귀는 즉시", () => {
    const c = mkControls(0.8, false);
    const o = createStageOrbit(c, true);
    o.setLive(true);
    o.step(1 / 60);
    expect(c.theta).toBeCloseTo(0, 9);
    o.setLive(false);
    expect(c.autoRotate).toBe(false);
  });
});

describe("mountOrbitView 큰 화면 배선: 무대를 따르는 동안 자동 회전 정지, 무대 각도 그대로(진짜 OrbitControls)", () => {
  beforeEach(() => {
    gl.ok = true;
    vi.useFakeTimers();
    vi.stubGlobal("location", { origin: "https://example.test", pathname: "/app/" });
    vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.mocked(bindStageFollow).mockClear();
  });
  afterEach(() => {
    gl.ok = false;
    gl.loop = null;
    gl.controls = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(query: string | undefined, reducedMotion = false) {
    const group = new Group();
    const unmount = mountOrbitView(new FakeEl() as unknown as HTMLElement, makeCtx(query, reducedMotion, group));
    const opts: StageFollowOptions = vi.mocked(bindStageFollow).mock.calls.at(-1)![0];
    const controls = gl.controls!;
    let t = performance.now();
    const frames = (n: number) => { for (let i = 0; i < n; i++) { t += 1000 / 60; gl.loop!(t); } };
    return { unmount, opts, group, controls, frames };
  }

  it("자동 회전 → 무대가 오면 멈추고 정면에서 무대 yaw·zoom 그대로 → 끊기면 다시 돈다", () => {
    const m = mount("stage=1");
    expect(m.controls.autoRotate).toBe(true);
    m.frames(120); // 0.3 rad/s로 2초
    expect(Math.abs(m.controls.getAzimuthalAngle())).toBeGreaterThan(0.4);
    m.opts.onStage!(true);
    m.opts.onView!(1.2, 1.3);
    expect(m.controls.autoRotate).toBe(false);
    // 정면으로 곧게 돌아온다: 남은 방위가 줄기만 하고 정면을 지나쳐 되돌아오지 않는다
    const start = m.controls.getAzimuthalAngle();
    let left = Math.abs(start);
    for (let i = 0; i < 150; i++) {
      m.frames(1);
      const a = m.controls.getAzimuthalAngle();
      expect(Math.sign(a) === Math.sign(start) || Math.abs(a) < 1e-6).toBe(true);
      expect(Math.abs(a)).toBeLessThanOrEqual(left + 1e-9);
      left = Math.abs(a);
    }
    expect(m.controls.getAzimuthalAngle()).toBeCloseTo(0, 3);
    expect(m.group.rotation.y).toBeCloseTo(1.2, 3);
    expect(m.group.scale.x).toBeCloseTo(1.3, 3);
    m.frames(60);
    expect(m.controls.getAzimuthalAngle()).toBeCloseTo(0, 3); // 서 있다
    // 무대 30초 무소식: bindStageFollow가 (0, 1)과 onStage(false)를 낸다
    m.opts.onView!(0, 1);
    m.opts.onStage!(false);
    expect(m.controls.autoRotate).toBe(true);
    m.frames(120);
    expect(Math.abs(m.controls.getAzimuthalAngle())).toBeGreaterThan(0.4);
    expect(m.group.rotation.y).toBeCloseTo(0, 3);
    m.unmount();
  });

  it("reduced-motion 큰 화면: 자동 회전 없음, 무대 값은 다음 프레임에 그대로", () => {
    const m = mount("stage=1", true);
    expect(m.controls.autoRotate).toBe(false);
    m.opts.onStage!(true);
    m.opts.onView!(-2.5, 0.8);
    m.frames(1);
    expect(m.group.rotation.y).toBeCloseTo(-2.5, 6);
    expect(m.group.scale.x).toBeCloseTo(0.8, 6);
    m.opts.onStage!(false);
    expect(m.controls.autoRotate).toBe(false);
    m.unmount();
  });

  it("일반 #/3d: 무대 값·무대 생존을 받지 않고, 자동 회전·손 조작·감쇠는 그대로", () => {
    const m = mount(undefined);
    expect(m.opts.onView).toBeUndefined();
    expect(m.opts.onStage).toBeUndefined();
    expect(m.controls.autoRotate).toBe(true);
    expect(m.controls.enabled).toBe(true);
    expect(m.controls.enableDamping).toBe(true);
    m.unmount();
  });
});
