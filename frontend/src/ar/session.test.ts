import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real bundle touches `window` at import time and needs WebGL; replace it with a
// scriptable fake so the wrapper's wiring can be verified in Node.
const fake = vi.hoisted(() => {
  const state = {
    ctorArgs: [] as unknown[],
    instances: [] as FakeMindAR[],
  };
  class FakeAnchor {
    // Duck-typed stand-in for MindAR's THREE.Group: carries the pose matrix MindAR writes each update.
    group = {
      kind: "group",
      visible: false,
      matrix: null as unknown, // set to a THREE.Matrix4 by the test helper (three cannot be imported here)
      children: [] as unknown[],
      add(obj: unknown) {
        this.children.push(obj);
      },
    };
    visible = false;
    targetIndex: number;
    onTargetFound: (() => void) | null = null;
    onTargetLost: (() => void) | null = null;
    onTargetUpdate: (() => void) | null = null;
    constructor(i: number) {
      this.targetIndex = i;
    }
  }
  class FakeMindAR {
    scene = {
      kind: "scene",
      children: [] as unknown[],
      add(obj: unknown) {
        this.children.push(obj);
      },
    };
    camera = { kind: "camera" };
    renderer = {
      loop: null as ((t: number) => void) | null,
      setAnimationLoop: vi.fn(function (this: { loop: unknown }, cb: ((t: number) => void) | null) {
        this.loop = cb;
      }),
      render: vi.fn(),
    };
    video:
      | { srcObject: unknown; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
      | undefined = undefined;
    anchors: FakeAnchor[] = [];
    started = 0;
    stopped = 0;
    startImpl: () => Promise<void> = async () => {};
    constructor(opts: unknown) {
      state.ctorArgs.push(opts);
      state.instances.push(this);
    }
    addAnchor(i: number) {
      const a = new FakeAnchor(i);
      this.anchors.push(a);
      return a;
    }
    async start() {
      this.started++;
      // MindAR creates a fresh <video> (no stream yet) before asking for the camera; a granted
      // stream shows up as video.srcObject.
      this.video = { srcObject: null, pause: vi.fn(), play: vi.fn(() => Promise.resolve()), remove: vi.fn() };
      await this.startImpl();
    }
    stop() {
      this.stopped++;
    }
  }
  return { state, FakeMindAR };
});

vi.mock("mind-ar/dist/mindar-image-three.prod.js", () => ({ MindARThree: fake.FakeMindAR }));

import { Group, Matrix4, Quaternion, Vector3 } from "three";
import { arSupported, createArSession, START_TIMEOUT_MS, PERMISSION_TIMEOUT_MS, FILTER_DEFAULTS } from "./session";

type GL = { kind: string } | null;
function env(opts: { gum?: boolean; gl?: GL | "throw"; nav?: boolean }) {
  const nav =
    opts.nav === false
      ? undefined
      : opts.gum === false
        ? { mediaDevices: {} }
        : { mediaDevices: { getUserMedia: () => Promise.resolve({}) } };
  const createCanvas = () => ({
    getContext: (_kind: string) => {
      if (opts.gl === "throw") throw new Error("no gl");
      return opts.gl === undefined ? { kind: "webgl2" } : opts.gl;
    },
  });
  return { nav, createCanvas };
}

describe("arSupported decision table", () => {
  it("getUserMedia missing -> false", () => {
    expect(arSupported(env({ gum: false }))).toBe(false);
  });
  it("navigator missing entirely -> false", () => {
    expect(arSupported(env({ nav: false }))).toBe(false);
  });
  it("WebGL context null -> false", () => {
    expect(arSupported(env({ gl: null }))).toBe(false);
  });
  it("getContext throwing -> false", () => {
    expect(arSupported(env({ gl: "throw" }))).toBe(false);
  });
  it("getUserMedia + WebGL both present -> true", () => {
    expect(arSupported(env({}))).toBe(true);
  });
  it("falls back from webgl2 to webgl", () => {
    const createCanvas = () => ({
      getContext: (kind: string) => (kind === "webgl" ? { kind } : null),
    });
    expect(arSupported({ nav: env({}).nav, createCanvas })).toBe(true);
  });
  it("without injected deps it evaluates the real globals and does not throw in Node", () => {
    expect(typeof arSupported()).toBe("boolean");
  });
});

/** A response that looks like a real .mind: msgpack fixmap header (0x82 = map of 2: { v, dataList }). */
function mindResponse(body: Uint8Array = new Uint8Array([0x82, 0xa1, 0x76, 0x02]), init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

type Inst = InstanceType<typeof fake.FakeMindAR>;
const SCALE = 1024; // MindAR scales its anchor group by the target image width (px)

/** Simulate one MindAR controller update: pose matrix (position, quaternion, uniform scale) + visibility. */
function observe(inst: Inst, o: { visible: boolean; position?: [number, number, number]; rotX?: number }) {
  const a = inst.anchors[0]!;
  a.visible = o.visible;
  a.group.visible = o.visible;
  if (o.visible) {
    const [x, y, z] = o.position ?? [0, 0, -1500];
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), o.rotX ?? 0);
    a.group.matrix = new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(SCALE, SCALE, SCALE));
  } else {
    a.group.matrix = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1); // MindAR's "invisible" matrix
  }
}

