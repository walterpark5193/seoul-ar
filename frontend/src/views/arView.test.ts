import { describe, expect, it, vi } from "vitest";
import { Group, PerspectiveCamera, Scene } from "three";
import { beginAr, fallbackMessage, freezeView, mountArView } from "./arView";
import type { ViewContext } from "./types";
import type { ArSession } from "../ar/session";
import type { SeoulScene } from "../scene/seoulScene";
import { INITIAL_STATE, createStore } from "../state/store";
import { createIndexSource } from "../data/indexSource";

function fakeScene(): SeoulScene {
  return {
    group: new Group(),
    setOverview: vi.fn(), focus: vi.fn(), setMetric: vi.fn(), update: vi.fn(), dispose: vi.fn(),
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
});
