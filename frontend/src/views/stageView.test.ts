import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { GU_ORDER } from "../data/gu";
import type { DataIndex, GuData, Stat } from "../data/types";
import type { StateMessage } from "../realtime/types";
import type { HandSource } from "../stage/hands/recognizer";
import { createCursorMapper } from "../stage/hands/cursor";
import { createVoteCounter } from "../stage/hands/voteCounter";
import { ALLOWED_KEYS, type StageChannelMessage } from "../stage/net/messages";
import { createMockStageChannel } from "../stage/net/stageChannel";
import { createNarrator, type AudioLike, type Narrator } from "../stage/narrator";
import type { GestureName, HandFrame, HandObs, Point, Vec3 } from "../stage/types";
import {
  HAND_ERROR_LIMIT, HEARTBEAT_MS, VOTE_TICK_MS,
  createStageController, normalizeKey, voteCandidates,
  type StageControllerDeps, type StartResult, type UiPart,
} from "./stageView";

const MONTH = "202611";
const STATE_KEYS = ["v", "type", "month", "gu", "metric", "ts"];

function stat(medPerM2: number | null, n = 10): Stat {
  return { n, cancelled: 0, medPerM2, medAmt: null, maxAmt: null, truncated: false };
}

/** 가격은 GU_ORDER 순으로 비싸다(1위 종로구, 13위 서대문구, 25위 강동구). 건수는 거꾸로(1위 강동구). */
function makeIndex(months: string[] = [MONTH]): DataIndex {
  const summary: DataIndex["summary"] = {};
  for (const m of months) summary[m] = Object.fromEntries(GU_ORDER.map((g, i) => [g, stat(3000 - i * 50 + (m === MONTH ? 0 : 1), i + 1)]));
  return { v: 1, generatedAt: "", source: "", months, gus: [...GU_ORDER], summary };
}

function fakeClock(start = 1_000_000) {
  let t = start;
  const jobs = new Set<{ ms: number; fn: () => void; next: number }>();
  return {
    now: () => t,
    every(ms: number, fn: () => void) {
      const job = { ms, fn, next: t + ms };
      jobs.add(job);
      return () => { jobs.delete(job); };
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let due: { ms: number; fn: () => void; next: number } | null = null;
        for (const j of jobs) if (j.next <= end && (!due || j.next < due.next)) due = j;
        if (!due) break;
        t = due.next;
        due.next += due.ms;
        due.fn();
      }
      t = end;
    },
    get jobs() { return jobs.size; },
  };
}

type Wire = { channel: "state"; msg: StateMessage } | { channel: "stage"; msg: StageChannelMessage };

/** 본체 채널: 기록만 한다(검사는 테스트에서). 무대 채널: 실제 모의 채널(toWire 검사)을 쓰고 전달된 사본을 기록.
 *  모의 채널이 거절한 메시지는 wire에 없고 publishFailed로 드러난다. */
function channels() {
  const wire: Wire[] = [];
  const flags = { failStage: false, failState: false };
  const realtime = {
    status: "open" as const,
    onStatus: () => () => {},
    publish: vi.fn(async (m: StateMessage) => {
      if (flags.failState) throw new Error("state down");
      wire.push({ channel: "state", msg: JSON.parse(JSON.stringify(m)) as StateMessage });
    }),
  };
  const mock = createMockStageChannel({ channel: () => null });
  void mock.connect();
  mock.subscribe((m) => wire.push({ channel: "stage", msg: m }));
  const stageChannel = {
    get status() { return mock.status; },
    onStatus: mock.onStatus,
    publish: vi.fn((m: StageChannelMessage) => (flags.failStage ? Promise.reject(new Error("stage down")) : mock.publish(m))),
  };
  return { wire, flags, realtime, stageChannel };
}

function fakeScene(pick: (x: number, y: number) => string | null = () => "강남구") {
  return {
    setOverview: vi.fn(), focus: vi.fn(), setHover: vi.fn(), lift: vi.fn(), setLayout: vi.fn(),
    pick: vi.fn((x: number, y: number) => pick(x, y)),
  };
}

