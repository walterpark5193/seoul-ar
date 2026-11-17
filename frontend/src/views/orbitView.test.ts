// #/3d 마운트 스모크. three/WebGL은 노드에 없으므로 WebGLRenderer는 던지게 하고(= 폴백 경로),
// DOM은 orbitView가 쓰는 만큼만 흉내 낸 가짜를 쓴다(jsdom 없음).
// 회귀: 큰 화면 모드(stage=1)가 .viewer 요소 자신에게 .viewer 자손 검색을 해서 마운트에서 터졌다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class { constructor() { throw new Error("no webgl (test)"); } },
}));
vi.mock("../ui/qr", () => ({ drawQr: vi.fn(() => Promise.resolve()) }));
vi.mock("../ui/sheetDom", () => ({ mountSheet: vi.fn(() => ({ render: vi.fn(), destroy: vi.fn() })) }));
vi.mock("./viewerSync", () => ({ bindViewer: vi.fn(() => vi.fn()), drawCity: vi.fn() }));
vi.mock("./stageFollow", () => ({
  bindStageFollow: vi.fn(() => vi.fn()),
  createVoteLine: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
  followLayout: vi.fn(),
}));

import { createStore } from "../state/store";
import { drawQr } from "../ui/qr";
import { createViewFollower, mountOrbitView } from "./orbitView";
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
  emit(type: string) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); }
  count(type: string) { return this.listeners.get(type)?.size ?? 0; }
}

function makeCtx(query?: string): ViewContext {
  return {
    store: createStore(),
    index: { v: 1, generatedAt: "", source: "", months: [], gus: [], summary: {} },
    config: { appUrl: "https://example.test/app" },
    loadGu: vi.fn(),
    reducedMotion: false,
    query,
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
});
