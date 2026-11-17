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
    srcObject: null, muted: false, playsInline: false, readyState: 4, paused: false, videoWidth: 1280, videoHeight: 720,
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

/** 전역 rAF 가짜: 예약된 콜백을 run(t)으로 한 화면 프레임씩 돌린다(감시 루프와 프레임 루프가 같이 쓸 수 있게 여러 개). */
function stubRaf() {
  const q = new Map<number, (t: number) => void>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (c: (t: number) => void) => { q.set(++id, c); return id; });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => { q.delete(h); });
  return {
    run(t: number) { const cbs = [...q.values()]; q.clear(); for (const c of cbs) c(t); },
    get pending() { return q.size; },
  };
}

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
  it("modelExists false → model-missing, 카메라는 열지 않는다", async () => {
    const { d } = deps({ modelExists: async () => false });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "model-missing" });
    expect(d.getUserMedia).not.toHaveBeenCalled();
  });
  it("모델이 없고 카메라도 거부될 상황이면 model-missing이 우선", async () => {
    const { d } = deps({ modelExists: async () => false, getUserMedia: async () => { throw domErr("NotAllowedError"); } });
    expect(await startHandSource(d)).toEqual({ ok: false, reason: "model-missing" });
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
  it("연속 실패는 errors로 노출되고 성공하면 0, 경고는 한 번만", async () => {
    const rec = fakeRecognizer();
    let fail = true;
    rec.recognizeForVideo.mockImplementation((() => { if (fail) throw new Error("x"); return { gestures: [], landmarks: [] }; }) as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d, v } = deps({}, rec);
    const r = await startHandSource(d);
    if (!r.ok) throw new Error("fail");
    v.tick(1); v.tick(2); v.tick(3);
    expect(r.source.errors).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    fail = false; v.tick(4);
    expect(r.source.errors).toBe(0);
    r.source.stop(); warn.mockRestore();
  });
  it("리스너 하나가 던져도 다른 리스너는 호출된다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d, v } = deps();
    const r = await startHandSource(d);
    if (!r.ok) throw new Error("fail");
    const got: any[] = [];
    r.source.onFrame(() => { throw new Error("bad"); });
    r.source.onFrame(f => got.push(f));
    v.tick(1); v.tick(2);
    expect(got).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    r.source.stop(); warn.mockRestore();
  });
  it("rVFC가 없으면 rAF 폴백이고 currentTime이 같은 프레임은 건너뛴다", async () => {
    let raf: ((t: number) => void) | null = null;
    vi.stubGlobal("requestAnimationFrame", (c: (t: number) => void) => { raf = c; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { raf = null; });
    try {
      const { d, v, rec } = deps();
      v.raw.requestVideoFrameCallback = undefined;
      v.raw.currentTime = 0;
      const r = await startHandSource(d);
      if (!r.ok) throw new Error("fail");
      const run = (t: number) => { const c = raf; raf = null; c?.(t); };
      run(10); run(20);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(1);
      v.raw.currentTime = 0.04; run(30);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(2);
      r.source.stop();
    } finally { vi.unstubAllGlobals(); }
  });
  it("재생 중 rVFC가 500ms 동안 오지 않으면 rAF + currentTime 확인으로 바꿔 계속 쓰고, 같은 영상 프레임은 두 번 처리하지 않는다", async () => {
    const raf = stubRaf();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { d, v, rec } = deps();
      v.raw.currentTime = 0;
      const r = await startHandSource(d);
      if (!r.ok) throw new Error("fail");
      const got: number[] = [];
      r.source.onFrame(f => got.push(f.t));
      // 정상: 화면 프레임마다 새 영상 프레임(rVFC) → rAF 순서
      let t = 0;
      for (let i = 1; i <= 5; i++) { t += 33; v.raw.currentTime = i * 0.033; v.tick(t); raf.run(t); }
      expect(got).toHaveLength(5);
      const rvfcAsks = v.raw.requestVideoFrameCallback.mock.calls.length;
      const late = v.raw.requestVideoFrameCallback.mock.calls.at(-1)![0] as (n: number) => void;
      // rVFC가 멈춘다(미리보기가 렌더 트리에서 빠짐 등). 영상은 재생 중, currentTime은 마지막으로 처리한 프레임 그대로.
      for (let k = 0; k < 29; k++) raf.run(t += 16);                 // 464ms: 아직 바꾸지 않는다
      expect(v.raw.cancelVideoFrameCallback).not.toHaveBeenCalled();
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(5);
      for (let k = 0; k < 4; k++) raf.run(t += 16);                  // 500ms를 넘김: rAF 길로 바꿈
      expect(v.raw.cancelVideoFrameCallback).toHaveBeenCalledTimes(1);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(5);        // 이미 처리한 프레임은 rAF로 다시 처리하지 않는다
      // 새 영상 프레임은 rAF로 한 번씩만
      v.raw.currentTime = 0.2; raf.run(t += 16); raf.run(t += 16);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(6);
      v.raw.currentTime = 0.233; raf.run(t += 16);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(7);
      expect(got).toHaveLength(7);
      // 바꾼 뒤 늦게 온 rVFC 콜백은 처리하지 않고 루프를 하나 더 만들지도 않는다. rVFC는 다시 요청하지 않는다.
      v.raw.currentTime = 0.266;
      late(t += 1);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(7);
      raf.run(t += 16);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(8);
      expect(raf.pending).toBe(1);
      expect(v.raw.requestVideoFrameCallback.mock.calls.length).toBe(rvfcAsks);
      r.source.stop();
      expect(raf.pending).toBe(0);
    } finally { vi.unstubAllGlobals(); warn.mockRestore(); }
  });
  it("멈춘 영상·준비 안 된 영상에서는 rVFC가 조용해도 바꾸지 않는다", async () => {
    const raf = stubRaf();
    try {
      const { d, v, rec } = deps();
      v.raw.paused = true;
      const r = await startHandSource(d);
      if (!r.ok) throw new Error("fail");
      let t = 0;
      for (let k = 0; k < 60; k++) raf.run(t += 16);                 // 약 1초 일시 정지
      v.raw.paused = false; v.raw.readyState = 1;
      for (let k = 0; k < 60; k++) raf.run(t += 16);                 // 약 1초 데이터 없음
      v.raw.readyState = 4;
      for (let k = 0; k < 29; k++) raf.run(t += 16);                 // 재생 시작부터 다시 잰다(464ms)
      expect(v.raw.cancelVideoFrameCallback).not.toHaveBeenCalled();
      v.tick(t += 16); raf.run(t);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(1);        // 여전히 rVFC 길
      r.source.stop();
      expect(raf.pending).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it("감시 rAF 사이가 길게 벌어지면(숨은 탭에서 돌아옴) 그 간격은 rVFC 정지로 세지 않는다", async () => {
    const raf = stubRaf();
    try {
      const { d, v, rec } = deps();
      const r = await startHandSource(d);
      if (!r.ok) throw new Error("fail");
      v.tick(10); raf.run(10);
      raf.run(60_010);                                                // 숨은 탭: rAF·rVFC 모두 1분 쉼
      expect(v.raw.cancelVideoFrameCallback).not.toHaveBeenCalled();
      v.tick(60_026); raf.run(60_026);
      expect(rec.recognizeForVideo).toHaveBeenCalledTimes(2);
      expect(v.raw.cancelVideoFrameCallback).not.toHaveBeenCalled();
      r.source.stop();
    } finally { vi.unstubAllGlobals(); }
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