function fakeNarrator() {
  const said: { id: string; interrupt: boolean; protect: boolean }[] = [];
  const captions = new Set<(t: string | null) => void>();
  let muted = false;
  let unlocks = 0;
  const narrator: Narrator = {
    say(id, opts) { said.push({ id, interrupt: !!opts?.interrupt, protect: !!opts?.protect }); },
    stop: vi.fn(),
    setMuted(m) { muted = m; },
    get muted() { return muted; },
    onCaption(cb) { captions.add(cb); return () => { captions.delete(cb); }; },
    async unlock() { unlocks++; },
  };
  return { narrator, said, caption: (t: string | null) => { for (const cb of captions) cb(t); }, get unlocks() { return unlocks; } };
}

function fakeUi() {
  const parts: Partial<Record<UiPart, string | null>> = {};
  const cursors: { p: Point | null; cls: string }[] = [];
  const ui = {
    set: vi.fn((part: UiPart, html: string | null) => { parts[part] = html; }),
    cursor: vi.fn((p: Point | null, cls: string) => { cursors.push({ p, cls }); }),
    preview: vi.fn(),
    skeleton: vi.fn(),
  };
  return { ui, parts, cursors };
}

function fakeSource() {
  const subs = new Set<(f: HandFrame) => void>();
  const source = {
    video: {} as HTMLVideoElement, fps: 30, loadMs: 120, delegate: "GPU" as const, errors: 0,
    onFrame(cb: (f: HandFrame) => void) { subs.add(cb); return () => { subs.delete(cb); }; },
    stop: vi.fn(),
  };
  return { source, emit: (f: HandFrame) => { for (const cb of [...subs]) cb(f); }, get listeners() { return subs.size; } };
}