describe("createArSession wiring", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fake.state.ctorArgs.length = 0;
    fake.state.instances.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => mindResponse());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const container = { tagName: "DIV" } as unknown as HTMLElement;
  const make = (extra: Record<string, unknown> = {}) => createArSession({ container, targetSrc: "/marker/target.mind", ...extra });

  it("constructs MindARThree with the container and targetSrc, exposes scene/camera/renderer", () => {
    const s = make();
    const opts = fake.state.ctorArgs[0] as { container: unknown; imageTargetSrc: string };
    expect(opts.container).toBe(container);
    expect(opts.imageTargetSrc).toBe("/marker/target.mind");
    const inst = fake.state.instances[0]!;
    expect(inst.anchors[0]!.targetIndex).toBe(0);
    expect(s.scene).toBe(inst.scene);
    expect(s.camera).toBe(inst.camera);
    expect(s.renderer).toBe(inst.renderer);
  });

  it("disables MindAR's body-level overlays (the app owns loading/scanning UX)", () => {
    make();
    const opts = fake.state.ctorArgs[0] as Record<string, unknown>;
    expect(opts.uiLoading).toBe("no");
    expect(opts.uiScanning).toBe("no");
    expect(opts.uiError).toBe("no");
  });

  it("passes the MindAR One-Euro filter / tolerance defaults from CONTRACTS 5 to the constructor", () => {
    make();
    const opts = fake.state.ctorArgs[0] as Record<string, unknown>;
    expect(FILTER_DEFAULTS).toEqual({ filterMinCF: 0.0001, filterBeta: 0.01, warmupTolerance: 5, missTolerance: 10 });
    expect(opts.filterMinCF).toBe(0.0001);
    expect(opts.filterBeta).toBe(0.01);
    expect(opts.warmupTolerance).toBe(5);
    expect(opts.missTolerance).toBe(10);
  });

  it("forwards explicit filter / tolerance overrides", () => {
    make({ filterMinCF: 0.001, filterBeta: 1000, warmupTolerance: 2, missTolerance: 3 });
    const opts = fake.state.ctorArgs[0] as Record<string, unknown>;
    expect(opts.filterMinCF).toBe(0.001);
    expect(opts.filterBeta).toBe(1000);
    expect(opts.warmupTolerance).toBe(2);
    expect(opts.missTolerance).toBe(3);
  });

  it("anchor is an inner Group rotated +90deg about x, inside a follower group under scene (not under MindAR's anchor group)", () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    const mindarGroup = inst.anchors[0]!.group;
    expect(s.anchor).toBeInstanceOf(Group);
    expect(s.anchor).not.toBe(mindarGroup);
    expect(mindarGroup.children).toEqual([]); // nothing of ours hangs off MindAR's jittery group
    const follower = s.anchor.parent!;
    expect(follower).toBeInstanceOf(Group);
    expect(inst.scene.children).toContain(follower);
    expect(follower.visible).toBe(false); // hidden until the target is first seen
    expect(s.anchor.rotation.x).toBeCloseTo(Math.PI / 2, 10);
    expect(s.anchor.rotation.y).toBe(0);
    expect(s.anchor.rotation.z).toBe(0);
    // Scene "up" (y) must come out of the picture toward the camera (MindAR +z),
    // and scene "south" (+z) must point to the bottom edge of the picture (MindAR -y).
    s.anchor.updateMatrixWorld(true);
    const up = s.anchor.localToWorld(new Group().position.set(0, 1, 0));
    expect(up.x).toBeCloseTo(0, 10);
    expect(up.y).toBeCloseTo(0, 10);
    expect(up.z).toBeCloseTo(1, 10);
    const south = s.anchor.localToWorld(new Group().position.set(0, 0, 1));
    expect(south.y).toBeCloseTo(-1, 10);
    expect(south.z).toBeCloseTo(0, 10);
  });

  it("start() checks the target file first, then starts MindAR and drives onFrame with dt in seconds", async () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    const dts: number[] = [];
    s.onFrame((dt) => dts.push(dt));
    await s.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/marker/target.mind");
    expect(inst.started).toBe(1);
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledTimes(1);
    const loop = inst.renderer.loop!;
    loop(1000);
    loop(1016);
    loop(1050);
    expect(dts[0]).toBe(0); // first tick has no previous timestamp
    expect(dts[1]).toBeCloseTo(0.016, 5);
    expect(dts[2]).toBeCloseTo(0.034, 5);
    expect(inst.renderer.render).toHaveBeenCalledTimes(3);
    expect(inst.renderer.render).toHaveBeenLastCalledWith(inst.scene, inst.camera);
  });

  it("clamps dt after a long pause (tab hidden) so animations do not jump", async () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    const dts: number[] = [];
    s.onFrame((dt) => dts.push(dt));
    await s.start();
    const loop = inst.renderer.loop!;
    loop(0);
    loop(5000);
    expect(dts[1]).toBeLessThanOrEqual(0.1);
  });

  describe("follower smoothing (scene graph)", () => {
    it("snaps on first sight, then follows a moving MindAR group with the 0.18 lerp and copies MindAR's scale", async () => {
      const s = make();
      const inst = fake.state.instances[0]!;
      await s.start();
      const loop = inst.renderer.loop!;
      const follower = s.anchor.parent!;
      observe(inst, { visible: true, position: [100, 20, -1500], rotX: 0.3 });
      loop(0);
      expect(follower.visible).toBe(true);
      expect(follower.position.toArray()).toEqual([100, 20, -1500]);
      for (const c of follower.scale.toArray()) expect(c).toBeCloseTo(SCALE, 6);
      expect(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3).angleTo(follower.quaternion)).toBeCloseTo(0, 6);
      observe(inst, { visible: true, position: [200, 20, -1500], rotX: 0.3 });
      loop(1000 / 60);
      expect(follower.position.x).toBeCloseTo(118, 3); // 18% of the way at 60 fps
      for (let i = 2; i < 150; i++) loop((i * 1000) / 60);
      expect(follower.position.x).toBeCloseTo(200, 2);
    });

    it("ignores sub-deadband noise: the follower's transform stays bit-identical while the hand trembles", async () => {
      const s = make();
      const inst = fake.state.instances[0]!;
      await s.start();
      const loop = inst.renderer.loop!;
      const follower = s.anchor.parent!;
      observe(inst, { visible: true, position: [100, 20, -1500], rotX: 0.3 });
      loop(0);
      const before = { p: follower.position.toArray(), q: follower.quaternion.toArray() };
      for (let i = 1; i <= 60; i++) {
        const sign = i % 2 ? 1 : -1;
        // 1.5 world units = 0.0015 target widths (< 0.004), 0.004 rad (< 0.01)
        observe(inst, { visible: true, position: [100 + sign * 1.5, 20 - sign * 2, -1500 + sign], rotX: 0.3 + sign * 0.004 });
        loop((i * 1000) / 60);
        expect(follower.position.toArray()).toEqual(before.p);
        expect(follower.quaternion.toArray()).toEqual(before.q);
      }
    });

    it("keeps the last pose visible for holdMs after loss, then hides; re-acquire after hiding snaps", async () => {
      const s = make({ smoothing: { holdMs: 500 } });
      const inst = fake.state.instances[0]!;
      await s.start();
      const loop = inst.renderer.loop!;
      const follower = s.anchor.parent!;
      observe(inst, { visible: true, position: [100, 0, -1500] });
      loop(0);
      observe(inst, { visible: false });
      loop(16);
      loop(16 + 499);
      expect(follower.visible).toBe(true);
      expect(follower.position.x).toBe(100);
      loop(16 + 500);
      expect(follower.visible).toBe(false);
      observe(inst, { visible: true, position: [300, 0, -1200] });
      loop(16 + 520);
      expect(follower.visible).toBe(true);
      expect(follower.position.x).toBe(300); // snap, no slide from the stale pose
    });
  });

  describe("onFound / onLost", () => {
    it("found fires on the first tick that sees the target; lost only after the hold expires", async () => {
      const s = make({ smoothing: { holdMs: 500 } });
      const inst = fake.state.instances[0]!;
      const found = vi.fn();
      const found2 = vi.fn();
      const lost = vi.fn();
      s.onFound(found);
      s.onFound(found2);
      s.onLost(lost);
      await s.start();
      const loop = inst.renderer.loop!;
      observe(inst, { visible: true });
      expect(found).not.toHaveBeenCalled(); // reported on our frame tick, not inside MindAR's callback
      loop(0);
      expect(found).toHaveBeenCalledTimes(1);
      expect(found2).toHaveBeenCalledTimes(1);
      observe(inst, { visible: false });
      loop(100);
      loop(100 + 499);
      expect(lost).not.toHaveBeenCalled();
      loop(100 + 500);
      expect(lost).toHaveBeenCalledTimes(1);
      observe(inst, { visible: true });
      loop(700);
      expect(found).toHaveBeenCalledTimes(2);
    });

    it("a loss shorter than the hold produces no lost/found flicker", async () => {
      const s = make();
      const inst = fake.state.instances[0]!;
      const found = vi.fn();
      const lost = vi.fn();
      s.onFound(found);
      s.onLost(lost);
      await s.start();
      const loop = inst.renderer.loop!;
      observe(inst, { visible: true });
      loop(0);
      observe(inst, { visible: false });
      loop(100);
      loop(400);
      observe(inst, { visible: true });
      loop(500);
      expect(found).toHaveBeenCalledTimes(1);
      expect(lost).not.toHaveBeenCalled();
    });
  });

  describe("freeze / unfreeze", () => {
    it("starts unfrozen; freeze pauses the video, keeps rendering and onFrame, stops pose updates; unfreeze resumes", async () => {
      const s = make();
      const inst = fake.state.instances[0]!;
      const frames = vi.fn();
      s.onFrame(frames);
      await s.start();
      const loop = inst.renderer.loop!;
      const follower = s.anchor.parent!;
      observe(inst, { visible: true, position: [100, 0, -1500] });
      loop(0);
      expect(s.frozen).toBe(false);

      const onFreeze = vi.fn();
      const off = s.onFreeze(onFreeze);
      s.freeze();
      expect(s.frozen).toBe(true);
      expect(inst.video!.pause).toHaveBeenCalledTimes(1);
      expect(onFreeze).toHaveBeenCalledWith(true);
      s.freeze(); // idempotent
      expect(onFreeze).toHaveBeenCalledTimes(1);

      observe(inst, { visible: true, position: [500, 0, -1500] });
      loop(16);
      loop(32);
      expect(follower.position.x).toBe(100); // pose frozen
      expect(follower.visible).toBe(true);
      expect(inst.renderer.render).toHaveBeenCalledTimes(3); // render loop keeps running
      expect(frames).toHaveBeenCalledTimes(3);

      s.unfreeze();
      expect(s.frozen).toBe(false);
      expect(inst.video!.play).toHaveBeenCalledTimes(1);
      expect(onFreeze).toHaveBeenLastCalledWith(false);
      loop(48);
      expect(follower.position.x).toBeGreaterThan(100); // pose updates resumed (lerping toward 500)
      s.unfreeze(); // idempotent
      expect(onFreeze).toHaveBeenCalledTimes(2);

      off();
      s.freeze();
      expect(onFreeze).toHaveBeenCalledTimes(2); // unsubscribed
    });

    it("suppresses onFound/onLost while frozen and reconciles after unfreeze with a fresh hold", async () => {
      const s = make({ smoothing: { holdMs: 500 } });
      const inst = fake.state.instances[0]!;
      const found = vi.fn();
      const lost = vi.fn();
      s.onFound(found);
      s.onLost(lost);
      await s.start();
      const loop = inst.renderer.loop!;
      const follower = s.anchor.parent!;
      observe(inst, { visible: true });
      loop(0);
      expect(found).toHaveBeenCalledTimes(1);
      s.freeze();
      observe(inst, { visible: false });
      loop(100);
      loop(5000); // far beyond holdMs
      expect(lost).not.toHaveBeenCalled();
      expect(follower.visible).toBe(true); // frozen keeps the last pose indefinitely
      s.unfreeze();
      loop(5016);
      expect(lost).not.toHaveBeenCalled(); // hold restarts at unfreeze, no instant disappearance
      loop(5016 + 500);
      expect(lost).toHaveBeenCalledTimes(1);
      expect(follower.visible).toBe(false);
      // found while frozen is also held back until unfreeze
      s.freeze();
      observe(inst, { visible: true });
      loop(6000);
      expect(found).toHaveBeenCalledTimes(1);
      s.unfreeze();
      loop(6016);
      expect(found).toHaveBeenCalledTimes(2);
    });

    it("freeze before start() is harmless, and stop() works while frozen (and clears frozen)", async () => {
      const s = make();
      const inst = fake.state.instances[0]!;
      expect(() => s.freeze()).not.toThrow();
      expect(s.frozen).toBe(true);
      s.unfreeze();
      await s.start();
      s.freeze();
      s.stop();
      expect(inst.stopped).toBe(1);
      expect(s.frozen).toBe(false);
    });
  });

  it("stop() clears the animation loop before stopping MindAR, and is safe before start()", async () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    expect(() => s.stop()).not.toThrow();
    expect(inst.stopped).toBe(0); // nothing to stop yet
    await s.start();
    const order: string[] = [];
    inst.renderer.setAnimationLoop.mockImplementation((cb: unknown) => order.push(`loop:${cb === null ? "null" : "fn"}`));
    inst.stop = () => order.push("stop");
    s.stop();
    expect(order).toEqual(["loop:null", "stop"]);
  });

  it("stop() during a pending start() releases the camera at once and again when start lands; the loop never starts", async () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    let resolveStart: () => void = () => {};
    const mindarStarted = new Promise<void>((started) => {
      inst.startImpl = () => new Promise<void>((r) => { resolveStart = r; started(); });
    });
    const pending = s.start();
    await mindarStarted; // target check passed, MindAR's start() is now waiting on the camera
    s.stop(); // user left the AR view while the permission prompt was open
    expect(inst.stopped).toBe(1); // released immediately, even though we were never "running"
    resolveStart();
    await pending;
    expect(inst.started).toBe(1);
    expect(inst.stopped).toBe(2); // MindAR acquired the stream after our stop(); released again
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledTimes(1);
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledWith(null);
    expect(inst.renderer.loop).toBeNull();
  });

  it("start() while already running is a no-op, and concurrent start() calls share one attempt", async () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    const [a, b] = [s.start(), s.start()];
    expect(a).toBe(b);
    await a;
    await s.start();
    expect(inst.started).toBe(1);
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledTimes(1);
  });

  it("start() rejects with an Error (not undefined) when the camera cannot start", async () => {
    const s = make();
    const inst = fake.state.instances[0]!;
    inst.startImpl = () => Promise.reject(undefined); // MindAR rejects with no value on getUserMedia failure
    await expect(s.start()).rejects.toBeInstanceOf(Error);
    expect(inst.renderer.setAnimationLoop).not.toHaveBeenCalled();
  });

  it("start() rejects before opening the camera when the target 404s", async () => {
    fetchMock.mockImplementation(async () => mindResponse(new Uint8Array(0), { ok: false, status: 404 }));
    const s = make();
    const inst = fake.state.instances[0]!;
    await expect(s.start()).rejects.toThrow(/404/);
    expect(inst.started).toBe(0); // getUserMedia never requested
    expect(inst.renderer.setAnimationLoop).not.toHaveBeenCalled();
  });

  it("start() rejects before opening the camera when the SPA fallback serves index.html instead of the .mind", async () => {
    fetchMock.mockImplementation(async () => mindResponse(new TextEncoder().encode("<!doctype html><html></html>")));
    const s = make();
    const inst = fake.state.instances[0]!;
    await expect(s.start()).rejects.toThrow(/\.mind|index\.html/);
    expect(inst.started).toBe(0);
  });

  it("start() rejects before opening the camera when the target download is empty or fails", async () => {
    fetchMock.mockImplementation(async () => mindResponse(new Uint8Array(0)));
    const s = make();
    await expect(s.start()).rejects.toThrow(/비어/);
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await expect(s.start()).rejects.toThrow(/Failed to fetch/);
    expect(fake.state.instances[0]!.started).toBe(0);
  });

  it("start() times out when MindAR never settles (bad target decode) and releases the live camera", async () => {
    vi.useFakeTimers();
    const s = make();
    const inst = fake.state.instances[0]!;
    inst.startImpl = () => new Promise<void>(() => {}); // _startAR hangs forever, camera already on
    const attempt = s.start();
    const rejection = expect(attempt).rejects.toThrow(new RegExp(`${START_TIMEOUT_MS / 1000}초`));
    await vi.advanceTimersByTimeAsync(10);
    inst.video!.srcObject = { getTracks: () => [] }; // camera granted: the 15 s AR deadline is armed from here
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 300);
    await rejection;
    expect(inst.started).toBe(1);
    expect(inst.stopped).toBe(1); // camera released despite never reaching "running"
    expect(inst.renderer.setAnimationLoop).not.toHaveBeenCalled();
    expect(() => s.stop()).not.toThrow(); // and a later unmount is harmless (clears the loop with null)
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledTimes(1);
    expect(inst.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    // a start() after the failure is allowed again (not stuck on the dead attempt)
    inst.startImpl = async () => {};
    await s.start();
    expect(inst.started).toBe(2);
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledTimes(2);
    expect(inst.renderer.loop).toEqual(expect.any(Function));
  });

  describe("start() lifecycle: preflight, permission and AR deadlines, retries (review follow-ups A/B/C)", () => {
    const hang = () => new Promise<void>(() => {});
    const stream = (tracks: Array<{ stop: () => void }> = []) => ({ getTracks: () => tracks });

    it("A: stop() during the preflight aborts the fetch, never opens the camera, start() settles cleanly, and a later start() re-fetches", async () => {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
      const s = make(); // the preflight begins here
      const inst = fake.state.instances[0]!;
      const attempt = s.start();
      s.stop();
      expect(signal?.aborted).toBe(true);
      await expect(attempt).resolves.toBeUndefined();
      expect(inst.started).toBe(0); // getUserMedia never requested
      expect(inst.stopped).toBe(0); // nothing to release either
      fetchMock.mockImplementation(async () => mindResponse());
      await s.start();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(inst.started).toBe(1);
    });

    it("B: the preflight fetch runs at createArSession() time so it is usually done before the tap", () => {
      make();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("B: a permission prompt answered after 20 s still succeeds (no false 15 s failure)", async () => {
      vi.useFakeTimers();
      const s = make();
      const inst = fake.state.instances[0]!;
      let grant: () => void = () => {};
      inst.startImpl = () => new Promise<void>((r) => { grant = r; });
      const attempt = s.start();
      await vi.advanceTimersByTimeAsync(20_000); // user is reading the prompt
      expect(inst.started).toBe(1);
      expect(inst.stopped).toBe(0);
      inst.video!.srcObject = stream(); // 허용 tapped: the stream is live
      grant(); // MindAR finishes _startAR
      await attempt;
      expect(inst.stopped).toBe(0);
      expect(inst.renderer.loop).toEqual(expect.any(Function));
    });

    it("B: AR start stalling 15 s after the stream is live rejects with the target message and releases the camera", async () => {
      vi.useFakeTimers();
      const s = make();
      const inst = fake.state.instances[0]!;
      inst.startImpl = hang;
      const attempt = s.start();
      const rejection = expect(attempt).rejects.toThrow(new RegExp(`${START_TIMEOUT_MS / 1000}초`));
      await vi.advanceTimersByTimeAsync(10);
      inst.video!.srcObject = stream(); // camera granted right away
      await vi.advanceTimersByTimeAsync(14_800);
      expect(inst.stopped).toBe(0); // the 15 s count from the live stream, not from the tap
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(inst.stopped).toBe(1);
      expect(inst.renderer.setAnimationLoop).not.toHaveBeenCalled();
    });

    it("B: a prompt never answered for 60 s rejects with the permission message; a stream landing later on the detached <video> is stopped", async () => {
      vi.useFakeTimers();
      const s = make();
      const inst = fake.state.instances[0]!;
      inst.startImpl = hang;
      const attempt = s.start();
      const rejection = expect(attempt).rejects.toThrow(/권한/);
      await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS - 1000);
      expect(inst.stopped).toBe(0);
      await vi.advanceTimersByTimeAsync(1100);
      await rejection;
      expect(inst.stopped).toBe(1);
      const track = { stop: vi.fn() };
      inst.video!.srcObject = stream([track]); // 허용 tapped long after we gave up
      await vi.advanceTimersByTimeAsync(600);
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(inst.video!.remove).toHaveBeenCalled();
    });

    it("C: a retry after a timed-out attempt succeeds with exactly one live camera, even when the old attempt lands late", async () => {
      vi.useFakeTimers();
      const s = make();
      const inst = fake.state.instances[0]!;
      let finishFirst: () => void = () => {};
      inst.startImpl = () => new Promise<void>((r) => { finishFirst = r; });
      const first = s.start();
      const rejection = expect(first).rejects.toThrow(new RegExp(`${START_TIMEOUT_MS / 1000}초`));
      await vi.advanceTimersByTimeAsync(10);
      const video1 = inst.video!;
      const track1 = { stop: vi.fn() };
      video1.srcObject = stream([track1]);
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 300);
      await rejection;
      expect(inst.stopped).toBe(1);
      inst.startImpl = async () => {};
      await s.start(); // retry on the same session
      const video2 = inst.video!;
      expect(video2).not.toBe(video1);
      expect(inst.started).toBe(2);
      expect(inst.stopped).toBe(1); // the retry's camera is untouched
      expect(inst.renderer.loop).toEqual(expect.any(Function));
      finishFirst(); // the old attempt's MindAR start lands late
      await vi.advanceTimersByTimeAsync(0);
      expect(inst.stopped).toBe(1); // must not call mindar.stop() on the live retry
      expect(track1.stop).toHaveBeenCalled(); // only its own orphan stream is stopped
      expect(video1.remove).toHaveBeenCalled();
      expect(inst.renderer.loop).toEqual(expect.any(Function));
    });

    it("C: start() -> stop() -> start() while the first attempt is pending creates a fresh attempt instead of returning the doomed one", async () => {
      const s = make();
      const inst = fake.state.instances[0]!;
      const resolvers: Array<() => void> = [];
      const startedWaiters: Array<() => void> = [];
      const nextStart = () => new Promise<void>((r) => startedWaiters.push(r));
      inst.startImpl = () => new Promise<void>((r) => { resolvers.push(r); startedWaiters.shift()?.(); });
      const firstStarted = nextStart();
      const a = s.start();
      await firstStarted;
      s.stop();
      expect(inst.stopped).toBe(1);
      const secondStarted = nextStart();
      const b = s.start();
      expect(b).not.toBe(a);
      await secondStarted;
      expect(inst.started).toBe(2);
      resolvers[1]!(); // the new attempt completes
      await b;
      expect(inst.renderer.loop).toEqual(expect.any(Function));
      resolvers[0]!(); // the doomed attempt lands late
      await a;
      await Promise.resolve();
      expect(inst.stopped).toBe(1); // did not kill the live session
      expect(inst.renderer.loop).toEqual(expect.any(Function));
    });
  });
});
