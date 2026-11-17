import { describe, expect, it, vi } from "vitest";
import { Group, PerspectiveCamera, Scene } from "three";
vi.mock("../ui/sheetDom", () => ({ mountSheet: () => ({ render: () => {}, destroy: () => {} }) }));

import { beginAr, fallbackMessage, freezeView, mountArView } from "./arView";
import type { ViewContext } from "./types";
import type { ArSession } from "../ar/session";
import type { SeoulScene } from "../scene/seoulScene";
import type { StageChannelMessage } from "../stage/net/messages";
import { INITIAL_STATE, createStore } from "../state/store";
import { createIndexSource } from "../data/indexSource";

function fakeScene(): SeoulScene {
  return {
    group: new Group(),
    setOverview: vi.fn(), focus: vi.fn(), setMetric: vi.fn(), update: vi.fn(), dispose: vi.fn(),
    setHover: vi.fn(), lift: vi.fn(), setLayout: vi.fn(), pick: vi.fn(() => null),
  };
}

/** CONTRACTS 5절(안정화와 고정 포함)을 따르는 가짜 세션. freeze/unfreeze는 onFreeze 구독자에게 알린다. */
function fakeSession(start: () => Promise<void>) {
  const hooks: { found?: () => void; lost?: () => void; frame?: (dt: number) => void } = {};
  const freezeSubs = new Set<(frozen: boolean) => void>();
  let frozen = false;
  const setFrozen = (f: boolean) => { if (f === frozen) return; frozen = f; for (const cb of freezeSubs) cb(f); };
  const session: ArSession = {
    anchor: new Group(),
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: { dispose: vi.fn(), forceContextLoss: vi.fn() } as unknown as ArSession["renderer"],
    start: vi.fn(start),
    stop: vi.fn(),
    onFound: (cb) => { hooks.found = cb; },
    onLost: (cb) => { hooks.lost = cb; },
    onFrame: (cb) => { hooks.frame = cb; },
    freeze: vi.fn(() => setFrozen(true)),
    unfreeze: vi.fn(() => setFrozen(false)),
    get frozen() { return frozen; },
    onFreeze: (cb) => { freezeSubs.add(cb); return () => { freezeSubs.delete(cb); }; },
  };
  return { session, hooks, freezeSubs };
}

async function startFake(session: ArSession, onFreezeState = vi.fn()) {
  const scene = fakeScene();
  const running = await beginAr({
    container: {} as HTMLElement,
    createArSession: () => session,
    createScene: () => scene,
    onFound: vi.fn(), onLost: vi.fn(), onFail: vi.fn(), onFreezeState,
  });
  return { running: running!, scene, onFreezeState };
}

const stageHandlers = new Set<(m: StageChannelMessage) => void>();
const emitStage = (m: StageChannelMessage) => { for (const h of [...stageHandlers]) h(m); };

function fakeCtx(arSupported: () => boolean, createArSession = vi.fn()): ViewContext {
  return {
    store: createStore({ ...INITIAL_STATE, month: "202611" }),
    index: { v: 1, generatedAt: "", source: "", months: ["202611"], gus: [], summary: {} },
    indexSource: createIndexSource({ v: 1, generatedAt: "", source: "", months: ["202611"], gus: [], summary: {} }, vi.fn()),
    config: { v: 1, appUrl: null, events: null },
    realtime: {} as ViewContext["realtime"],
    loadGu: vi.fn(),
    navigate: vi.fn(),
    toast: vi.fn(),
    createScene: vi.fn(fakeScene),
    reducedMotion: false,
    stageChannel: { subscribe: (h: (m: StageChannelMessage) => void) => { stageHandlers.add(h); return () => { stageHandlers.delete(h); }; } } as unknown as ViewContext["stageChannel"],
    ar: { arSupported, createArSession },
  };
}

