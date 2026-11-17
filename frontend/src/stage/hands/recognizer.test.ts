import { describe, it, expect, vi } from "vitest";
import { toHandFrame, startHandSource, MODEL_PATH, WASM_PATH } from "./recognizer";
import type { RecognizerResultLike, HandSourceDeps } from "./recognizer";

const lm = (n: number) => Array.from({ length: 21 }, (_, i) => ({ x: i / 100, y: n, z: 0 }));

describe("toHandFrame", () => {
  it("두 손의 제스처·랜드마크·handedness를 변환한다", () => {
    const r: RecognizerResultLike = {
      gestures: [[{ categoryName: "Open_Palm", score: 0.9 }], [{ categoryName: "Victory", score: 0.8 }]],
      landmarks: [lm(0.1), lm(0.2)],
      handedness: [[{ categoryName: "Left", score: 0.99 }], [{ categoryName: "Right", score: 0.97 }]],
    };
    const f = toHandFrame(r, 123);
    expect(f.t).toBe(123);
    expect(f.hands).toHaveLength(2);
    expect(f.hands[0]!.gesture).toBe("Open_Palm");
    expect(f.hands[0]!.score).toBe(0.9);
    expect(f.hands[0]!.handedness).toBe("Left");
    expect(f.hands[0]!.landmarks).toHaveLength(21);
    expect(f.hands[0]!.landmarks[5]).toEqual([0.05, 0.1, 0]);
    expect(f.hands[1]!.gesture).toBe("Victory");
    expect(f.hands[1]!.handedness).toBe("Right");
  });
  it("handednesses만 있는 구버전 결과도 읽는다", () => {
    const r: RecognizerResultLike = {
      gestures: [[{ categoryName: "Closed_Fist", score: 0.7 }]],
      landmarks: [lm(0.3)],
      handednesses: [[{ categoryName: "Right", score: 0.9 }]],
    };
    expect(toHandFrame(r, 1).hands[0]!.handedness).toBe("Right");
  });
  it("handedness가 없으면 Unknown", () => {
    const r: RecognizerResultLike = { gestures: [[{ categoryName: "Thumb_Up", score: 0.6 }]], landmarks: [lm(0)] };
    expect(toHandFrame(r, 1).hands[0]!.handedness).toBe("Unknown");
  });
  it("모르는 제스처 이름은 None", () => {
    const r: RecognizerResultLike = { gestures: [[{ categoryName: "Wave", score: 0.5 }]], landmarks: [lm(0)] };
    const h = toHandFrame(r, 1).hands[0]!;
    expect(h.gesture).toBe("None");
    expect(h.score).toBe(0.5);
  });
  it("제스처 배열이 비면 None, score 0", () => {
    const r: RecognizerResultLike = { gestures: [[]], landmarks: [lm(0)] };
    const h = toHandFrame(r, 1).hands[0]!;
    expect(h.gesture).toBe("None");
    expect(h.score).toBe(0);
  });
  it("손이 없으면 빈 배열", () => {
    expect(toHandFrame({ gestures: [], landmarks: [] }, 5).hands).toEqual([]);
  });
});

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}
function fakeVideo() {
  let cb: ((now: number) => void) | null = null;
  const v: any = {
    srcObject: null, muted: false, playsInline: false, readyState: 4, videoWidth: 1280, videoHeight: 720,
    play: vi.fn(async () => {}),
    requestVideoFrameCallback: vi.fn((c: (n: number) => void) => { cb = c; return 1; }),
    cancelVideoFrameCallback: vi.fn(() => { cb = null; }),
    setAttribute: vi.fn(),
  };
  return { video: v as HTMLVideoElement, tick: (t: number) => { const c = cb; cb = null; c?.(t); }, raw: v };
}
function fakeRecognizer(result?: RecognizerResultLike) {
  return {
    recognizeForVideo: vi.fn(() => result ?? { gestures: [[{ categoryName: "Open_Palm", score: 0.9 }]], landmarks: [lm(0)], handedness: [[{ categoryName: "Left", score: 1 }]] }),
    close: vi.fn(),
  };
}
function mkVision(create: (fileset: unknown, opts: any) => Promise<any>) {
  const forVisionTasks = vi.fn(async (p: string) => ({ wasmLoaderPath: p }));
  const mod = { FilesetResolver: { forVisionTasks }, GestureRecognizer: { createFromOptions: vi.fn(create) } };
  return { mod, forVisionTasks, create: mod.GestureRecognizer.createFromOptions };
}
function deps(over: Partial<HandSourceDeps> = {}, rec = fakeRecognizer()) {
  const s = fakeStream(); const v = fakeVideo(); const vis = mkVision(async () => rec);
  const d: HandSourceDeps = {
    getUserMedia: vi.fn(async () => s.stream),
    loadVision: async () => vis.mod as any,
    modelExists: async () => true,
    createVideo: () => v.video,
    ...over,
  };
  return { d, s, v, vis, rec };
}
const domErr = (name: string) => Object.assign(new Error(name), { name });