/** 합성 손. 손목(0)과 손바닥 폭(5↔17)만 의미 있다. 손바닥 중심은 대략 (cx, cy). */
function hand(gesture: GestureName, cx = 0.5, cy = 0.5, score = 0.9): HandObs {
  const landmarks: Vec3[] = Array.from({ length: 21 }, (): Vec3 => [cx, cy, 0]);
  landmarks[5] = [cx - 0.05, cy, 0];
  landmarks[17] = [cx + 0.05, cy, 0];
  return { landmarks, gesture, score, handedness: "Right" };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(o: { months?: string[]; hash?: string; start?: () => Promise<StartResult>; narrator?: Narrator; pick?: (x: number, y: number) => string | null; extra?: Partial<StageControllerDeps> } = {}) {
  const clock = fakeClock();
  const ch = channels();
  const scene = fakeScene(o.pick);
  const renderer = { camera: new PerspectiveCamera(), setMode: vi.fn() };
  const narr = fakeNarrator();
  const view = fakeUi();
  const toast = vi.fn();
  const index = makeIndex(o.months);
  const guData = (month: string, gu: string): GuData => ({ v: 1, month, gu, generatedAt: "", total: stat(1), dongs: [] });
  const loadGu = vi.fn(async (month: string, gu: string) => guData(month, gu));
  const src = fakeSource();
  const startHands = vi.fn(o.start ?? (async (): Promise<StartResult> => ({ ok: true, source: src.source as unknown as HandSource })));
  const deps: StageControllerDeps = {
    index, month: index.months.at(-1)!, loadGu,
    realtime: ch.realtime, stageChannel: ch.stageChannel,
    scene, renderer, narrator: o.narrator ?? narr.narrator, ui: view.ui, toast,
    startHands, hash: () => o.hash ?? "#/stage", clock, ...o.extra,
  };
  const c = createStageController(deps);
  let t = 5000;
  const frame = (hands: HandObs[], dt = 33) => { t += dt; src.emit({ t, hands }); };
  const frames = (n: number, hands: HandObs[], dt = 33) => { for (let i = 0; i < n; i++) frame(hands, dt); };
  const key = (k: string, extra: Partial<{ code: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => c.key({ key: k, ...extra });
  return { c, clock, ...ch, scene, renderer, narr, view, toast, index, loadGu, src, startHands, frame, frames, key, deps };
}

describe("voteCandidates", () => {
  const summary = makeIndex().summary[MONTH]!;
  it("defaults to 1st, 13th and 25th by price", () => {
    expect(voteCandidates("#/stage", summary, "price")).toEqual(["종로구", "서대문구", "강동구"]);
  });
  it("takes valid names from the hash and fills the rest with defaults", () => {
    expect(voteCandidates("#/stage?vote=강남구,마포구,노원구", summary, "price")).toEqual(["강남구", "마포구", "노원구"]);
    expect(voteCandidates("#/stage?vote=강남구,없는구", summary, "price")).toEqual(["강남구", "종로구", "서대문구"]);
    expect(voteCandidates("#/stage?vote=종로구", summary, "price")).toEqual(["종로구", "서대문구", "강동구"]);
    expect(voteCandidates("#/stage?vote=강남구,마포구,노원구,중구", summary, "price")).toEqual(["강남구", "마포구", "노원구"]);
  });
});

describe("normalizeKey", () => {
  it("maps Hangul IME letters back to the physical key", () => {
    expect(normalizeKey("ㅍ", "KeyV")).toBe("v");
    expect(normalizeKey("ㅎ", "KeyG")).toBe("g");
    expect(normalizeKey("v", "KeyV")).toBe("v");
    expect(normalizeKey(" ", "Space")).toBe(" ");
    expect(normalizeKey("ㅍ", undefined)).toBe("ㅍ");
  });
  it("maps the Windows IME \"Process\" key back to the physical key", () => {
    expect(normalizeKey("Process", "KeyG")).toBe("g");
    expect(normalizeKey("Process", "KeyV")).toBe("v");
    expect(normalizeKey("Process", "Digit3")).toBe("3");
    expect(normalizeKey("Process", "Space")).toBe(" ");
    expect(normalizeKey("Process", "Backquote")).toBe("Process"); // 모르는 물리 키는 그대로(아무 동작 없음)
    expect(normalizeKey("Process", undefined)).toBe("Process");
    expect(normalizeKey("Enter", "Enter")).toBe("Enter");
  });
});

describe("stage controller", () => {
  it("draws the overview before start and shows the start screen", () => {
    const s = setup();
    expect(s.scene.setOverview).toHaveBeenCalledWith(s.index.summary[MONTH], "price");
    expect(s.view.parts.start).toContain('data-start="hands"');
    expect(s.view.parts.top).toContain("서울이 선다 · 무대");
    expect(s.view.parts.top).toContain("2026년 11월");
    expect(s.key(" ")).toBe(false); // 시작 전에는 키를 받지 않는다
    expect(s.wire).toHaveLength(0);
  });

  it("unlocks audio synchronously inside start, then greets and publishes", async () => {
    const s = setup();
    const p = s.c.start("mouse");
    expect(s.narr.unlocks).toBe(1);
    await p;
    expect(s.c.started).toBe(true);
    expect(s.view.parts.start).toBeNull();
    expect(s.narr.said[0]).toEqual({ id: "stage-hello", interrupt: true, protect: false });
    expect(s.wire.map((w) => w.msg.type)).toEqual(["state", "stage"]);
    expect(s.startHands).not.toHaveBeenCalled();
  });

  it("mouse grab release publishes state then stage", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.wire.length = 0;
    s.c.pointer.move({ x: 0.75, y: 0.25 });
    expect(s.scene.pick).toHaveBeenLastCalledWith(0.5, 0.5, s.renderer.camera); // 화면 정규 좌표 → NDC
    expect(s.c.state.hover).toBe("강남구");
    expect(s.scene.setHover).toHaveBeenLastCalledWith("강남구");
    s.c.pointer.down();
    expect(s.c.state.lifted).toBe("강남구");
    expect(s.scene.lift).toHaveBeenLastCalledWith("강남구");
    expect(s.narr.said.at(-1)?.id).toBe("gu-202611-강남구");
    s.wire.length = 0;
    s.c.pointer.up();
    expect(s.c.state.focus).toBe("강남구");
    expect(s.wire.map((w) => w.channel)).toEqual(["state", "stage"]);
    const [st, sg] = s.wire;
    expect(st!.msg).toEqual({ v: 1, type: "state", month: MONTH, gu: "강남구", metric: "price", ts: s.clock.now() });
    expect(Object.keys(st!.msg).sort()).toEqual([...STATE_KEYS].sort());
    expect(sg!.msg).toEqual({ v: 1, type: "stage", mode: "map", lifted: null, ts: s.clock.now() });
    expect(Object.keys(sg!.msg).every((k) => ALLOWED_KEYS.stage.includes(k))).toBe(true);
    expect(s.loadGu).toHaveBeenCalledWith(MONTH, "강남구");
    await flush();
    expect(s.scene.focus).toHaveBeenLastCalledWith("강남구", expect.objectContaining({ gu: "강남구" }), "price");
  });

  it("hover is emitted only when it changes", async () => {
    let under: string | null = "강남구";
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    s.c.pointer.move({ x: 0.51, y: 0.5 });
    s.c.pointer.move({ x: 0.52, y: 0.5 });
    expect(s.scene.setHover).toHaveBeenCalledTimes(1);
    under = null;
    s.c.pointer.move({ x: 0.9, y: 0.9 });
    expect(s.scene.setHover).toHaveBeenLastCalledWith(null);
    expect(s.scene.setHover).toHaveBeenCalledTimes(2);
  });

  it("no landmarks in any payload", async () => {
    const s = setup();
    await s.c.start("hands");
    expect(s.c.state.input).toBe("hands");
    s.frames(8, [hand("Open_Palm", 0.4, 0.6)]);
    expect(s.c.state.hover).toBe("강남구");
    s.frames(8, [hand("Closed_Fist", 0.4, 0.6)]); // grab
    expect(s.c.state.lifted).toBe("강남구");
    s.frames(8, [hand("Open_Palm", 0.4, 0.6)]); // release
    expect(s.c.state.focus).toBe("강남구");
    s.frames(10, [hand("Open_Palm", 0.4, 0.6)], 100); // 쿨다운이 지나고 펼치기 래치가 풀린다
    s.frames(8, [hand("Open_Palm", 0.3, 0.5), hand("Open_Palm", 0.7, 0.5)]); // spread
    expect(s.c.state.mode).toBe("spread");
    s.key("v"); // 카메라로 세는 투표 한 판
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1500 + VOTE_TICK_MS);
      expect(s.c.state.vote?.phase).toBe("counting");
      s.frames(20, [hand("Open_Palm", 0.3, 0.5), hand("Open_Palm", 0.7, 0.5)]);
      s.clock.advance(5000);
    }
    s.clock.advance(3000 + VOTE_TICK_MS);
    expect(s.c.state.vote?.phase).toBe("result");
    expect(s.c.state.vote?.counts).toEqual([2, 2, 2]);
    s.clock.advance(HEARTBEAT_MS);
    await flush();
    expect(s.c.publishFailed).toBe(false); // 모의 채널(toWire)이 거절한 메시지가 하나도 없다
    expect(s.wire.filter((w) => w.msg.type === "vote")).toHaveLength(1);
    expect(s.wire.filter((w) => w.channel === "state").length).toBeGreaterThanOrEqual(4); // 시작·release·투표 확정·하트비트
    expect(s.wire.length).toBeGreaterThan(5);
    for (const w of s.wire) {
      const json = JSON.stringify(w.msg);
      expect(json).not.toMatch(/landmark|handed|score|gesture|"x"|"y"|cursor|video|image/i);
      const allowed = w.channel === "state" ? STATE_KEYS : w.msg.type === "stage" ? ALLOWED_KEYS.stage : ALLOWED_KEYS.vote;
      expect(Object.keys(w.msg).every((k) => allowed.includes(k))).toBe(true);
    }
  });

  it("spread key toggles layout and narrates", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.wire.length = 0;
    expect(s.key(" ")).toBe(true);
    expect(s.c.state.mode).toBe("spread");
    expect(s.scene.setLayout).toHaveBeenLastCalledWith("spread", s.index.summary[MONTH], "price");
    expect(s.renderer.setMode).toHaveBeenLastCalledWith("spread");
    expect(s.narr.said.at(-1)).toEqual({ id: "spread-intro", interrupt: true, protect: false });
    expect(s.wire.map((w) => w.msg)).toEqual([{ v: 1, type: "stage", mode: "spread", lifted: null, ts: s.clock.now() }]);
    s.key(" ");
    expect(s.c.state.mode).toBe("map");
    expect(s.scene.setLayout).toHaveBeenLastCalledWith("map", s.index.summary[MONTH], "price");
    expect(s.renderer.setMode).toHaveBeenLastCalledWith("map");
    expect(s.narr.said.at(-1)?.id).toBe("map-back");
  });

  it("vote with manual input completes and publishes vote result", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.wire.length = 0;
    s.key("V");
    expect(s.c.state.vote?.method).toBe("manual");
    expect(s.c.state.vote?.candidates).toEqual(["종로구", "서대문구", "강동구"]);
    expect(s.narr.said.at(-2)?.id).toBe("vote-intro");
    expect(s.narr.said.at(-1)?.id).toBe("vote-prompt-종로구");
    expect(s.view.parts.vote).toContain("종로구 보고 싶은 분, 손 들어 주세요");
    for (const n of ["2", "1", "0"]) {
      s.clock.advance(1500 + VOTE_TICK_MS); // 안내 → 고르기 대기
      expect(s.c.state.vote?.phase).toBe("counting");
      expect(s.c.state.vote?.endsAt).toBeNull();
      s.key(n);
      s.clock.advance(1000 + VOTE_TICK_MS); // 고르면 1초 뒤 다음
    }
    expect(s.c.state.vote?.phase).toBe("review");
    expect(s.view.parts.vote).toContain("집계 확인");
    expect(s.wire.filter((w) => w.msg.type === "vote")).toHaveLength(0); // 확정 전에는 발행 없음
    s.clock.advance(3000 + VOTE_TICK_MS); // Enter 없이 3초 뒤 자동 확정
    expect(s.c.state.vote?.phase).toBe("result");
    expect(s.c.state.focus).toBe("종로구");
    const votes = s.wire.filter((w) => w.msg.type === "vote");
    expect(votes).toHaveLength(1);
    expect(votes[0]!.msg).toEqual({
      v: 1, type: "vote", round: 1, phase: "result", candidates: ["종로구", "서대문구", "강동구"], counts: [2, 1, 0], winner: "종로구", ts: expect.any(Number),
    });
    expect(s.narr.said.map((x) => x.id)).toContain("vote-result-종로구-2");
    s.clock.advance(6000 + VOTE_TICK_MS);
    expect(s.c.state.vote).toBeNull();
    expect(s.view.parts.vote).toBeNull();
    expect(s.wire.filter((w) => w.msg.type === "vote")).toHaveLength(1);
  });

  it("panel buttons are handled through data attributes", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.key("v");
    s.c.panel({ set: "0:3" });
    expect(s.c.state.vote?.counts[0]).toBe(3);
    s.c.panel({ set: "2:5" }); // 아직 안 온 후보는 review에서만
    expect(s.c.state.vote?.counts[2]).toBeNull();
    s.c.panel({ set: "9:1" });
    s.c.panel({ method: "camera" });
    expect(s.c.state.vote?.method).toBe("camera");
    s.c.panel({ method: "nope" });
    expect(s.c.state.vote?.method).toBe("camera");
    s.c.panel({ confirm: true }); // review가 아니면 무시
    expect(s.c.state.vote?.phase).toBe("prompt");
  });

  it("review rows move with arrow keys and Enter confirms", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.key("v");
    for (const n of ["1", "1", "1"]) {
      s.clock.advance(1500 + VOTE_TICK_MS);
      s.key(n);
      s.clock.advance(1000 + VOTE_TICK_MS);
    }
    expect(s.c.state.vote?.phase).toBe("review");
    s.key("ArrowDown");
    s.key("ArrowDown");
    s.key("ArrowDown"); // 마지막 줄에서 멈춤
    s.key("4");
    expect(s.c.state.vote?.counts).toEqual([1, 1, 4]);
    expect(s.c.state.vote?.reviewEdited).toBe(true);
    s.clock.advance(10_000);
    expect(s.c.state.vote?.phase).toBe("review"); // 고치면 자동 확정 멈춤
    s.key("Enter");
    expect(s.c.state.vote?.winner).toBe("강동구");
  });

  it("publish failure flags top bar", async () => {
    const s = setup();
    await s.c.start("mouse");
    expect(s.view.parts.top).not.toContain("발행 실패");
    s.flags.failStage = true;
    s.key(" ");
    await flush();
    expect(s.c.publishFailed).toBe(true);
    expect(s.view.parts.top).toContain("발행 실패");
    s.key("p"); // 본체 state 발행은 성공해도 무대 채널 실패 표시는 남는다
    await flush();
    expect(s.wire.at(-1)?.channel).toBe("state");
    expect(s.view.parts.top).toContain("발행 실패");
    s.flags.failStage = false;
    s.key(" ");
    await flush();
    expect(s.c.publishFailed).toBe(false);
    expect(s.view.parts.top).not.toContain("발행 실패");
    s.flags.failState = true;
    s.key("p");
    await flush();
    expect(s.view.parts.top).toContain("발행 실패");
  });

  it("stage mounts with null manifest", async () => {
    const audio: AudioLike = { src: "", muted: false, play: vi.fn(async () => {}), pause: vi.fn(), onended: null, onerror: null };
    const narrator = createNarrator(null, { createAudio: () => audio });
    const s = setup({ narrator });
    await s.c.start("mouse");
    expect(s.c.started).toBe(true);
    s.key(" ");
    s.key("v");
    s.clock.advance(20_000);
    expect(s.view.parts.caption).not.toContain("<p>");
    expect(s.wire.length).toBeGreaterThan(0);
    expect(() => s.c.dispose()).not.toThrow();
  });

  it("single month arrows no-op", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.wire.length = 0;
    const overviews = s.scene.setOverview.mock.calls.length;
    s.key("ArrowLeft");
    s.key("ArrowRight");
    expect(s.c.state.month).toBe(MONTH);
    expect(s.scene.setOverview).toHaveBeenCalledTimes(overviews);
    expect(s.wire).toHaveLength(0);
  });

  it("month arrows move within index months and redraw", async () => {
    const s = setup({ months: ["202610", MONTH] });
    await s.c.start("mouse");
    s.wire.length = 0;
    s.key("ArrowRight"); // 이미 마지막 달
    expect(s.c.state.month).toBe(MONTH);
    s.key("ArrowLeft");
    expect(s.c.state.month).toBe("202610");
    expect(s.scene.setOverview).toHaveBeenLastCalledWith(s.index.summary["202610"], "price");
    expect(s.wire.map((w) => w.msg)).toEqual([{ v: 1, type: "state", month: "202610", gu: null, metric: "price", ts: s.clock.now() }]);
    expect(s.view.parts.top).toContain("2026년 10월");
    s.key("ArrowLeft");
    expect(s.c.state.month).toBe("202610");
  });

  it("hand source failure falls back to mouse with toast", async () => {
    const s = setup({ start: async () => ({ ok: false, reason: "denied" }) });
    await s.c.start("hands");
    expect(s.c.state.input).toBe("mouse");
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls[0]![0]).toContain("마우스");
    expect(s.c.started).toBe(true);
    expect(s.view.parts.hints).toContain("누르고 있기");
  });

  it("recognition errors beyond the limit fall back to mouse with toast", async () => {
    const s = setup();
    await s.c.start("hands");
    expect(s.c.state.input).toBe("hands");
    s.src.source.errors = HAND_ERROR_LIMIT;
    s.clock.advance(VOTE_TICK_MS);
    expect(s.c.state.input).toBe("hands");
    s.src.source.errors = HAND_ERROR_LIMIT + 1;
    s.clock.advance(VOTE_TICK_MS);
    expect(s.c.state.input).toBe("mouse");
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.src.source.stop).toHaveBeenCalled();
    expect(s.src.listeners).toBe(0);
    // G로 다시 손 모드를 시도하면 인식기를 새로 연다.
    s.src.source.errors = 0;
    s.key("g");
    await flush();
    expect(s.startHands).toHaveBeenCalledTimes(2);
    expect(s.c.state.input).toBe("hands");
  });

  it("primary null for 3 frames keeps hover", async () => {
    let under: string | null = "강남구";
    const s = setup({ pick: () => under });
    await s.c.start("hands");
    s.frames(3, [hand("Open_Palm", 0.4, 0.6)]);
    expect(s.c.state.hover).toBe("강남구");
    const shown = s.view.cursors.at(-1)!;
    expect(shown.cls).not.toContain("is-hidden");
    under = "마포구"; // 손이 안 보이는 동안에는 pick도 하지 않는다
    s.frames(3, []);
    expect(s.c.state.hover).toBe("강남구");
    expect(s.view.cursors.at(-1)!.cls).not.toContain("is-hidden");
    expect(s.view.cursors.at(-1)!.p).toEqual(shown.p);
    s.frames(10, []); // 300ms를 넘기면 진짜로 놓침
    expect(s.c.state.hover).toBeNull();
    expect(s.view.cursors.at(-1)!.cls).toContain("is-hidden");
  });

  it("reacquiring a hand after a real loss resets the cursor filter", async () => {
    const cursor = createCursorMapper();
    const reset = vi.spyOn(cursor, "reset");
    const s = setup({ extra: { cursor } });
    await s.c.start("hands");
    s.frames(3, [hand("Open_Palm", 0.3, 0.5)]);
    const base = reset.mock.calls.length;
    s.frames(12, []); // 300ms 넘게 없음 → 놓침
    expect(reset.mock.calls.length).toBe(base);
    s.frame([hand("Open_Palm", 0.3, 0.5)]);
    expect(reset.mock.calls.length).toBe(base + 1);
    s.frames(3, [hand("Open_Palm", 0.3, 0.5)]);
    expect(reset.mock.calls.length).toBe(base + 1);
  });

  it("a different hand taking over at the 300ms boundary resets the cursor filter", async () => {
    const cursor = createCursorMapper();
    const reset = vi.spyOn(cursor, "reset");
    const s = setup({ extra: { cursor } });
    await s.c.start("hands");
    s.frames(5, [hand("Open_Palm", 0.3, 0.5)]);
    const base = reset.mock.calls.length;
    s.frames(9, []); // 297ms: 아직 기억 중, 커서 유지
    expect(s.view.cursors.at(-1)!.cls).not.toContain("is-hidden");
    s.frame([hand("Open_Palm", 0.8, 0.5)]); // 330ms: gestureMachine이 먼 손을 바로 주 손으로 잡는다
    expect(reset.mock.calls.length).toBe(base + 1);
    // 필터를 새로 시작했으므로 커서는 옛 손에서 미끄러지지 않고 새 손 위치(거울·가장자리 매핑)에 바로 선다.
    const p = s.view.cursors.at(-1)!.p!;
    expect(p.x).toBeCloseTo(0.125, 6);
    expect(p.y).toBeCloseTo(0.5, 6);
  });

  it("starts with the metric chosen on the host", async () => {
    const s = setup({ extra: { metric: "count" } });
    expect(s.scene.setOverview).toHaveBeenCalledWith(s.index.summary[MONTH], "count");
    expect(s.view.parts.top).toContain("거래 건수");
    await s.c.start("mouse");
    expect(s.wire[0]!.msg).toMatchObject({ type: "state", metric: "count" });
    s.key("v");
    expect(s.c.state.vote?.candidates).toEqual(["강동구", "서대문구", "종로구"]); // 건수 1·13·25위
  });

  it("vote panel redraws only when its text changes, not on every tick or frame", async () => {
    const s = setup();
    await s.c.start("hands");
    s.key("v");
    s.clock.advance(1500 + VOTE_TICK_MS);
    expect(s.c.state.vote?.phase).toBe("counting");
    const votes = () => s.view.ui.set.mock.calls.filter(([part]) => part === "vote").length;
    const lives = () => s.view.ui.set.mock.calls.filter(([part]) => part === "live").length;
    const v0 = votes();
    const l0 = lives();
    for (let i = 0; i < 16; i++) { // 4초 = 틱 16번, 그 사이 손 개수가 계속 바뀐다
      s.frames(3, i % 2 ? [hand("Open_Palm", 0.3), hand("Open_Palm", 0.7)] : [hand("Open_Palm")]);
      s.clock.advance(VOTE_TICK_MS);
    }
    expect(votes() - v0).toBe(4); // 남은 초가 바뀔 때만(초당 1번)
    expect(lives() - l0).toBeGreaterThan(4); // 실시간 손 개수는 따로 갱신
    expect(s.view.parts.live).toMatch(/카메라: 지금 [12]손/);
  });

  it("camera counting pushes every frame including zero hands", async () => {
    const counter = createVoteCounter();
    const push = vi.spyOn(counter, "push");
    const reset = vi.spyOn(counter, "reset");
    const s = setup();
    const c2 = createStageController({ ...s.deps, counter, ui: fakeUi().ui });
    s.c.dispose();
    await c2.start("hands");
    c2.key({ key: "v" });
    expect(c2.state.vote?.method).toBe("camera");
    s.frames(5, [hand("Open_Palm")]); // prompt 중에는 세지 않는다
    expect(push).not.toHaveBeenCalled();
    s.clock.advance(1500 + VOTE_TICK_MS);
    expect(c2.state.vote?.phase).toBe("counting");
    expect(reset).toHaveBeenCalledTimes(1);
    s.frames(20, [hand("Open_Palm", 0.3), hand("Open_Palm", 0.7)]);
    s.frames(20, []);
    expect(push).toHaveBeenCalledTimes(40);
    expect(push.mock.calls.at(-1)![1]).toBe(0);
    s.clock.advance(5000);
    expect(c2.state.vote?.counts[0]).toBe(2);
    expect(c2.state.vote?.sources[0]).toBe("camera");
    c2.dispose();
  });

  it("switching to camera during counting resets the counter", async () => {
    const counter = createVoteCounter();
    const reset = vi.spyOn(counter, "reset");
    const s = setup();
    const view = fakeUi();
    const c2 = createStageController({ ...s.deps, counter, ui: view.ui });
    s.c.dispose();
    await c2.start("mouse");
    c2.key({ key: "v" });
    s.clock.advance(1500 + VOTE_TICK_MS);
    expect(c2.state.vote?.phase).toBe("counting");
    const before = reset.mock.calls.length;
    c2.key({ key: "n" });
    expect(c2.state.vote?.method).toBe("camera");
    expect(reset.mock.calls.length).toBe(before + 1);
    expect(view.parts.live).toContain("카메라: 지금 0손");
    c2.key({ key: "n" });
    expect(c2.state.vote?.method).toBe("manual");
    expect(reset.mock.calls.length).toBe(before + 1);
    expect(view.parts.live).toBeNull();
    c2.dispose();
  });

  it("keys with modifiers or repeats are ignored, Hangul IME keys work", async () => {
    const s = setup();
    await s.c.start("mouse");
    expect(s.key("v", { ctrlKey: true })).toBe(false);
    expect(s.key("v", { metaKey: true })).toBe(false);
    expect(s.key("v", { altKey: true })).toBe(false);
    expect(s.c.state.vote).toBeNull();
    s.key("ㅍ", { code: "KeyV" });
    expect(s.c.state.vote?.round).toBe(1);
    expect(s.key("ㅍ", { code: "KeyV", repeat: true })).toBe(true); // 삼키되 다시 토글하지 않음
    expect(s.c.state.vote?.round).toBe(1);
    expect(s.c.state.vote).not.toBeNull();
    s.key("v");
    expect(s.c.state.vote).toBeNull();
    expect(s.key("Process", { code: "KeyV" })).toBe(true); // Windows 한국어 IME
    expect(s.c.state.vote?.round).toBe(2);
  });

  it("ui keys toggle hints, diag, preview and mute", async () => {
    const s = setup();
    await s.c.start("hands");
    expect(s.view.parts.hints).toContain("주먹");
    s.key("h");
    expect(s.view.parts.hints).toBeNull();
    s.key("d");
    s.clock.advance(VOTE_TICK_MS);
    expect(s.view.parts.diag).toContain("fps");
    s.key("d");
    expect(s.view.parts.diag).toBeNull();
    s.key("c");
    expect(s.view.ui.preview).toHaveBeenLastCalledWith("skeleton", s.src.source.video);
    s.key("m");
    expect(s.narr.narrator.muted).toBe(true);
  });

  it("captions from the narrator reach the caption part", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.narr.caption("강남구는 1위입니다.");
    expect(s.view.parts.caption).toContain("강남구는 1위입니다.");
    s.narr.caption(null);
    expect(s.view.parts.caption).not.toContain("<p>");
  });

  it("heartbeat republishes state and stage every 10s, dispose stops it", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.wire.length = 0;
    s.clock.advance(HEARTBEAT_MS);
    expect(s.wire.map((w) => w.msg.type)).toEqual(["state", "stage"]);
    s.c.dispose();
    expect(s.clock.jobs).toBe(0);
    expect(s.narr.narrator.stop).toHaveBeenCalled();
    s.clock.advance(HEARTBEAT_MS);
    expect(s.wire).toHaveLength(2);
  });
});
