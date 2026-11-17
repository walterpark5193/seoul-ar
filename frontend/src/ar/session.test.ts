import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real bundle touches `window` at import time and needs WebGL; replace it with a
// scriptable fake so the wrapper's wiring can be verified in Node.
const fake = vi.hoisted(() => {
  const state = {
    ctorArgs: [] as unknown[],
    instances: [] as FakeMindAR[],
  };
  class FakeAnchor {
    // Duck-typed stand-in for MindAR's THREE.Group: records what the wrapper adds to it.
    group = {
      kind: "group",
      children: [] as unknown[],
      add(obj: unknown) {
        this.children.push(obj);
      },
    };
    targetIndex: number;
    onTargetFound: (() => void) | null = null;
    onTargetLost: (() => void) | null = null;
    onTargetUpdate: (() => void) | null = null;
    constructor(i: number) {
      this.targetIndex = i;
    }
  }
  class FakeMindAR {
    scene = { kind: "scene" };
    camera = { kind: "camera" };
    renderer = {
      loop: null as ((t: number) => void) | null,
      setAnimationLoop: vi.fn(function (this: { loop: unknown }, cb: ((t: number) => void) | null) {
        this.loop = cb;
      }),
      render: vi.fn(),
    };
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
      await this.startImpl();
    }
    stop() {
      this.stopped++;
    }
  }
  return { state, FakeMindAR };
});

vi.mock("mind-ar/dist/mindar-image-three.prod.js", () => ({ MindARThree: fake.FakeMindAR }));

import { Group } from "three";
import { arSupported, createArSession, START_TIMEOUT_MS } from "./session";

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

  it("constructs MindARThree with the container and targetSrc, exposes scene/camera/renderer", () => {
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
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
    createArSession({ container, targetSrc: "/marker/target.mind" });
    const opts = fake.state.ctorArgs[0] as Record<string, unknown>;
    expect(opts.uiLoading).toBe("no");
    expect(opts.uiScanning).toBe("no");
    expect(opts.uiError).toBe("no");
  });

  it("anchor is an inner Group rotated +90deg about x inside MindAR's anchor group (CONTRACTS 5 amendment)", () => {
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    const mindarGroup = inst.anchors[0]!.group;
    expect(s.anchor).not.toBe(mindarGroup);
    expect(s.anchor).toBeInstanceOf(Group);
    expect(mindarGroup.children).toEqual([s.anchor]);
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

  it("onFound/onLost callbacks fire from the anchor events (all subscribers)", () => {
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    const found = vi.fn();
    const found2 = vi.fn();
    const lost = vi.fn();
    s.onFound(found);
    s.onFound(found2);
    s.onLost(lost);
    inst.anchors[0]!.onTargetFound!();
    inst.anchors[0]!.onTargetLost!();
    expect(found).toHaveBeenCalledTimes(1);
    expect(found2).toHaveBeenCalledTimes(1);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("start() checks the target file first, then starts MindAR and drives onFrame with dt in seconds", async () => {
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
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
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    const dts: number[] = [];
    s.onFrame((dt) => dts.push(dt));
    await s.start();
    const loop = inst.renderer.loop!;
    loop(0);
    loop(5000);
    expect(dts[1]).toBeLessThanOrEqual(0.1);
  });

  it("stop() clears the animation loop before stopping MindAR, and is safe before start()", async () => {
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
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
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
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
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    const [a, b] = [s.start(), s.start()];
    expect(a).toBe(b);
    await a;
    await s.start();
    expect(inst.started).toBe(1);
    expect(inst.renderer.setAnimationLoop).toHaveBeenCalledTimes(1);
  });

  it("start() rejects with an Error (not undefined) when the camera cannot start", async () => {
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    inst.startImpl = () => Promise.reject(undefined); // MindAR rejects with no value on getUserMedia failure
    await expect(s.start()).rejects.toBeInstanceOf(Error);
    expect(inst.renderer.setAnimationLoop).not.toHaveBeenCalled();
  });

  it("start() rejects before opening the camera when the target 404s", async () => {
    fetchMock.mockImplementation(async () => mindResponse(new Uint8Array(0), { ok: false, status: 404 }));
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    await expect(s.start()).rejects.toThrow(/404/);
    expect(inst.started).toBe(0); // getUserMedia never requested
    expect(inst.renderer.setAnimationLoop).not.toHaveBeenCalled();
  });

  it("start() rejects before opening the camera when the SPA fallback serves index.html instead of the .mind", async () => {
    fetchMock.mockImplementation(async () => mindResponse(new TextEncoder().encode("<!doctype html><html></html>")));
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    await expect(s.start()).rejects.toThrow(/\.mind|index\.html/);
    expect(inst.started).toBe(0);
  });

  it("start() rejects before opening the camera when the target download is empty or fails", async () => {
    fetchMock.mockImplementation(async () => mindResponse(new Uint8Array(0)));
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    await expect(s.start()).rejects.toThrow(/비어/);
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await expect(s.start()).rejects.toThrow(/Failed to fetch/);
    expect(fake.state.instances[0]!.started).toBe(0);
  });

  it("start() times out when MindAR never settles (bad target decode) and releases the live camera", async () => {
    vi.useFakeTimers();
    const s = createArSession({ container, targetSrc: "/marker/target.mind" });
    const inst = fake.state.instances[0]!;
    inst.startImpl = () => new Promise<void>(() => {}); // _startAR hangs forever, camera already on
    const attempt = s.start();
    const rejection = expect(attempt).rejects.toThrow(new RegExp(`${START_TIMEOUT_MS / 1000}초`));
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
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
});