describe("startHandSource", () => {
  it("성공: 카메라 제약, 옵션, GPU 델리게이트", async () => {
    const { d, s, v, vis } = deps();
    const r = await startHandSource(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(d.getUserMedia).toHaveBeenCalledWith({ video: { width: 1280, height: 720, facingMode: "user" }, audio: false });
    expect(vis.forVisionTasks).toHaveBeenCalledWith(WASM_PATH);
    expect(vis.create.mock.calls[0]![1]).toEqual({ baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" }, runningMode: "VIDEO", numHands: 6 });
    expect(r.source.delegate).toBe("GPU");
    expect(r.source.video).toBe(v.video);
    expect(typeof r.source.loadMs).toBe("number");
    expect(v.raw.srcObject).toBe(s.stream);
    r.source.stop();
  });
  it("NotAllowedError → denied", async () => {
    const { d } = deps({ getUserMedia: async () => { throw domErr("NotAllowedError"); } });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "denied" });
  });
  it("NotFoundError → no-camera", async () => {
    const { d } = deps({ getUserMedia: async () => { throw domErr("NotFoundError"); } });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "no-camera" });
  });
  it("기타 카메라 오류 → no-camera", async () => {
    const { d } = deps({ getUserMedia: async () => { throw domErr("NotReadableError"); } });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "no-camera" });
  });
  it("mediaDevices도 주입도 없으면 no-camera", async () => {
    const { d } = deps({ getUserMedia: undefined });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "no-camera" });
  });
  it("modelExists false → model-missing, 카메라 트랙 정리", async () => {
    const { d, s } = deps({ modelExists: async () => false });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "model-missing" });
    expect(s.track.stop).toHaveBeenCalled();
  });
  it("modelExists가 던지면 model-missing", async () => {
    const { d } = deps({ modelExists: async () => { throw new Error("net"); } });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "model-missing" });
  });
  it("GPU 실패 후 CPU 성공 → delegate CPU", async () => {
    const rec = fakeRecognizer();
    const vis = mkVision(async (_f, o) => { if (o.baseOptions.delegate === "GPU") throw new Error("gpu"); return rec; });
    const { d } = deps({ loadVision: async () => vis.mod as any });
    const r = await startHandSource(d);
    expect(r.ok && r.source.delegate).toBe("CPU");
    expect(vis.create).toHaveBeenCalledTimes(2);
    if (r.ok) r.source.stop();
  });
  it("GPU·CPU 모두 실패 → wasm-failed, 트랙 정리", async () => {
    const vis = mkVision(async () => { throw new Error("x"); });
    const { d, s } = deps({ loadVision: async () => vis.mod as any });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "wasm-failed" });
    expect(s.track.stop).toHaveBeenCalled();
  });
  it("loadVision 실패 → wasm-failed", async () => {
    const { d } = deps({ loadVision: async () => { throw new Error("import"); } });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "wasm-failed" });
  });
  it("프레임 루프: onFrame에 HandFrame 전달, fps는 이동 평균, stop은 정리", async () => {
    const { d, v, s, rec } = deps();
    const r = await startHandSource(d);
    if (!r.ok) throw new Error("fail");
    const got: any[] = [];
    const off = r.source.onFrame(f => got.push(f));
    for (let i = 0; i < 40; i++) v.tick(i * 50); // 20fps
    expect(got).toHaveLength(40);
    expect(got[0].hands[0]!.gesture).toBe("Open_Palm");
    expect(r.source.fps).toBeCloseTo(20, 5);
    off();
    v.tick(2000);
    expect(got).toHaveLength(40);
    r.source.stop();
    expect(rec.close).toHaveBeenCalled();
    expect(s.track.stop).toHaveBeenCalled();
    expect(v.raw.srcObject).toBeNull();
  });
  it("recognizeForVideo가 던져도 루프는 계속된다", async () => {
    const rec = fakeRecognizer();
    let n = 0;
    rec.recognizeForVideo.mockImplementation((() => { if (n++ === 0) throw new Error("ts"); return { gestures: [], landmarks: [] }; }) as any);
    const { d, v } = deps({}, rec);
    const r = await startHandSource(d);
    if (!r.ok) throw new Error("fail");
    const got: any[] = [];
    r.source.onFrame(f => got.push(f));
    v.tick(10); v.tick(20);
    expect(got).toHaveLength(1);
    r.source.stop();
  });
  it("기본 modelExists: 200 + text/html(SPA 폴백)이면 model-missing", async () => {
    const { d } = deps({ modelExists: undefined, fetchImpl: (async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "model-missing" });
  });
  it("기본 modelExists: 200 + octet-stream이면 진행", async () => {
    const { d } = deps({ modelExists: undefined, fetchImpl: (async () => new Response("x", { status: 200, headers: { "content-type": "application/octet-stream" } })) as typeof fetch });
    const r = await startHandSource(d);
    expect(r.ok).toBe(true);
    if (r.ok) r.source.stop();
  });
  it("기본 modelExists: 404면 model-missing", async () => {
    const { d } = deps({ modelExists: undefined, fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "model-missing" });
  });
  it("WebAssembly가 없으면 카메라 전에 unsupported", async () => {
    vi.stubGlobal("WebAssembly", undefined);
    try {
      const { d } = deps();
      expect(await startHandSource(d)).toEqual({ ok: false, reason: "unsupported" });
      expect(d.getUserMedia).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