describe("arView", () => {
  it("arView falls back when arSupported() false", () => {
    const createArSession = vi.fn();
    const ctx = fakeCtx(() => false, createArSession);
    const unmount = mountArView({} as HTMLElement, ctx);
    expect(ctx.navigate).toHaveBeenCalledWith("#/3d");
    expect(ctx.toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.toast).mock.calls[0]?.[0]).toContain("3D");
    expect(createArSession).not.toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });

  it("puts the city on the anchor and drives it each frame", async () => {
    const { session, hooks } = fakeSession(async () => {});
    const scene = fakeScene();
    const onFound = vi.fn();
    const onLost = vi.fn();
    const onFail = vi.fn();
    const running = await beginAr({
      container: {} as HTMLElement,
      createArSession: (opts) => {
        expect(opts.targetSrc).toBe("/marker/target.mind");
        return session;
      },
      createScene: () => scene,
      onFound, onLost, onFail,
    });
    expect(running).not.toBeNull();
    expect(session.start).toHaveBeenCalled();
    // CONTRACTS 5절 보강: 회전은 anchor 쪽 책임, 뷰는 씬 그룹을 그대로 add.
    expect(session.anchor.children).toContain(scene.group);
    expect(scene.group.rotation.x).toBe(0);
    hooks.frame?.(0.016);
    expect(scene.update).toHaveBeenCalledWith(0.016, session.camera);
    hooks.found?.();
    hooks.lost?.();
    expect(onFound).toHaveBeenCalled();
    expect(onLost).toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
    running?.stop();
    expect(session.stop).toHaveBeenCalled();
    expect(scene.dispose).toHaveBeenCalled();
    expect(session.renderer.dispose).toHaveBeenCalled();
    expect(session.renderer.forceContextLoss).toHaveBeenCalled();
  });

  it("reports failure and cleans up when the camera is refused", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { session } = fakeSession(async () => { throw denied; });
    const scene = fakeScene();
    const onFail = vi.fn();
    const running = await beginAr({
      container: {} as HTMLElement,
      createArSession: () => session,
      createScene: () => scene,
      onFound: vi.fn(), onLost: vi.fn(), onFail,
    });
    expect(running).toBeNull();
    expect(onFail).toHaveBeenCalledWith(denied);
    expect(session.stop).toHaveBeenCalled();
    expect(scene.dispose).toHaveBeenCalled();
    expect(session.renderer.forceContextLoss).toHaveBeenCalled();
  });

  it("passes hash tuning options into createArSession without letting them override container or target", async () => {
    const { session } = fakeSession(async () => {});
    const container = {} as HTMLElement;
    let seen: unknown = null;
    await beginAr({
      container,
      createArSession: (opts) => { seen = opts; return session; },
      createScene: fakeScene,
      onFound: vi.fn(), onLost: vi.fn(), onFail: vi.fn(),
      tuning: { filterMinCF: 0.0005, missTolerance: 20, smoothing: { holdMs: 1200 } },
    });
    expect(seen).toEqual({
      container, targetSrc: "/marker/target.mind",
      filterMinCF: 0.0005, missTolerance: 20, smoothing: { holdMs: 1200 },
    });
  });

  it("passes only container and target when there is no tuning", async () => {
    const { session } = fakeSession(async () => {});
    const container = {} as HTMLElement;
    let seen: unknown = null;
    await beginAr({
      container,
      createArSession: (opts) => { seen = opts; return session; },
      createScene: fakeScene,
      onFound: vi.fn(), onLost: vi.fn(), onFail: vi.fn(),
    });
    expect(seen).toEqual({ container, targetSrc: "/marker/target.mind" });
  });

  describe("touch: turn and zoom the city on the marker (Task 4g)", () => {
    const onStage = { closest: () => null };
    const onSheet = { closest: (sel: string) => (sel.includes(".sheet-host") ? {} : null) };

    async function started(opts: { reducedMotion?: boolean } = {}) {
      const { session, hooks } = fakeSession(async () => {});
      const scene = fakeScene();
      const onPoseChange = vi.fn();
      const running = (await beginAr({
        container: {} as HTMLElement,
        createArSession: () => session,
        createScene: () => scene,
        onFound: vi.fn(), onLost: vi.fn(), onFail: vi.fn(),
        reducedMotion: opts.reducedMotion ?? false,
        onPoseChange,
      }))!;
      return { running, scene, session, hooks, onPoseChange };
    }

    it("a one-finger horizontal drag turns scene.group around its up axis", async () => {
      const { running, scene, onPoseChange } = await started();
      running.gestures.pointerDown(1, 100, 300, onStage);
      running.gestures.pointerMove(1, 200, 500);
      expect(scene.group.rotation.y).toBeCloseTo(1.2);
      expect(scene.group.rotation.x).toBe(0);
      expect(onPoseChange).toHaveBeenLastCalledWith(false);
    });

    it("pinch scales scene.group uniformly and clamps", async () => {
      const { running, scene } = await started();
      running.gestures.pointerDown(1, 0, 0, onStage);
      running.gestures.pointerDown(2, 100, 0, onStage);
      running.gestures.pointerMove(2, 1000, 0);
      expect(scene.group.scale.toArray()).toEqual([1.6, 1.6, 1.6]);
    });

    it("drags that start on the sheet are ignored", async () => {
      const { running, scene } = await started();
      expect(running.gestures.pointerDown(1, 0, 0, onSheet)).toBe(false);
      running.gestures.pointerMove(1, 300, 0);
      expect(scene.group.rotation.y).toBe(0);
    });

    it("원위치 eases back on the render loop and reports the default pose", async () => {
      const { running, scene, hooks, onPoseChange } = await started();
      running.gestures.pointerDown(1, 0, 0, onStage);
      running.gestures.pointerMove(1, 100, 0);
      running.gestures.pointerUp(1);
      running.gestures.reset();
      hooks.frame?.(0.3);
      expect(scene.group.rotation.y).toBeGreaterThan(0);
      hooks.frame?.(0.4);
      expect(scene.group.rotation.y).toBe(0);
      expect(scene.group.scale.x).toBe(1);
      expect(onPoseChange).toHaveBeenLastCalledWith(true);
      expect(scene.update).toHaveBeenCalled();
    });

    it("still works while frozen", async () => {
      const { running, scene, session, hooks } = await started();
      hooks.found?.();
      running.toggleFreeze();
      expect(session.frozen).toBe(true);
      running.gestures.pointerDown(1, 0, 0, onStage);
      running.gestures.pointerMove(1, -50, 0);
      expect(scene.group.rotation.y).toBeCloseTo(-0.6);
    });

    it("reduced motion resets at once", async () => {
      const { running, scene } = await started({ reducedMotion: true });
      running.gestures.pointerDown(1, 0, 0, onStage);
      running.gestures.pointerMove(1, 100, 0);
      running.gestures.reset();
      expect(scene.group.rotation.y).toBe(0);
    });
  });

  describe("화면 고정 toggle", () => {
    it("is disabled until the target has been found once", async () => {
      const { session, hooks } = fakeSession(async () => {});
      const { running, onFreezeState } = await startFake(session);
      expect(onFreezeState).toHaveBeenLastCalledWith({ enabled: false, frozen: false });
      running.toggleFreeze();
      expect(session.freeze).not.toHaveBeenCalled();
      hooks.found?.();
      expect(onFreezeState).toHaveBeenLastCalledWith({ enabled: true, frozen: false });
      hooks.lost?.();
      expect(onFreezeState).toHaveBeenLastCalledWith({ enabled: true, frozen: false });
    });

    it("freezes and unfreezes the session and reports the state", async () => {
      const { session, hooks } = fakeSession(async () => {});
      const { running, onFreezeState } = await startFake(session);
      hooks.found?.();
      running.toggleFreeze();
      expect(session.freeze).toHaveBeenCalledTimes(1);
      expect(onFreezeState).toHaveBeenLastCalledWith({ enabled: true, frozen: true });
      running.toggleFreeze();
      expect(session.unfreeze).toHaveBeenCalledTimes(1);
      expect(onFreezeState).toHaveBeenLastCalledWith({ enabled: true, frozen: false });
    });

    it("unfreezes, unsubscribes and stops on unmount", async () => {
      const { session, hooks, freezeSubs } = fakeSession(async () => {});
      const { running, scene } = await startFake(session);
      hooks.found?.();
      running.toggleFreeze();
      running.stop();
      expect(session.unfreeze).toHaveBeenCalledTimes(1);
      const unfreezeAt = vi.mocked(session.unfreeze).mock.invocationCallOrder[0]!;
      const stopAt = vi.mocked(session.stop).mock.invocationCallOrder[0]!;
      expect(unfreezeAt).toBeLessThan(stopAt);
      expect(freezeSubs.size).toBe(0);
      expect(scene.dispose).toHaveBeenCalled();
    });

    it("stays disabled on a session that has no freeze support", async () => {
      const { session, hooks } = fakeSession(async () => {});
      const legacy = { ...session, freeze: undefined, unfreeze: undefined, onFreeze: undefined } as unknown as ArSession;
      const { running, onFreezeState } = await startFake(legacy);
      hooks.found?.();
      running.toggleFreeze();
      expect(onFreezeState).toHaveBeenLastCalledWith({ enabled: false, frozen: false });
      expect(() => running.stop()).not.toThrow();
    });

    it("labels: 화면 고정 when tracking, 다시 추적 and 고정됨 when frozen", () => {
      expect(freezeView({ enabled: false, frozen: false })).toEqual({ label: "화면 고정", status: null, disabled: true });
      expect(freezeView({ enabled: true, frozen: false })).toEqual({ label: "화면 고정", status: null, disabled: false });
      expect(freezeView({ enabled: true, frozen: true })).toEqual({ label: "다시 추적", status: "고정됨", disabled: false });
    });
  });

  it("explains the fallback in plain words", () => {
    expect(fallbackMessage(Object.assign(new Error(""), { name: "NotAllowedError" }))).toContain("권한");
    expect(fallbackMessage(Object.assign(new Error(""), { name: "NotFoundError" }))).toContain("카메라를 찾지 못해");
    expect(fallbackMessage(new Error("x"))).toContain("3D 화면으로 바꿨습니다");
  });

  function fakeRoot() {
    const listeners = new Map<string, () => void>();
    const els: Record<string, { hidden: boolean; textContent: string; addEventListener(t: string, f: () => void): void }> = {};
    const mk = (k: string) => (els[k] = { hidden: true, textContent: "", addEventListener: (t, f) => { listeners.set(`${k}:${t}`, f); } });
    const root = {
      set innerHTML(_v: string) {},
      querySelector: (sel: string) => {
        const k = /data-(\w+)/.exec(sel)?.[1] ?? "x";
        return els[k] ?? mk(k);
      },
    } as unknown as HTMLElement;
    return { root, els, listeners };
  }

  it("hides the stage banner when the stage goes quiet for 30 s, shows it again on the next StageMessage", () => {
    vi.useFakeTimers();
    try {
      const { root, els } = fakeRoot();
      const unmount = mountArView(root, fakeCtx(() => true));
      emitStage({ v: 1, type: "stage", mode: "spread", lifted: null, ts: 1 });
      expect(els.banner?.hidden).toBe(false);
      vi.advanceTimersByTime(10_000);
      emitStage({ v: 1, type: "stage", mode: "spread", lifted: null, ts: 2 }); // 하트비트
      vi.advanceTimersByTime(29_999);
      expect(els.banner?.hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(els.banner?.hidden).toBe(true);
      emitStage({ v: 1, type: "stage", mode: "map", lifted: null, ts: 3 });
      expect(els.banner?.hidden).toBe(false);
      unmount();
      expect(stageHandlers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the stage banner on the first StageMessage and taps through to #/3d", () => {
    const { root, els, listeners } = fakeRoot();
    const ctx = fakeCtx(() => true);
    const unmount = mountArView(root, ctx);
    expect(els.banner?.hidden).toBe(true);
    emitStage({ v: 1, type: "stage", mode: "spread", lifted: null, ts: 1 });
    expect(els.banner?.hidden).toBe(false);
    listeners.get("banner:click")?.();
    expect(ctx.navigate).toHaveBeenCalledWith("#/3d");
    emitStage({ v: 1, type: "vote", round: 1, phase: "result", candidates: ["강남구", "마포구", "노원구"], counts: [2, 1, 0], winner: "강남구", ts: 2 });
    expect(els.vote?.textContent).toBe("투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표");
    expect(els.vote?.hidden).toBe(false);
    unmount();
  });
});
