import { describe, expect, it, vi } from "vitest";
import { Group, PerspectiveCamera, Scene } from "three";
import { beginAr, fallbackMessage, mountArView } from "./arView";
import type { ViewContext } from "./types";
import type { ArSession } from "../ar/session";
import type { SeoulScene } from "../scene/seoulScene";
import { INITIAL_STATE, createStore } from "../state/store";

function fakeScene(): SeoulScene {
  return {
    group: new Group(),
    setOverview: vi.fn(), focus: vi.fn(), setMetric: vi.fn(), update: vi.fn(), dispose: vi.fn(),
  };
}

function fakeSession(start: () => Promise<void>) {
  const hooks: { found?: () => void; lost?: () => void; frame?: (dt: number) => void } = {};
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
  };
  return { session, hooks };
}

function fakeCtx(arSupported: () => boolean, createArSession = vi.fn()): ViewContext {
  return {
    store: createStore({ ...INITIAL_STATE, month: "202611" }),
    index: { v: 1, generatedAt: "", source: "", months: ["202611"], gus: [], summary: {} },
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

  it("explains the fallback in plain words", () => {
    expect(fallbackMessage(Object.assign(new Error(""), { name: "NotAllowedError" }))).toContain("권한");
    expect(fallbackMessage(Object.assign(new Error(""), { name: "NotFoundError" }))).toContain("카메라를 찾지 못해");
    expect(fallbackMessage(new Error("x"))).toContain("3D 화면으로 바꿨습니다");
  });
});
