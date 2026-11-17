import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { GU_ORDER } from "../data/gu";
import type { DataIndex, GuData, Stat } from "../data/types";
import type { StateMessage } from "../realtime/types";
import type { HandSource } from "../stage/hands/recognizer";
import { createCursorMapper } from "../stage/hands/cursor";
import { DEFAULT_GESTURE_CONFIG } from "../stage/hands/gestureMachine";
import { createVoteCounter } from "../stage/hands/voteCounter";
import { ALLOWED_KEYS, type StageChannelMessage, type StageMessage } from "../stage/net/messages";
import { createRotator } from "../stage/rotate";
import { createMockStageChannel } from "../stage/net/stageChannel";
import { createNarrator, type AudioLike, type NarrationItem, type Narrator } from "../stage/narrator";
import type { GestureName, HandFrame, HandObs, Point, Vec3 } from "../stage/types";
import {
  HAND_ERROR_LIMIT, HAND_START_TIMEOUT_MS, HEARTBEAT_MS, RESULT_GUARD_MS, VIEW_PUBLISH_MS, VOTE_TICK_MS,
  createStageController, normalizeKey, orderGestureEvents, stagePoint, voteCandidates, voteTiming, wheelPixels,
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
    /** 숨은 탭: 시간은 흐르는데 타이머는 돌지 않는다. 밀린 타이머는 다음 advance에서 한 번씩만 돈다(몰아서 돌지 않음). */
    skip(ms: number) {
      t += ms;
      for (const j of jobs) if (j.next < t) j.next = t;
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
    group: { rotation: { y: 0 } },
  };
}

/** 렌더 루프 대신: render(dt)가 onFrame 구독자를 부른다(dt 초). */
function fakeRenderer() {
  const subs = new Set<(dt: number) => void>();
  return {
    camera: new PerspectiveCamera(), setMode: vi.fn(), setZoom: vi.fn(), setPan: vi.fn(),
    onFrame(cb: (dt: number) => void) { subs.add(cb); return () => { subs.delete(cb); }; },
    render(dt: number) { for (const cb of [...subs]) cb(dt); },
    get listeners() { return subs.size; },
  };
}

function fakeNarrator() {
  const said: { id: string; interrupt: boolean; protect: boolean }[] = [];
  const captions = new Set<(t: string | null) => void>();
  const blockedSubs = new Set<() => void>();
  let muted = false;
  let unlocks = 0;
  let blocked = false;
  const narrator: Narrator = {
    say(id, opts) { said.push({ id, interrupt: !!opts?.interrupt, protect: !!opts?.protect }); },
    stop: vi.fn(),
    setMuted(m) { muted = m; },
    get muted() { return muted; },
    onCaption(cb) { captions.add(cb); return () => { captions.delete(cb); }; },
    async unlock() { unlocks++; },
    clipMs: () => null,
    onBlocked(cb) { blockedSubs.add(cb); return () => { blockedSubs.delete(cb); }; },
    get blocked() { return blocked; },
  };
  return {
    narrator, said,
    caption: (t: string | null) => { for (const cb of captions) cb(t); },
    block: () => { blocked = true; for (const cb of blockedSubs) cb(); },
    unblock: () => { blocked = false; },
    get unlocks() { return unlocks; },
    get blockedSubs() { return blockedSubs.size; },
  };
}

type FakeClock = ReturnType<typeof fakeClock>;

/** 가짜 시계 위 한 번짜리 타이머(fakeClock.every로 만든다). */
function once(clock: FakeClock, ms: number, fn: () => void): () => void {
  const stop = clock.every(ms, () => { stop(); fn(); });
  return stop;
}

/** 실제 narrator + 가짜 오디오: 재생하면 manifest ms 뒤에 ended(가짜 시계). 클립마다 시작·끝 시각을 기록한다. */
function timedNarrator(clock: FakeClock, items: Record<string, NarrationItem>) {
  const log: { id: string; start: number; end: number | null }[] = [];
  const byFile = new Map(Object.entries(items).map(([id, it]) => [`/narration/${it.file}`, { id, ms: it.ms ?? 1000 }]));
  let playing: { entry: (typeof log)[number]; stop: () => void } | null = null;
  const halt = () => {
    if (!playing) return;
    playing.entry.end ??= clock.now();
    playing.stop();
    playing = null;
  };
  const audio: AudioLike = {
    src: "", muted: false, onended: null, onerror: null,
    async play() {
      halt();
      const clip = byFile.get(audio.src);
      if (!clip) return; // 잠금 해제용 무음 클립
      const entry = { id: clip.id, start: clock.now(), end: null as number | null };
      log.push(entry);
      const stop = once(clock, clip.ms, () => { entry.end = clock.now(); playing = null; audio.onended?.(); });
      playing = { entry, stop };
    },
    pause: () => halt(),
  };
  const narrator = createNarrator({ v: 1, voice: "Seoyeon", engine: "generative", items }, {
    createAudio: () => audio,
    timers: { set: (fn, ms) => once(clock, ms, fn), clear: (h) => (h as () => void)() },
  });
  const nowPlaying = () => log.filter((e) => e.end === null).map((e) => e.id);
  return { narrator, log, nowPlaying };
}

/** 리뷰 실측 길이(MP3 프레임 계산)에 가까운 투표 해설. 후보는 가격 기본 후보(종로구·서대문구·강동구). */
const VOTE_ITEMS: Record<string, NarrationItem> = {
  "stage-hello": { file: "stage-hello.mp3", caption: "무대를 시작합니다.", ms: 3840 },
  "vote-intro": { file: "vote-intro.mp3", caption: "투표를 시작합니다.", ms: 3770 },
  "vote-prompt-종로구": { file: "vp-1.mp3", caption: "종로구 보고 싶은 분, 손 들어 주세요.", ms: 2690 },
  "vote-prompt-서대문구": { file: "vp-2.mp3", caption: "서대문구 보고 싶은 분, 손 들어 주세요.", ms: 2930 },
  "vote-prompt-강동구": { file: "vp-3.mp3", caption: "강동구 보고 싶은 분, 손 들어 주세요.", ms: 2520 },
  "vote-result-종로구-2": { file: "vr.mp3", caption: "종로구가 2표로 선정됐습니다.", ms: 2400 },
  "gu-202611-종로구": { file: "gu.mp3", caption: "종로구 해설", ms: 13_000 },
};

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

/** 손바닥 폭이 두 배인 손(가장 큰 손으로 뽑힌다). 손바닥 중심은 같다. */
function wideHand(gesture: GestureName, cx = 0.5, cy = 0.5): HandObs {
  const h = hand(gesture, cx, cy);
  h.landmarks[5] = [cx - 0.1, cy, 0];
  h.landmarks[17] = [cx + 0.1, cy, 0];
  return h;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(o: {
  months?: string[]; hash?: string; start?: () => Promise<StartResult>; narrator?: Narrator; makeNarrator?: (clock: FakeClock) => Narrator;
  pick?: (x: number, y: number) => string | null; extra?: Partial<StageControllerDeps>;
} = {}) {
  const clock = fakeClock();
  const ch = channels();
  const scene = fakeScene(o.pick);
  const renderer = fakeRenderer();
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
    scene, renderer, narrator: o.makeNarrator?.(clock) ?? o.narrator ?? narr.narrator, ui: view.ui, toast,
    startHands, hash: () => o.hash ?? "#/stage", clock, ...o.extra,
  };
  const c = createStageController(deps);
  let t = 5000;
  const frame = (hands: HandObs[], dt = 33) => { t += dt; src.emit({ t, hands }); };
  const frames = (n: number, hands: HandObs[], dt = 33) => { for (let i = 0; i < n; i++) frame(hands, dt); };
  const key = (k: string, extra: Partial<{ code: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => c.key({ key: k, ...extra });
  /** 카메라가 살아 있는 동안의 시간 흐름: 33ms마다 프레임을 내고 시계를 민다(프레임 먼저). */
  const live = (ms: number, hands: HandObs[] = []) => {
    for (let left = ms; left > 0; left -= 33) {
      const step = Math.min(33, left);
      frame(hands, step);
      clock.advance(step);
    }
  };
  /** 손 프레임 + 렌더 한 번 + 시계를 step(ms)씩 함께 민다(카메라와 렌더 루프가 모두 도는 동안). */
  const play = (ms: number, hands: HandObs[], step = 33) => {
    for (let left = ms; left > 0; left -= step) {
      const d = Math.min(step, left);
      frame(hands, d);
      renderer.render(d / 1000);
      clock.advance(d);
    }
  };
  /** 렌더 루프만 step(ms)씩(마우스 조작 사이의 시간). */
  const glide = (ms: number, step = 16) => {
    for (let left = ms; left > 0; left -= step) {
      const d = Math.min(step, left);
      renderer.render(d / 1000);
      clock.advance(d);
    }
  };
  const render = (dt = 1 / 60) => renderer.render(dt);
  const yaw = () => scene.group.rotation.y;
  /** 마지막으로 렌더러에 준 확대 배율(렌더 tick마다 준다). */
  const zoom = () => renderer.setZoom.mock.calls.at(-1)?.[0] as number | undefined;
  /** 마지막으로 렌더러에 준 옆 이동 panX(계약 13.8, 렌더 tick마다 준다). */
  const pan = () => renderer.setPan.mock.calls.at(-1)?.[0] as number | undefined;
  return { c, clock, ...ch, scene, renderer, narr, view, toast, index, loadGu, src, startHands, frame, frames, key, live, play, glide, render, yaw, zoom, pan, deps };
}

describe("voteCandidates", () => {
  const summary = makeIndex().summary[MONTH]!;
  it("defaults to 1st, 13th and 25th by price", () => {
    expect(voteCandidates("#/stage", summary)).toEqual(["종로구", "서대문구", "강동구"]);
  });
  it("takes valid names from the hash and fills the rest with defaults", () => {
    expect(voteCandidates("#/stage?vote=강남구,마포구,노원구", summary)).toEqual(["강남구", "마포구", "노원구"]);
    expect(voteCandidates("#/stage?vote=강남구,없는구", summary)).toEqual(["강남구", "종로구", "서대문구"]);
    expect(voteCandidates("#/stage?vote=종로구", summary)).toEqual(["종로구", "서대문구", "강동구"]);
    expect(voteCandidates("#/stage?vote=강남구,마포구,노원구,중구", summary)).toEqual(["강남구", "마포구", "노원구"]);
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
  it("M-5: also maps Escape, Enter and the arrows under the IME (Task 15)", () => {
    expect(normalizeKey("Process", "Escape")).toBe("Escape");
    expect(normalizeKey("Process", "Enter")).toBe("Enter");
    expect(normalizeKey("Process", "NumpadEnter")).toBe("Enter");
    expect(normalizeKey("Process", "ArrowLeft")).toBe("ArrowLeft");
    expect(normalizeKey("Process", "ArrowRight")).toBe("ArrowRight");
    expect(normalizeKey("Process", "ArrowUp")).toBe("ArrowUp");
    expect(normalizeKey("Process", "ArrowDown")).toBe("ArrowDown");
    expect(normalizeKey("Process", "F5")).toBe("Process");
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
    expect(sg!.msg).toEqual({ v: 1, type: "stage", mode: "map", lifted: null, ts: s.clock.now(), yaw: 0, zoom: 1, panX: 0 });
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
      s.live(1500 + VOTE_TICK_MS); // 카메라가 살아 있는 동안 시간이 흐른다(프레임이 멈추면 마우스로 바뀐다)
      expect(s.c.state.vote?.phase).toBe("counting");
      s.frames(20, [hand("Open_Palm", 0.3, 0.5), hand("Open_Palm", 0.7, 0.5)]);
      s.live(5000);
    }
    s.live(3000 + VOTE_TICK_MS);
    expect(s.c.state.vote?.phase).toBe("result");
    expect(s.c.state.vote?.counts).toEqual([2, 2, 2]);
    s.live(HEARTBEAT_MS);
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
    expect(s.wire.map((w) => w.msg)).toEqual([{ v: 1, type: "stage", mode: "spread", lifted: null, ts: s.clock.now(), yaw: 0, zoom: 1, panX: 0 }]);
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

  it("for 1.5s after the result appears, grab, spread and victory are ignored (F11)", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.key("v");
    for (const n of ["2", "1", "0"]) {
      s.clock.advance(1500 + VOTE_TICK_MS);
      s.key(n);
      s.clock.advance(1000 + VOTE_TICK_MS);
    }
    s.key("Enter");
    expect(s.c.state.vote?.phase).toBe("result");
    const said = s.narr.said.length;
    s.clock.advance(RESULT_GUARD_MS - 100);
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    s.c.pointer.down();
    s.c.pointer.up();
    s.key(" ");
    s.key("Escape");
    expect(s.c.state.vote?.phase).toBe("result");
    expect(s.c.state).toMatchObject({ lifted: null, mode: "map", focus: "종로구" });
    expect(s.narr.said.length).toBe(said); // 결과 해설이 끊기지 않았다
    s.clock.advance(100);
    s.key(" ");
    expect(s.c.state.mode).toBe("spread");
    expect(s.c.state.vote).toBeNull();
  });

  it("a fist held through the end of a camera vote does not grab on the result screen (F11)", async () => {
    const s = setup();
    await s.c.start("hands");
    const fist = [hand("Closed_Fist", 0.4, 0.6)];
    s.live(300, fist); // 주먹을 쥐고 hover
    s.key("v");
    for (let k = 0; k < 2000 && s.c.state.vote?.phase !== "result"; k++) s.live(33, fist);
    expect(s.c.state.vote?.phase).toBe("result");
    expect(s.c.state.vote?.counts).toEqual([1, 1, 1]);
    s.live(RESULT_GUARD_MS - 100, fist);
    expect(s.c.state.lifted).toBeNull();
    expect(s.c.state.vote?.phase).toBe("result");
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

  it("hand start slower than 20s falls back to mouse with a toast, the late source is stopped (F3)", async () => {
    let resolve!: (r: StartResult) => void;
    const s = setup({ start: () => new Promise<StartResult>((r) => { resolve = r; }) });
    const p = s.c.start("hands");
    await flush();
    expect(s.view.parts.start).toContain("준비하는 중");
    s.clock.advance(HAND_START_TIMEOUT_MS - 1);
    await flush();
    expect(s.c.started).toBe(false);
    s.clock.advance(1);
    await p;
    expect(s.c.started).toBe(true);
    expect(s.c.state.input).toBe("mouse");
    expect(s.view.parts.start).toBeNull();
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls[0]![0]).toContain("마우스");
    expect(s.toast.mock.calls[0]![0]).toContain("G로 다시 시도");
    expect(s.key(" ")).toBe(true); // 키를 다시 듣는다
    expect(s.clock.jobs).toBe(2); // 시작 대기 타이머는 정리되고 tick·heartbeat만
    resolve({ ok: true, source: s.src.source as unknown as HandSource }); // 늦게 도착
    await flush();
    expect(s.src.source.stop).toHaveBeenCalledTimes(1);
    expect(s.src.listeners).toBe(0);
    expect(s.c.state.input).toBe("mouse");
    // G로 다시 시도할 수 있고, 이번에도 늦으면 같은 길로 빠진다
    s.key("g");
    await flush();
    expect(s.startHands).toHaveBeenCalledTimes(2);
    s.clock.advance(HAND_START_TIMEOUT_MS);
    await flush();
    expect(s.toast).toHaveBeenCalledTimes(2);
    expect(s.c.state.input).toBe("mouse");
    s.key("g");
    await flush();
    expect(s.startHands).toHaveBeenCalledTimes(3);
  });

  it("the starting overlay offers 마우스로 계속, which starts in mouse mode right away (F3)", async () => {
    let resolve!: (r: StartResult) => void;
    const s = setup({ start: () => new Promise<StartResult>((r) => { resolve = r; }) });
    const p = s.c.start("hands");
    expect(s.view.parts.start).toContain('data-start="mouse"');
    expect(s.view.parts.start).toContain("마우스로 계속");
    void s.c.start("mouse");
    await p;
    expect(s.c.started).toBe(true);
    expect(s.c.state.input).toBe("mouse");
    expect(s.toast).not.toHaveBeenCalled();
    expect(s.clock.jobs).toBe(2);
    expect(s.narr.said.at(-1)?.id).toBe("stage-hello");
    resolve({ ok: true, source: s.src.source as unknown as HandSource });
    await flush();
    expect(s.src.source.stop).toHaveBeenCalledTimes(1);
    expect(s.c.state.input).toBe("mouse");
  });

  it("a normal hand start clears its timeout; leaving while waiting stops the late source (F3)", async () => {
    const s = setup();
    await s.c.start("hands");
    expect(s.clock.jobs).toBe(2);
    let resolve!: (r: StartResult) => void;
    const s2 = setup({ start: () => new Promise<StartResult>((r) => { resolve = r; }) });
    void s2.c.start("hands");
    s2.c.dispose();
    expect(s2.clock.jobs).toBe(0);
    resolve({ ok: true, source: s2.src.source as unknown as HandSource });
    await flush();
    expect(s2.src.source.stop).toHaveBeenCalledTimes(1);
    expect(s2.wire).toHaveLength(0); // 시작 전이었으니 아무것도 보내지 않는다
  });

  it("camera frames stopping for 1.5s in hand mode: mouse mode, the lifted gu is put down, cursor hidden, toast (F4)", async () => {
    const s = setup();
    await s.c.start("hands");
    s.live(300, [hand("Open_Palm", 0.4, 0.6)]);
    s.live(300, [hand("Closed_Fist", 0.4, 0.6)]);
    expect(s.c.state.lifted).toBe("강남구");
    s.wire.length = 0;
    s.clock.advance(1200); // 프레임이 멈췄다(USB 웹캠 빠짐 등)
    expect(s.c.state.input).toBe("hands");
    expect(s.toast).not.toHaveBeenCalled();
    s.clock.advance(600);
    expect(s.c.state.input).toBe("mouse");
    expect(s.c.state.lifted).toBeNull();
    expect(s.c.state.focus).toBe("강남구"); // 들고 있던 구는 그 자리에 내려놓는다
    expect(s.src.source.stop).toHaveBeenCalled();
    expect(s.src.listeners).toBe(0);
    expect(s.view.cursors.at(-1)!.cls).toContain("is-hidden");
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls[0]![0]).toContain("카메라 영상이 끊겨");
    expect(s.wire.filter((w) => w.msg.type === "stage").at(-1)?.msg).toMatchObject({ lifted: null });
    s.clock.advance(5000);
    expect(s.toast).toHaveBeenCalledTimes(1);
  });

  it("no stall fallback while the page is hidden (frames pause in background tabs) (F4)", async () => {
    let hidden = false;
    const s = setup({ extra: { hidden: () => hidden } });
    await s.c.start("hands");
    s.live(300, []);
    hidden = true;
    s.clock.advance(10_000);
    expect(s.c.state.input).toBe("hands");
    hidden = false; // 돌아온 뒤에도 프레임이 안 오면 그때부터 1.5초(돌아온 것을 본 첫 틱부터 잰다, 많아야 한 틱 늦음)
    s.clock.advance(1200);
    expect(s.c.state.input).toBe("hands");
    s.clock.advance(600 + VOTE_TICK_MS);
    expect(s.c.state.input).toBe("mouse");
  });

  it("back from a hidden tab whose timers slept a minute: no stall fallback on the first ticks, then 1.5s without frames still falls back", async () => {
    let hidden = false;
    const s = setup({ extra: { hidden: () => hidden } });
    await s.c.start("hands");
    s.live(300, []);
    hidden = true;
    s.clock.advance(VOTE_TICK_MS); // 숨은 뒤 틱이 한 번은 돈다
    s.clock.skip(60_000);          // 그 뒤로는 타이머가 1분 동안 돌지 않는다(숨은 탭 제한)
    hidden = false;
    s.clock.advance(VOTE_TICK_MS); // 보이게 된 첫 틱(밀린 틱)과 다음 틱
    expect(s.c.state.input).toBe("hands");
    s.clock.advance(1000);         // 돌아온 지 1.25초: 아직
    expect(s.c.state.input).toBe("hands");
    expect(s.toast).not.toHaveBeenCalled();
    s.clock.advance(600);          // 돌아온 지 1.5초가 넘도록 프레임이 없다
    expect(s.c.state.input).toBe("mouse");
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls[0]![0]).toContain("카메라 영상이 끊겨");
  });

  it("visibilitychange to visible resets the stall baseline even when no tick ran while hidden", async () => {
    let hidden = false;
    const subs = new Set<() => void>();
    const s = setup({ extra: { hidden: () => hidden, onVisibilityChange: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; } } });
    const notify = () => { for (const cb of [...subs]) cb(); };
    expect(subs.size).toBe(1);
    await s.c.start("hands");
    s.live(300, []);
    hidden = true; notify();
    s.clock.skip(60_000);          // 숨은 동안 틱이 한 번도 돌지 않았다
    hidden = false; notify();
    s.clock.advance(VOTE_TICK_MS);
    expect(s.c.state.input).toBe("hands");
    s.clock.advance(1200);
    expect(s.c.state.input).toBe("hands");
    s.clock.advance(600);
    expect(s.c.state.input).toBe("mouse");
    s.c.dispose();
    expect(subs.size).toBe(0);
  });

  it("hand start: hidden time does not count, the timeout does not fire on the first tick after coming back, 20s visible still times out (F3)", async () => {
    let hidden = false;
    let resolve!: (r: StartResult) => void;
    const s = setup({ start: () => new Promise<StartResult>((r) => { resolve = r; }), extra: { hidden: () => hidden } });
    const p = s.c.start("hands");
    await flush();
    s.clock.advance(5000);
    hidden = true;
    s.clock.advance(VOTE_TICK_MS);
    s.clock.skip(60_000);          // 준비가 숨은 탭에서 이어지는 동안 타이머는 1분 동안 돌지 않는다
    hidden = false;
    s.clock.advance(VOTE_TICK_MS); // 보이게 된 첫 틱
    await flush();
    expect(s.c.started).toBe(false);
    expect(s.toast).not.toHaveBeenCalled();
    s.clock.advance(HAND_START_TIMEOUT_MS - 2 * VOTE_TICK_MS); // 돌아온 지 20초 - 250ms
    await flush();
    expect(s.c.started).toBe(false);
    s.clock.advance(2 * VOTE_TICK_MS);
    await p;
    expect(s.c.started).toBe(true);
    expect(s.c.state.input).toBe("mouse");
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls[0]![0]).toContain("G로 다시 시도");
    expect(s.clock.jobs).toBe(2); // 시작 대기 감시는 정리되고 tick·heartbeat만
    resolve({ ok: true, source: s.src.source as unknown as HandSource });
    await flush();
    expect(s.src.source.stop).toHaveBeenCalledTimes(1);
  });

  it("hand start: a source that arrives after coming back from a hidden tab starts hand mode (F3)", async () => {
    let hidden = false;
    let resolve!: (r: StartResult) => void;
    const s = setup({ start: () => new Promise<StartResult>((r) => { resolve = r; }), extra: { hidden: () => hidden } });
    const p = s.c.start("hands");
    await flush();
    s.clock.advance(15_000);
    hidden = true;
    s.clock.advance(VOTE_TICK_MS);
    s.clock.skip(60_000);
    hidden = false;
    s.clock.advance(VOTE_TICK_MS);
    resolve({ ok: true, source: s.src.source as unknown as HandSource });
    await p;
    expect(s.c.state.input).toBe("hands");
    expect(s.toast).not.toHaveBeenCalled();
    s.live(2000, []);
    expect(s.c.state.input).toBe("hands");
  });

  it("no stall fallback while frames keep coming, or after switching to mouse (F4)", async () => {
    const s = setup();
    await s.c.start("hands");
    s.live(5000, []);
    expect(s.c.state.input).toBe("hands");
    s.key("g"); // 마우스로: 인식기는 그대로 두지만 정지 감시는 손 모드에서만
    s.clock.advance(5000);
    expect(s.c.state.input).toBe("mouse");
    expect(s.toast).not.toHaveBeenCalled();
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
    expect(s.c.state.vote?.candidates).toEqual(["종로구", "서대문구", "강동구"]); // 지표와 무관하게 ㎡당 가격 1·13·25위
  });

  it("default vote candidates are by price even when the metric is count, also after switching with P", async () => {
    // 스펙: 기본 후보는 "현재 월 ㎡당 중앙값 1위, 13위, 25위". 건수 기준이면 강동구·서대문구·종로구가 된다.
    const s = setup();
    await s.c.start("mouse");
    s.key("p");
    expect(s.c.state.metric).toBe("count");
    s.key("v");
    expect(s.c.state.vote?.candidates).toEqual(["종로구", "서대문구", "강동구"]);
    s.key("v");
    const u = setup({ hash: "#/stage?vote=마포구", extra: { metric: "count" } });
    await u.c.start("mouse");
    u.key("v");
    expect(u.c.state.vote?.candidates).toEqual(["마포구", "종로구", "서대문구"]); // URL 후보 뒤를 가격 기본 후보로 채운다
  });

  it("vote panel redraws only when its text changes, not on every tick or frame", async () => {
    const s = setup();
    await s.c.start("hands");
    s.key("v");
    s.live(1500 + VOTE_TICK_MS);
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
    // 카메라가 살아 있는 채로 counting에 들어갈 때까지(프레임을 먼저 내고 시계를 민다: 들어간 뒤의 프레임은 없다)
    for (let k = 0; k < 100 && c2.state.vote?.phase !== "counting"; k++) s.live(33);
    expect(c2.state.vote?.phase).toBe("counting");
    expect(reset).toHaveBeenCalledTimes(1);
    s.frames(20, [hand("Open_Palm", 0.3), hand("Open_Palm", 0.7)]);
    s.frames(20, []);
    expect(push).toHaveBeenCalledTimes(40);
    expect(push.mock.calls.at(-1)![1]).toBe(0);
    s.live(5000);
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

  it("a touch press with no pointermove before it lifts the gu under the finger (Task 14)", async () => {
    const s = setup({ pick: (x) => (x > 0 ? "강남구" : null) });
    await s.c.start("mouse");
    s.c.pointer.down({ x: 0.75, y: 0.25 });
    expect(s.scene.pick).toHaveBeenLastCalledWith(0.5, 0.5, s.renderer.camera);
    expect(s.c.state.lifted).toBe("강남구");
    s.c.pointer.up();
    expect(s.c.state.focus).toBe("강남구");
  });

  it("a narrow screen starts with the hints line hidden; H still shows it (Task 14)", async () => {
    const s = setup({ extra: { hintsDefault: false } });
    await s.c.start("mouse");
    expect(s.view.parts.hints ?? null).toBeNull();
    s.key("h");
    expect(s.view.parts.hints).toContain("누르고 있기");
  });

  it("M-1: the hover follows the map moving under a still mouse (zoom/spin), not only mouse moves (Task 15)", async () => {
    let under: string | null = "강남구";
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    expect(s.c.state.hover).toBe("강남구");
    under = "서초구"; // 지도가 움직이면 같은 자리 아래 구가 바뀐다
    s.render();
    expect(s.c.state.hover).toBe("강남구"); // 지도가 그대로면 다시 고르지 않는다
    s.c.pointer.wheel(-100);
    s.render();
    expect(s.c.state.hover).toBe("서초구");
  });

  it("M-4: G to mouse turns the camera off and the error fallback cannot toast in mouse mode; G again restarts hands (Task 15)", async () => {
    const s = setup();
    await s.c.start("hands");
    expect(s.c.state.input).toBe("hands");
    s.key("g");
    expect(s.c.state.input).toBe("mouse");
    expect(s.src.source.stop).toHaveBeenCalled();
    s.src.source.errors = 999;
    s.clock.advance(VOTE_TICK_MS * 4);
    expect(s.toast.mock.calls.some(([m]) => String(m).includes("손 인식이 계속 실패"))).toBe(false);
    const starts = s.startHands.mock.calls.length;
    s.key("g");
    await flush();
    expect(s.startHands.mock.calls.length).toBe(starts + 1);
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

  it("audio blocked by the browser: toast once, the next key, click or panel press retries unlock (F2)", async () => {
    const s = setup();
    await s.c.start("mouse");
    const base = s.narr.unlocks;
    s.narr.block();
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast).toHaveBeenLastCalledWith("소리가 막혔습니다 · 화면을 한 번 눌러 주세요");
    s.key("h");
    expect(s.narr.unlocks).toBe(base + 1);
    s.c.pointer.down();
    s.c.pointer.up();
    expect(s.narr.unlocks).toBe(base + 2); // 아직 막혀 있으면 다음 입력에서 또 시도
    s.key("v");
    s.c.panel({ set: "0:1" });
    expect(s.narr.unlocks).toBe(base + 4);
    s.narr.unblock();
    s.key("h");
    s.c.pointer.down();
    s.c.panel({ set: "0:2" });
    expect(s.narr.unlocks).toBe(base + 4); // 풀린 뒤에는 다시 시도하지 않는다
    expect(s.toast).toHaveBeenCalledTimes(1);
    s.c.dispose();
    expect(s.narr.blockedSubs).toBe(0);
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
    expect(s.wire).toHaveLength(3); // 떠날 때 마지막 stage 하나(F5)
    s.clock.advance(HEARTBEAT_MS);
    expect(s.wire).toHaveLength(3);
  });

  it("leaving after start sends one last stage message map/null so phones do not stay spread or lifted (F5)", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.key(" ");
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    s.c.pointer.down();
    expect(s.c.state).toMatchObject({ mode: "spread", lifted: "강남구" });
    s.wire.length = 0;
    s.c.dispose();
    expect(s.wire.map((w) => w.msg)).toEqual([{ v: 1, type: "stage", mode: "map", lifted: null, ts: s.clock.now() }]);
    s.c.dispose();
    expect(s.wire).toHaveLength(1);
  });

  it("the last stage message is best effort, and nothing is sent if the stage never started (F5)", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.flags.failStage = true;
    expect(() => s.c.dispose()).not.toThrow();
    await flush();
    const idle = setup();
    idle.c.dispose();
    expect(idle.wire).toHaveLength(0);
    expect(idle.stageChannel.publish).not.toHaveBeenCalled();
  });

  it("spread is always laid out by price; the metric only changes colours (F6)", async () => {
    const s = setup({ extra: { metric: "count" } });
    await s.c.start("mouse");
    s.key(" ");
    expect(s.scene.setLayout).toHaveBeenLastCalledWith("spread", s.index.summary[MONTH], "price");
    s.key("p");
    expect(s.c.state.metric).toBe("price");
    s.key("p");
    expect(s.c.state.metric).toBe("count");
    expect(s.scene.setOverview).toHaveBeenLastCalledWith(s.index.summary[MONTH], "count"); // 막대 색·시트는 현재 지표
    s.key(" ");
    expect(s.scene.setLayout).toHaveBeenLastCalledWith("map", s.index.summary[MONTH], "price");
    expect(s.scene.setLayout.mock.calls.every(([, , m]) => m === "price")).toBe(true);
  });

  it("spread re-laid out for a new month still uses price (F6)", async () => {
    const s = setup({ months: ["202610", MONTH], extra: { metric: "count" } });
    await s.c.start("mouse");
    s.key(" ");
    s.key("ArrowLeft");
    expect(s.scene.setLayout).toHaveBeenLastCalledWith("spread", s.index.summary["202610"], "price");
  });

  it("grabbing prefetches the gu, so release focuses it in the same turn as the map return (F7)", async () => {
    let under = "강남구";
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    s.c.pointer.down();
    s.c.pointer.up(); // focus 강남구
    await flush();
    s.key(" ");
    under = "마포구";
    s.c.pointer.move({ x: 0.4, y: 0.5 });
    s.c.pointer.down();
    expect(s.loadGu).toHaveBeenLastCalledWith(MONTH, "마포구"); // 드는 순간 받기 시작
    await flush();
    s.scene.focus.mockClear();
    s.scene.setLayout.mockClear();
    s.c.pointer.up();
    // 기다리지 않고 바로: 지도로 돌아가는 같은 차례에 새 구가 앉는다(옛 focus 강남구 막대가 다시 자랄 틈이 없다)
    expect(s.scene.focus).toHaveBeenCalledTimes(1);
    expect(s.scene.focus).toHaveBeenCalledWith("마포구", expect.objectContaining({ gu: "마포구" }), "price");
    expect(s.scene.setLayout.mock.invocationCallOrder[0]!).toBeLessThan(s.scene.focus.mock.invocationCallOrder[0]!);
    expect(s.loadGu.mock.calls.filter(([, g]) => g === "마포구")).toHaveLength(1);
  });

  it("if the gu data is still on its way at release, the new gu rises at once and its bars follow (F7)", async () => {
    let under = "강남구";
    const s = setup({ pick: () => under });
    let resolve!: (d: GuData) => void;
    s.loadGu.mockImplementation(async (month: string, gu: string) => {
      if (gu === "마포구") return new Promise<GuData>((r) => { resolve = r; });
      return { v: 1, month, gu, generatedAt: "", total: stat(1), dongs: [] };
    });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    s.c.pointer.down();
    s.c.pointer.up();
    await flush();
    s.key(" ");
    under = "마포구";
    s.c.pointer.move({ x: 0.4, y: 0.5 });
    s.c.pointer.down();
    s.scene.focus.mockClear();
    s.c.pointer.up();
    expect(s.scene.focus.mock.calls).toEqual([["마포구", null, "price"]]);
    resolve({ v: 1, month: MONTH, gu: "마포구", generatedAt: "", total: stat(1), dongs: [] });
    await flush();
    expect(s.scene.focus).toHaveBeenLastCalledWith("마포구", expect.objectContaining({ gu: "마포구" }), "price");
    expect(s.loadGu.mock.calls.filter(([, g]) => g === "마포구")).toHaveLength(1); // 미리 받던 요청을 이어 쓴다
  });

  it("vote candidates are prefetched so the winner is focused at once on the result (F7)", async () => {
    const s = setup();
    await s.c.start("mouse");
    s.key("v");
    expect(s.loadGu.mock.calls.map(([, g]) => g).sort()).toEqual(["강동구", "서대문구", "종로구"].sort());
    await flush();
    for (const n of ["2", "1", "0"]) {
      s.clock.advance(1500 + VOTE_TICK_MS);
      s.key(n);
      s.clock.advance(1000 + VOTE_TICK_MS);
    }
    s.scene.focus.mockClear();
    s.key("Enter");
    expect(s.scene.focus.mock.calls).toEqual([["종로구", expect.objectContaining({ gu: "종로구" }), "price"]]);
  });
});

describe("vote narration timing (F1)", () => {
  it("voteTiming: prompt clip + 300ms (at least 1500ms), intro clip length for the first prompt", () => {
    const ms: Record<string, number> = { "vote-intro": 3770, "vote-prompt-종로구": 2690, "vote-prompt-서대문구": 900 };
    const clipMs = (id: string) => ms[id] ?? null;
    expect(voteTiming(["종로구", "서대문구", "강동구"], clipMs)).toEqual({ promptMs: [2990, 1500, 1500], introMs: 3770 });
    expect(voteTiming(["종로구", "서대문구", "강동구"], () => null)).toEqual({ promptMs: [1500, 1500, 1500] });
  });

  it("manual vote: each prompt clip plays while its own candidate is on screen and is never pushed back", async () => {
    let tn!: ReturnType<typeof timedNarrator>;
    const s = setup({ makeNarrator: (clock) => (tn = timedNarrator(clock, VOTE_ITEMS)).narrator });
    await s.c.start("mouse");
    s.key("v");
    const mismatches: string[] = [];
    const check = () => {
      const v = s.c.state.vote;
      for (const id of tn.nowPlaying()) {
        if (!id.startsWith("vote-prompt-")) continue;
        const shown = v && v.phase !== "review" && v.phase !== "result" ? `vote-prompt-${v.candidates[v.index]}` : `(${v?.phase ?? "none"})`;
        if (id !== shown) mismatches.push(`${s.clock.now()}: 음성 ${id} / 화면 ${shown}`);
      }
    };
    // 발표자가 할 수 있는 가장 빠른 진행: 후보가 바뀌자마자 숫자를 누른다.
    for (const n of ["2", "1", "0"]) {
      const i = s.c.state.vote!.index;
      s.key(n);
      for (let k = 0; k < 200 && s.c.state.vote?.phase !== "review" && s.c.state.vote!.index === i; k++) {
        s.clock.advance(VOTE_TICK_MS);
        check();
      }
    }
    expect(s.c.state.vote?.phase).toBe("review");
    expect(mismatches).toEqual([]);
    const prompts = tn.log.filter((e) => e.id.startsWith("vote-prompt-"));
    expect(prompts.map((e) => e.id)).toEqual(["vote-prompt-종로구", "vote-prompt-서대문구", "vote-prompt-강동구"]);
    for (const e of prompts) expect(e.end! - e.start).toBe(VOTE_ITEMS[e.id]!.ms); // 끝까지 들렸다(끊기지 않음)
  });

  it("camera vote: the first counting window opens after the intro and the first prompt were heard, and stays 5s", async () => {
    let tn!: ReturnType<typeof timedNarrator>;
    const s = setup({ makeNarrator: (clock) => (tn = timedNarrator(clock, VOTE_ITEMS)).narrator });
    await s.c.start("hands");
    s.key("v");
    let countingAt: number | null = null;
    for (let k = 0; k < 400 && countingAt === null; k++) {
      s.live(33);
      if (s.c.state.vote?.phase === "counting") countingAt = s.clock.now();
    }
    expect(s.c.state.input).toBe("hands");
    const intro = tn.log.find((e) => e.id === "vote-intro")!;
    const prompt = tn.log.find((e) => e.id === "vote-prompt-종로구")!;
    expect(intro.end! - intro.start).toBe(3770);
    expect(prompt.end).not.toBeNull();
    expect(countingAt!).toBeGreaterThanOrEqual(prompt.end!);
    expect(s.c.state.vote!.endsAt! - countingAt!).toBeGreaterThanOrEqual(5000 - VOTE_TICK_MS);
  });

  it("cancelling a vote stops its narration, starting again does not repeat old prompts", async () => {
    let tn!: ReturnType<typeof timedNarrator>;
    const s = setup({ makeNarrator: (clock) => (tn = timedNarrator(clock, VOTE_ITEMS)).narrator });
    await s.c.start("mouse");
    s.key("v");
    s.clock.advance(500);
    expect(tn.nowPlaying()).toEqual(["vote-intro"]);
    s.key("v"); // 취소
    expect(s.c.state.vote).toBeNull();
    expect(tn.nowPlaying()).toEqual([]);
    s.key("v");
    s.clock.advance(3770 + 2690 + 2000);
    expect(tn.log.map((e) => e.id).filter((id) => id.startsWith("vote-"))).toEqual(["vote-intro", "vote-intro", "vote-prompt-종로구"]);
  });
});

describe("rotate and zoom (CONTRACTS-stage 13)", () => {
  type S = ReturnType<typeof setup>;
  /** 빈 곳에서 마우스로 x0 → x1 끌고, 멈췄다가 놓는다(관성 없음). */
  const dragSlow = (s: S, x0: number, x1: number) => {
    s.c.pointer.move({ x: x0, y: 0.5 });
    s.c.pointer.down();
    s.c.pointer.move({ x: (x0 + x1) / 2, y: 0.5 });
    s.c.pointer.move({ x: x1, y: 0.5 });
    s.glide(300);
    s.c.pointer.up();
  };
  /** b가 a보다 얼마나 앞섰나((-π, π]로 감아서: yaw는 정규화돼 ±π에서 넘어간다). */
  const turned = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  /** 두 손 주먹(영상 x). 손바닥 중심의 화면 x = (1 - x - 0.1) / 0.8. */
  const fists = (a: number, b: number) => [hand("Closed_Fist", a, 0.5), hand("Closed_Fist", b, 0.5)];

  it("fist on empty drags rotation", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    s.frames(4, [hand("Open_Palm", 0.6, 0.5)]);
    s.frames(6, [hand("Closed_Fist", 0.6, 0.5)]); // 빈 곳에서 주먹 확정
    expect(s.c.state).toMatchObject({ rotate: "one", lifted: null, hover: null });
    // 손을 화면 오른쪽으로 화면 폭의 1/4(영상 x는 거울이라 줄어든다) → 약 45°, 오른쪽이면 yaw 증가
    for (let i = 1; i <= 10; i++) s.play(33, [hand("Closed_Fist", 0.6 - i * 0.02, 0.5)]);
    s.play(500, [hand("Closed_Fist", 0.4, 0.5)]); // 쥔 채 멈추면 멈춘다(커서 필터가 따라붙는다)
    expect(s.yaw()).toBeGreaterThan(Math.PI / 4 - 0.02);
    expect(s.yaw()).toBeLessThan(Math.PI / 4 + 0.02);
    s.play(300, [hand("Open_Palm", 0.4, 0.5)]); // 천천히 놓으면 그 각도에 남는다
    expect(s.c.state).toMatchObject({ rotate: "none", spinning: false });
    const held = s.yaw();
    s.play(1000, [hand("Open_Palm", 0.4, 0.5)]);
    expect(s.yaw()).toBe(held);
    expect(s.scene.lift).not.toHaveBeenCalled();
  });

  it("flick then fist catches", async () => {
    let under: string | null = null;
    const s = setup({ pick: () => under });
    await s.c.start("hands");
    s.frames(4, [hand("Open_Palm", 0.8, 0.5)]);
    s.frames(6, [hand("Closed_Fist", 0.8, 0.5)]);
    expect(s.c.state.rotate).toBe("one");
    let x = 0.8;
    for (let i = 0; i < 6; i++) s.play(33, [hand("Closed_Fist", (x -= 0.04), 0.5)]);
    // 밀면서 편다: 놓기가 확정되는 동안에도 손은 움직이고 있다
    for (let i = 0; i < 8 && s.c.state.rotate === "one"; i++) s.play(33, [hand("Open_Palm", (x -= 0.04), 0.5)]);
    expect(s.c.state).toMatchObject({ rotate: "none", spinning: true }); // 놓은 같은 차례에 spinState
    const a = s.yaw();
    s.play(500, [hand("Open_Palm", x, 0.5)]);
    expect(turned(a, s.yaw())).toBeGreaterThan(0.5); // 놓은 뒤에도 관성으로 돈다(0.5초에 약 75°)
    under = "강남구";
    s.play(400, [hand("Open_Palm", x, 0.5)]); // 관성이 이어지는 동안(관성 중 주먹은 쿨다운을 기다리지 않는다: fix A2 테스트)
    expect(s.c.state).toMatchObject({ spinning: true, hover: "강남구" }); // 관성 중에는 hover가 갱신된다
    for (let i = 0; i < 8 && s.c.state.spinning; i++) s.play(33, [hand("Closed_Fist", x, 0.5)]);
    // 구 위에서 쥐어도 잡기만 한다(들지 않음), 그대로 쥐고 있으면 이어서 돌릴 수 있다
    expect(s.c.state).toMatchObject({ spinning: false, rotate: "one", lifted: null, hover: null });
    expect(s.scene.lift).not.toHaveBeenCalled();
    const caught = s.yaw();
    s.render(0.5);
    expect(s.yaw()).toBe(caught); // 그 자리에서 멈췄다
  });

  it("two fists rotate and zoom", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    s.frames(6, fists(0.4, 0.6)); // 화면 0.625·0.375: 중점 0.5, 거리 0.25
    expect(s.c.state.rotate).toBe("two");
    s.frame(fists(0.275, 0.525)); // 화면 0.78125·0.46875: 중점 +0.125 → 22.5°, 거리 0.3125 → 1.25배
    s.render();
    expect(s.yaw()).toBeCloseTo(Math.PI / 8, 9);
    expect(s.zoom()).toBeCloseTo(1.25, 9);
    s.frame(fists(0.32, 0.48)); // 화면 0.725·0.525: 중점 그대로, 거리 0.2 → 0.8배
    s.render();
    expect(s.yaw()).toBeCloseTo(Math.PI / 8, 9);
    expect(s.zoom()).toBeCloseTo(0.8, 9);
    s.play(300, fists(0.32, 0.48));
    s.play(300, [hand("Closed_Fist", 0.32, 0.5), hand("Open_Palm", 0.48, 0.5)]); // 한 손을 펴면 끝
    expect(s.c.state).toMatchObject({ rotate: "none", spinning: false, lifted: null });
    s.render(0.5);
    expect(s.yaw()).toBeCloseTo(Math.PI / 8, 9); // 각도·배율은 남는다
    expect(s.zoom()).toBeCloseTo(0.8, 9);
  });

  it("three hands during a two-fist rotation do not jump yaw or zoom", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    s.frames(6, fists(0.4, 0.6));
    s.frame(fists(0.275, 0.525));
    s.render();
    const y0 = s.yaw();
    const z0 = s.zoom();
    // 셋째 손(손바닥이 커서 둘째 손으로 뽑힌다)이 잠깐 보인다: 그 프레임들은 건너뛴다(끝내지도 않음)
    s.frames(4, [wideHand("Open_Palm", 0.85, 0.3), ...fists(0.275, 0.525)]);
    s.render();
    expect(s.c.state.rotate).toBe("two");
    expect(s.yaw()).toBe(y0);
    expect(s.zoom()).toBe(z0);
    s.frames(2, fists(0.275, 0.525)); // 두 손으로 돌아오면 같은 자리에서 이어진다
    s.render();
    expect(s.c.state.rotate).toBe("two");
    expect(s.yaw()).toBeCloseTo(y0, 9);
    expect(s.zoom()).toBeCloseTo(z0!, 9);
  });

  it("mouse drag rotates and wheel zooms", async () => {
    let under: string | null = null;
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.2, y: 0.5 });
    s.c.pointer.down();
    expect(s.c.state).toMatchObject({ rotate: "one", lifted: null });
    s.c.pointer.move({ x: 0.45, y: 0.5 });
    s.c.pointer.move({ x: 0.7, y: 0.5 }); // 화면 폭의 절반 → 90°
    s.render();
    expect(s.yaw()).toBeCloseTo(Math.PI / 2, 9);
    s.glide(300); // 멈췄다 떼면 관성 없음
    s.c.pointer.up();
    expect(s.c.state).toMatchObject({ rotate: "none", spinning: false });
    s.render(0.5);
    expect(s.yaw()).toBeCloseTo(Math.PI / 2, 9);
    s.c.pointer.wheel(-100); // 위로 한 칸: 확대
    s.render();
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    s.c.pointer.wheel(100);
    s.c.pointer.wheel(100); // 아래로 두 칸: 축소
    s.render();
    expect(s.zoom()).toBeCloseTo(1 / 1.1, 9);
    // 빠르게 끌다 떼면 관성, 도는 중 클릭은 잡기만 한다(구 위여도 들지 않음)
    s.c.pointer.down();
    for (let i = 1; i <= 6; i++) {
      s.c.pointer.move({ x: 0.7 - i * 0.05, y: 0.5 });
      s.glide(16);
    }
    s.c.pointer.up();
    expect(s.c.state.spinning).toBe(true);
    const a = s.yaw();
    s.glide(100);
    expect(turned(a, s.yaw())).toBeLessThan(0); // 왼쪽으로 밀었으니 yaw가 줄며 돈다
    under = "강남구";
    s.c.pointer.move({ x: 0.4, y: 0.5 });
    s.c.pointer.down();
    expect(s.c.state).toMatchObject({ spinning: false, rotate: "one", lifted: null });
    const caught = s.yaw();
    s.render(0.5);
    expect(s.yaw()).toBe(caught);
    s.c.pointer.up();
    expect(s.c.state.hover).toBe("강남구"); // 놓으면 포인터 아래 구를 다시 고른다
    expect(s.scene.lift).not.toHaveBeenCalled();
  });

  it("spread resets yaw to 0", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    dragSlow(s, 0.2, 0.7);
    s.c.pointer.wheel(-100);
    s.render();
    expect(s.yaw()).toBeCloseTo(Math.PI / 2, 9);
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    s.key(" ");
    expect(s.c.state).toMatchObject({ mode: "spread", rotate: "none", spinning: false });
    s.render(0.3); // 부드럽게 정면으로
    expect(s.yaw()).toBeGreaterThan(0);
    expect(s.yaw()).toBeLessThan(Math.PI / 2);
    s.render(0.4);
    expect(s.yaw()).toBe(0);
    expect(s.zoom()).toBe(1);
    // 펼친 화면에서는 끌기가 돌리지 않는다(휠·두 주먹 확대는 계약 13.8: 아래 spread zoom 테스트)
    s.c.pointer.move({ x: 0.2, y: 0.5 });
    s.c.pointer.down();
    s.c.pointer.move({ x: 0.8, y: 0.5 });
    s.render();
    expect(s.c.state.rotate).toBe("none");
    expect(s.yaw()).toBe(0);
    expect(s.zoom()).toBe(1);
    s.c.pointer.up();

    // 움직임 줄이기: 정면 복귀가 즉시
    const r = setup({ pick: () => null, extra: { reducedMotion: true } });
    await r.c.start("mouse");
    dragSlow(r, 0.2, 0.7);
    r.render();
    expect(r.yaw()).toBeCloseTo(Math.PI / 2, 9);
    r.key(" ");
    r.render(0.001);
    expect(r.yaw()).toBe(0);
  });

  it("victory resets rotated map", async () => {
    const rotator = createRotator();
    const reset = vi.spyOn(rotator, "reset");
    const s = setup({ pick: () => null, extra: { rotator } });
    await s.c.start("mouse");
    dragSlow(s, 0.2, 0.7);
    s.c.pointer.wheel(-100);
    s.render();
    // 돌리기만 한 지도: 상태는 처음과 같다(focus·lifted 없음, 잡기·관성 없음)
    expect(s.c.state).toMatchObject({ mode: "map", rotate: "none", spinning: false, focus: null, lifted: null, vote: null });
    expect(s.yaw()).toBeCloseTo(Math.PI / 2, 9);
    s.key("Escape");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenLastCalledWith(false);
    s.render(0.7);
    expect(s.yaw()).toBe(0);
    expect(s.zoom()).toBe(1);
  });

  it("rotation publishes at most 5Hz with yaw zoom", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    s.glide(1000); // 시작 발행에서 충분히 지났다
    s.wire.length = 0;
    const sent = () => s.wire.filter((w) => w.msg.type === "stage").map((w) => w.msg as StageMessage);
    s.c.pointer.move({ x: 0.1, y: 0.5 });
    s.c.pointer.down();
    expect(sent()).toHaveLength(0); // 빈 곳 잡기만으로는 보내지 않는다
    const start = s.clock.now();
    for (let i = 1; i <= 60; i++) { // 약 1초 동안 매 렌더마다 조금씩 끈다
      s.c.pointer.move({ x: 0.1 + i * 0.005, y: 0.5 });
      s.glide(16);
    }
    const during = sent();
    expect(during[0]!.ts).toBe(start); // 처음 바뀐 렌더에서 바로(앞쪽)
    expect(during.length).toBeLessThanOrEqual(Math.floor((s.clock.now() - start) / VIEW_PUBLISH_MS) + 1);
    expect(during.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < during.length; i++) expect(during[i]!.ts - during[i - 1]!.ts).toBeGreaterThanOrEqual(VIEW_PUBLISH_MS);
    for (const m of during) {
      expect(m).toMatchObject({ mode: "map", lifted: null, zoom: 1 });
      expect(m.yaw).toBeGreaterThan(0);
      expect(Object.keys(m).every((k) => ALLOWED_KEYS.stage.includes(k))).toBe(true);
    }
    // 멈추면 마지막 각도로 한 번 더, 그 뒤로는 조용하다
    s.glide(1000);
    const all = sent();
    expect(all).toHaveLength(during.length + 1);
    expect(all.at(-1)!.yaw).toBe(s.yaw());
    expect(all.at(-1)!.ts - during.at(-1)!.ts).toBeGreaterThanOrEqual(VIEW_PUBLISH_MS);
    s.c.pointer.up();
    s.glide(1000);
    expect(sent()).toHaveLength(all.length);
    // 휠 확대도 같은 길로 나간다
    s.c.pointer.wheel(-100);
    s.glide(16);
    expect(sent().at(-1)).toMatchObject({ yaw: s.yaw(), zoom: s.zoom() });
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    // 하트비트에도 각도·배율이 실린다
    s.wire.length = 0;
    s.clock.advance(HEARTBEAT_MS);
    expect(sent().at(-1)).toMatchObject({ yaw: s.yaw(), zoom: s.zoom() });
    await flush();
    expect(s.c.publishFailed).toBe(false); // 모의 채널(toWire)이 모두 받아들였다
  });

  it("no hover while rotating", async () => {
    let under: string | null = null;
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.2, y: 0.5 });
    s.c.pointer.down();
    expect(s.c.state.rotate).toBe("one");
    under = "강남구";
    s.scene.pick.mockClear();
    s.c.pointer.move({ x: 0.4, y: 0.5 });
    s.c.pointer.move({ x: 0.5, y: 0.5 });
    expect(s.scene.pick).not.toHaveBeenCalled();
    expect(s.c.state.hover).toBeNull();
    expect(s.scene.setHover).not.toHaveBeenCalledWith("강남구");
    s.c.pointer.up();
    expect(s.c.state.hover).toBe("강남구");

    // 손: 주먹으로 돌리는 동안 커서가 구 위를 지나도 고르지 않는다
    let below: string | null = null;
    const h = setup({ pick: () => below });
    await h.c.start("hands");
    h.frames(6, [hand("Closed_Fist", 0.6, 0.5)]);
    expect(h.c.state.rotate).toBe("one");
    below = "강남구";
    h.scene.pick.mockClear();
    h.frames(6, [hand("Closed_Fist", 0.5, 0.5)]);
    expect(h.scene.pick).not.toHaveBeenCalled();
    expect(h.c.state.hover).toBeNull();
    expect(h.view.cursors.at(-1)!.cls).not.toContain("is-hover");
    h.frames(8, [hand("Open_Palm", 0.5, 0.5)]); // 놓으면 다음 프레임부터 다시 고른다
    expect(h.c.state.rotate).toBe("none");
    h.frame([hand("Open_Palm", 0.5, 0.5)]);
    expect(h.c.state.hover).toBe("강남구");
  });

  it("lifted blocks rotation", async () => {
    const s = setup(); // 어디든 강남구
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.2, y: 0.5 });
    s.c.pointer.down();
    expect(s.c.state.lifted).toBe("강남구");
    s.c.pointer.move({ x: 0.9, y: 0.5 });
    s.c.pointer.wheel(-300);
    s.render();
    expect(s.c.state.rotate).toBe("none");
    expect(s.yaw()).toBe(0);
    expect(s.zoom()).toBe(1);
    s.c.pointer.up();
    expect(s.c.state.focus).toBe("강남구");
    // 투표 중에도 휠은 확대하지 않는다
    s.key("v");
    s.c.pointer.wheel(-300);
    s.render();
    expect(s.zoom()).toBe(1);

    // 손: 구 위 주먹은 들어올리기, 든 채 끌어도 돌지 않는다
    const h = setup();
    await h.c.start("hands");
    h.frames(6, [hand("Closed_Fist", 0.6, 0.5)]);
    expect(h.c.state).toMatchObject({ lifted: "강남구", rotate: "none" });
    h.play(400, [hand("Closed_Fist", 0.3, 0.5)]);
    expect(h.yaw()).toBe(0);
  });

  it("wheel trackpad burst steps at most once per 100 units", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    const z = () => { s.render(); return s.zoom(); };
    for (let i = 0; i < 24; i++) s.c.pointer.wheel(-4); // 트랙패드: 작은 값이 몰려 온다(96)
    expect(z()).toBe(1);
    for (let i = 0; i < 6; i++) s.c.pointer.wheel(-4); // 120 → 한 단계
    expect(z()).toBeCloseTo(1.1, 9);
    for (let i = 0; i < 20; i++) s.c.pointer.wheel(-4); // 200 → 두 단계
    expect(z()).toBeCloseTo(1.21, 9);
    s.c.pointer.wheel(-60);
    s.c.pointer.wheel(50); // 방향이 바뀌면 새로 센다
    expect(z()).toBeCloseTo(1.21, 9);
    s.c.pointer.wheel(50); // 100 → 축소 한 단계
    expect(z()).toBeCloseTo(1.1, 9);
    // 줄 단위(deltaMode 1, ×16)
    s.c.pointer.wheel(-3, 1);
    s.c.pointer.wheel(-3, 1); // 96
    expect(z()).toBeCloseTo(1.1, 9);
    s.c.pointer.wheel(-3, 1); // 144 → 한 단계
    expect(z()).toBeCloseTo(1.21, 9);
    // 페이지 단위(deltaMode 2, ×800): 여덟 단계지만 0.7에서 멈춘다
    s.c.pointer.wheel(1, 2);
    expect(z()).toBeCloseTo(0.7, 9);
  });

  it("twoFist over a gu rotates without lifting", async () => {
    const s = setup(); // 어디든 강남구
    await s.c.start("hands");
    s.frames(3, [hand("Open_Palm", 0.4, 0.5)]);
    expect(s.c.state.hover).toBe("강남구");
    const said = s.narr.said.length;
    s.wire.length = 0;
    // 두 손이 같은 프레임에 주먹이 된다: grab과 twoFist가 함께 나도 두 주먹이 먼저라 구를 들지 않는다
    s.frames(6, fists(0.4, 0.6));
    expect(s.c.state).toMatchObject({ rotate: "two", lifted: null, focus: null, hover: null });
    expect(s.scene.lift).not.toHaveBeenCalled();
    expect(s.narr.said.slice(said)).toEqual([]);
    expect(s.wire).toHaveLength(0); // 들었다 내린 깜빡임도 나가지 않는다

    // 한 손 주먹으로 든 뒤 다른 손도 주먹: 든 구는 고르지 않은 채 내려가고 돌린다(리듀서 규칙)
    const t = setup();
    await t.c.start("hands");
    t.frames(6, [hand("Closed_Fist", 0.4, 0.5)]);
    expect(t.c.state.lifted).toBe("강남구");
    t.frames(6, fists(0.4, 0.7));
    expect(t.c.state).toMatchObject({ rotate: "two", lifted: null, focus: null });
    expect(t.scene.lift).toHaveBeenLastCalledWith(null);
    t.frame(fists(0.3, 0.6)); // 둘 다 화면 오른쪽으로 0.125 → 22.5°
    t.render();
    expect(t.yaw()).toBeCloseTo(Math.PI / 8, 9);
  });

  it("primary null blocks grabTwo", async () => {
    const rotator = createRotator();
    const grabTwo = vi.spyOn(rotator, "grabTwo");
    const moveTwo = vi.spyOn(rotator, "moveTwo");
    const s = setup({ pick: () => null, extra: { rotator } });
    await s.c.start("hands");
    s.frames(3, [hand("Open_Palm", 0.5, 0.5)]); // 주 손을 기억한다(300ms)
    // 기억한 손목에서 먼 두 주먹: 기억하는 동안 주 손은 null, 둘째 손만 있다
    const far = fists(0.15, 0.85);
    s.frames(6, far); // 198ms: twoFist
    expect(s.c.state.rotate).toBe("two");
    s.frames(3, far); // 297ms: 아직 주 손 없음
    expect(grabTwo).not.toHaveBeenCalled();
    expect(moveTwo).not.toHaveBeenCalled();
    s.render();
    expect(s.yaw()).toBe(0);
    s.frame(far); // 330ms: 기억이 끝나 가장 큰 손이 주 손 → 두 손이 다 있어 이제 잡는다
    expect(grabTwo).toHaveBeenCalledTimes(1);
    s.frame(fists(0.1, 0.8));
    expect(moveTwo).toHaveBeenCalledTimes(1);
    s.render();
    expect(s.yaw()).toBeCloseTo(0.0625 * Math.PI, 9); // 중점 0.5 → 0.5625
  });

  it("a doubly-detected hand does not become a near-zero zoom baseline", async () => {
    const rotator = createRotator();
    const grabTwo = vi.spyOn(rotator, "grabTwo");
    const s = setup({ pick: () => null, extra: { rotator } });
    await s.c.start("hands");
    s.frames(6, fists(0.5, 0.505)); // 같은 주먹이 두 번 잡혔다: twoFist는 나지만 잡지 않는다
    expect(s.c.state.rotate).toBe("two");
    expect(grabTwo).not.toHaveBeenCalled();
    s.frame(fists(0.4, 0.6)); // 진짜 두 손: 이 거리를 기준으로 잡는다(1.6배로 튀지 않음)
    expect(grabTwo).toHaveBeenCalledTimes(1);
    s.render();
    expect(s.zoom()).toBe(1);
    s.frame(fists(0.375, 0.625)); // 거리 0.25 → 0.3125
    s.render();
    expect(s.zoom()).toBeCloseTo(1.25, 9);
  });

  it("without WebGL the vote tick drives the rotator; dispose stops the render loop subscription", async () => {
    const s = setup({ extra: { renderer: null } }); // pick 없음 → 어디서나 빈 곳
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.2, y: 0.5 });
    s.c.pointer.down();
    for (let i = 1; i <= 6; i++) { s.c.pointer.move({ x: 0.2 + i * 0.05, y: 0.5 }); s.clock.advance(16); }
    s.c.pointer.up();
    s.clock.advance(VOTE_TICK_MS);
    expect(s.c.state.spinning).toBe(true); // 틱에서 spinState
    s.clock.advance(5000);
    expect(s.c.state.spinning).toBe(false); // 관성이 끝난다
    expect(s.scene.group.rotation.y).not.toBe(0);
    const r = setup();
    expect(r.renderer.listeners).toBe(1);
    r.c.dispose();
    expect(r.renderer.listeners).toBe(0);
  });

  it("wheelPixels and orderGestureEvents", () => {
    expect(wheelPixels(-4)).toBe(-4);
    expect(wheelPixels(3, 1)).toBe(48);
    expect(wheelPixels(-1, 2)).toBe(-800);
    expect(orderGestureEvents([{ type: "grab" }, { type: "twoFist" }])).toEqual([{ type: "twoFist" }, { type: "grab" }]);
    expect(orderGestureEvents([{ type: "release" }, { type: "grab" }, { type: "twoFist" }, { type: "spread" }]))
      .toEqual([{ type: "release" }, { type: "twoFist" }, { type: "grab" }, { type: "spread" }]);
    expect(orderGestureEvents([{ type: "grab" }])).toEqual([{ type: "grab" }]);
    expect(orderGestureEvents([{ type: "twoFistEnd" }, { type: "twoFist" }])).toEqual([{ type: "twoFistEnd" }, { type: "twoFist" }]);
  });

  it("losing the rotating fist while another hand is visible: no yaw jump, no spin; a re-acquired fist turns only by what it moves after (fix A1)", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    const palm = hand("Open_Palm", 0.2, 0.5); // 화면 오른쪽 끝(0.875)에 편 손이 계속 보인다
    const grip = wideHand("Closed_Fist", 0.6, 0.5); // 손바닥이 넓어 주 손(화면 0.375)
    s.frames(6, [grip, palm]);
    expect(s.c.state.rotate).toBe("one");
    s.play(500, [grip, palm]);
    const held = s.yaw();
    // 주먹만 사라진다: 300ms가 되는 프레임에 놓기, 같은 프레임에 편 손이 주 손이 된다
    for (let i = 0; i < 15 && s.c.state.rotate === "one"; i++) s.play(33, [palm]);
    expect(s.c.state).toMatchObject({ rotate: "none", spinning: false });
    expect(s.yaw()).toBe(held);
    s.play(1500, [palm]);
    expect(s.yaw()).toBe(held);

    // 같은 주먹을 다시 잡은 프레임(프레임이 0.4초 멈췄다 오고 그 사이 손이 움직였다): 기준만 다시 잡고, 그 뒤 움직인 만큼만 돈다
    const r = setup({ pick: () => null });
    await r.c.start("hands");
    r.frames(6, [hand("Closed_Fist", 0.6, 0.5)]);
    r.play(300, [hand("Closed_Fist", 0.6, 0.5)]);
    const y0 = r.yaw();
    r.frame([hand("Closed_Fist", 0.5, 0.5)], 400); // 화면 0.375 → 0.5(다시 잡음, 정지 가드로 놓지 않음)
    r.render();
    expect(r.c.state.rotate).toBe("one");
    expect(r.yaw()).toBe(y0);
    for (let i = 1; i <= 4; i++) r.play(33, [hand("Closed_Fist", 0.5 - i * 0.02, 0.5)]); // 화면 +0.1 → 18°
    r.play(500, [hand("Closed_Fist", 0.42, 0.5)]);
    expect(turned(y0, r.yaw())).toBeGreaterThan(Math.PI / 10 - 0.02);
    expect(turned(y0, r.yaw())).toBeLessThan(Math.PI / 10 + 0.02);
  });

  it("a fist 300ms after a flick catches the spin without waiting for the gesture cooldown (fix A2)", async () => {
    let under: string | null = null;
    const f = setup({ pick: () => under });
    await f.c.start("hands");
    f.frames(6, [hand("Closed_Fist", 0.8, 0.5)]);
    let x = 0.8;
    for (let i = 0; i < 6; i++) f.play(33, [hand("Closed_Fist", (x -= 0.04), 0.5)]);
    for (let i = 0; i < 8 && f.c.state.rotate === "one"; i++) f.play(33, [hand("Open_Palm", (x -= 0.04), 0.5)]);
    expect(f.c.state).toMatchObject({ rotate: "none", spinning: true });
    const releasedAt = f.clock.now();
    under = "강남구"; // 구 위에서 쥐어도 들지 않고 잡기만 한다
    f.play(300, [hand("Open_Palm", x, 0.5)]);
    expect(f.c.state).toMatchObject({ spinning: true, hover: "강남구" });
    for (let i = 0; i < 6 && f.c.state.spinning; i++) f.play(33, [hand("Closed_Fist", x, 0.5)]);
    expect(f.c.state).toMatchObject({ spinning: false, rotate: "one", lifted: null });
    expect(f.scene.lift).not.toHaveBeenCalled();
    expect(f.clock.now() - releasedAt).toBeLessThan(DEFAULT_GESTURE_CONFIG.cooldownMs);
    const caught = f.yaw();
    f.render(0.5);
    expect(f.yaw()).toBe(caught); // 그 자리에서 멈췄다
  });

  it("hand flick: the speed is taken when the hand opens, so a sweep that stops while the release confirms still spins (fix A3)", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    s.frames(6, [hand("Closed_Fist", 0.8, 0.5)]);
    s.play(300, [hand("Closed_Fist", 0.8, 0.5)]);
    let x = 0.8;
    for (let i = 0; i < 6; i++) s.play(33, [hand("Closed_Fist", (x -= 0.04), 0.5)]); // 화면 0.05/33ms ≈ 273°/s
    s.play(33, [hand("Open_Palm", (x -= 0.04), 0.5)]); // 끝에서 손을 편다
    for (let i = 0; i < 8 && s.c.state.rotate === "one"; i++) s.play(33, [hand("Open_Palm", x, 0.5)]); // 멈춘 채 놓기 확정(6프레임)
    expect(s.c.state).toMatchObject({ rotate: "none", spinning: true });
    const a = s.yaw();
    s.render(0.05);
    // 처음 0.05초에 ≥ 150°/s × 0.047(지수 감속 적분): 놓기 확정 때의 정지가 아니라 편 순간의 속도
    expect(turned(a, s.yaw())).toBeGreaterThan((150 * Math.PI / 180) * (1 - Math.exp(-2.5 * 0.05)) / 2.5);

    // 멈추고 0.2초 쥐고 있다가 편 손: 관성 없음
    const r = setup({ pick: () => null });
    await r.c.start("hands");
    r.frames(6, [hand("Closed_Fist", 0.8, 0.5)]);
    r.play(300, [hand("Closed_Fist", 0.8, 0.5)]);
    let y = 0.8;
    for (let i = 0; i < 7; i++) r.play(33, [hand("Closed_Fist", (y -= 0.04), 0.5)]);
    r.play(200, [hand("Closed_Fist", y, 0.5)]);
    for (let i = 0; i < 8 && r.c.state.rotate === "one"; i++) r.play(33, [hand("Open_Palm", y, 0.5)]);
    expect(r.c.state).toMatchObject({ rotate: "none", spinning: false });

    // 두 주먹: 함께 밀다 끝에서 한 손을 펴고 멈춰도 관성
    const t = setup({ pick: () => null });
    await t.c.start("hands");
    let p = 0.6;
    let q = 0.8;
    t.frames(6, fists(p, q));
    expect(t.c.state.rotate).toBe("two");
    for (let i = 0; i < 6; i++) t.play(33, fists((p -= 0.04), (q -= 0.04)));
    t.play(33, [hand("Closed_Fist", (p -= 0.04), 0.5), hand("Open_Palm", (q -= 0.04), 0.5)]);
    for (let i = 0; i < 8 && t.c.state.rotate === "two"; i++) t.play(33, [hand("Closed_Fist", p, 0.5), hand("Open_Palm", q, 0.5)]);
    expect(t.c.state).toMatchObject({ rotate: "none", spinning: true });
  });

  it("two fists held through the end of a camera vote do not rotate on the result screen", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    const two = fists(0.4, 0.6);
    s.key("v");
    for (let k = 0; k < 2000 && s.c.state.vote?.phase !== "result"; k++) s.live(33, two);
    expect(s.c.state.vote?.phase).toBe("result");
    s.live(RESULT_GUARD_MS - 100, two); // 결과 직후 1.5초는 twoFist도 받지 않는다(그 뒤에는 래치로 다시 나지 않는다)
    expect(s.c.state.rotate).toBe("none");
    expect(s.c.state.vote?.phase).toBe("result");
  });

  // ----- 계약 13.8: 펼친 화면 확대(가리키는 곳 기준). 회전은 계속 막는다.
  /** 스페이스로 펼치고 정면 복귀를 끝낸다. */
  const enterSpread = (s: S) => {
    s.key(" ");
    expect(s.c.state.mode).toBe("spread");
    s.render(1);
  };

  it("spread two fists zoom anchored at the hands", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    enterSpread(s);
    s.frames(6, fists(0.7, 0.78)); // 화면 0.25·0.15: 왼쪽(1위 쪽), 중점 0.2(ndc −0.6), 거리 0.1
    expect(s.c.state).toMatchObject({ mode: "spread", rotate: "two", lifted: null });
    s.frame(fists(0.68, 0.8)); // 화면 0.275·0.125: 중점 그대로, 거리 0.15 → 1.5배
    s.render();
    expect(s.zoom()).toBeCloseTo(1.5, 9);
    expect(s.pan()).toBeCloseTo(-0.6 + 0.6 / 1.5, 9); // 두 손 중점 아래 장면이 그대로: panX −0.2 < 0
    expect(s.yaw()).toBe(0);
    s.frame(fists(0.6, 0.72)); // 함께 옆으로(중점 0.2 → 0.3), 거리 그대로: 돌지도 확대되지도 않는다
    s.render();
    expect(s.yaw()).toBe(0);
    expect(s.zoom()).toBeCloseTo(1.5, 9);
    expect(s.pan()).toBeCloseTo(-0.2, 9);
  });

  it("spread wheel zoom anchored at pointer", async () => {
    let under: string | null = null;
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    enterSpread(s);
    s.c.pointer.move({ x: 0.05, y: 0.5 }); // 왼쪽 끝: ndc −0.9
    s.c.pointer.wheel(-100);
    s.render();
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    expect(s.pan()).toBeCloseTo(-0.9 + 0.9 / 1.1, 9);
    expect(s.yaw()).toBe(0);
    s.c.pointer.wheel(-100); // 같은 자리에서 한 칸 더: 기준점 아래가 계속 그대로
    s.render();
    expect(s.zoom()).toBeCloseTo(1.21, 9);
    expect(s.pan()).toBeCloseTo(-0.9 + 0.9 / 1.21, 9);
    const z = s.zoom();
    const p = s.pan();
    // 든 구가 있으면 휠은 확대하지 않는다
    under = "종로구";
    s.c.pointer.move({ x: 0.1, y: 0.5 });
    s.c.pointer.down();
    expect(s.c.state).toMatchObject({ mode: "spread", lifted: "종로구" });
    s.c.pointer.wheel(-300);
    s.render();
    expect(s.zoom()).toBe(z);
    expect(s.pan()).toBe(p);
  });

  it("spread wheel zoom anchors at the wheel event position, not the last pointer move", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    enterSpread(s);
    s.c.pointer.move({ x: 0.9, y: 0.5 }); // 마지막 pointermove는 오른쪽(ndc 0.8)
    s.c.pointer.wheel(-100, 0, { x: 0.05, y: 0.5 }); // 휠은 왼쪽 끝(ndc −0.9)에서
    s.render();
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    expect(s.pan()).toBeCloseTo(-0.9 + 0.9 / 1.1, 9);
    // 포인터가 나간 뒤(마지막 점 없음)에도 휠 자리를 기준으로
    s.c.pointer.leave();
    s.c.pointer.wheel(-100, 0, { x: 0.05, y: 0.5 });
    s.render();
    expect(s.zoom()).toBeCloseTo(1.21, 9);
    expect(s.pan()).toBeCloseTo(-0.9 + 0.9 / 1.21, 9);
    // 지도는 휠 자리가 왼쪽 끝이어도 가운데 기준(panX 0)
    s.key(" ");
    s.render(1);
    expect(s.c.state.mode).toBe("map");
    s.c.pointer.wheel(-100, 0, { x: 0.05, y: 0.5 });
    s.render();
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    expect(s.pan()).toBe(0);
  });

  it("merge: spread wheel zoom/pan under a still mouse re-picks the hover there (13.8 + M-1)", async () => {
    let under: string | null = "종로구";
    const s = setup({ pick: () => under });
    await s.c.start("mouse");
    enterSpread(s);
    s.c.pointer.move({ x: 0.05, y: 0.5 });
    expect(s.c.state.hover).toBe("종로구");
    under = "중구"; // 확대·옆 이동하면 같은 자리 아래 막대가 바뀐다
    s.c.pointer.wheel(-100, 0, { x: 0.05, y: 0.5 });
    s.render();
    expect(s.pan()).toBeCloseTo(-0.9 + 0.9 / 1.1, 9);
    expect(s.c.state.hover).toBe("중구");
  });

  it("stagePoint maps a wheel event like the pointer path (element-relative 0..1, no mirror for the mouse)", () => {
    const el = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 400 }) };
    expect(stagePoint(el, { clientX: 140, clientY: 250 })).toEqual({ x: 0.05, y: 0.5 });
    expect(stagePoint(el, { clientX: 900, clientY: 50 })).toEqual({ x: 1, y: 0 });
    expect(stagePoint({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }, { clientX: 1, clientY: 1 })).toBeNull();
    expect(stagePoint(el, { clientX: Number.NaN, clientY: 250 })).toBeNull(); // attachPointer의 pointOf처럼
  });

  it("a grab during the reset finishes the reset first", async () => {
    // 손: 지도를 돌려 놓고 펼친 뒤, 정면 복귀 0.25초에 두 주먹 → 반쯤 돌아온 각도가 잠기지 않고 정면(0)
    const h = setup({ pick: () => null });
    await h.c.start("hands");
    h.frames(4, [hand("Open_Palm", 0.6, 0.5)]);
    h.frames(6, [hand("Closed_Fist", 0.6, 0.5)]);
    for (let i = 1; i <= 10; i++) h.play(33, [hand("Closed_Fist", 0.6 - i * 0.02, 0.5)]);
    h.play(500, [hand("Closed_Fist", 0.4, 0.5)]);
    h.play(300, [hand("Open_Palm", 0.4, 0.5)]);
    expect(h.c.state).toMatchObject({ rotate: "none", spinning: false });
    expect(h.yaw()).toBeGreaterThan(Math.PI / 4 - 0.02);
    h.key(" ");
    expect(h.c.state.mode).toBe("spread");
    h.render(0.25);
    expect(h.yaw()).toBeGreaterThan(0.05); // 반쯤 돌아온 자세
    h.frames(6, fists(0.4, 0.52)); // 편 손(0.4)을 그 자리에서 쥐고 둘째 손도 쥔다(주 손 그대로)
    expect(h.c.state).toMatchObject({ mode: "spread", rotate: "two" });
    h.render();
    expect(h.yaw()).toBe(0);
    expect(h.zoom()).toBe(1);
    expect(h.pan()).toBe(0);
    h.render(1);
    expect(h.yaw()).toBe(0);

    // 마우스: 펼친 화면 왼쪽에서 확대하고 나간 뒤 0.2초에 빈 지도를 누르면 가운데·1배에서 잡는다(panX가 지도에 남지 않음)
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    enterSpread(s);
    s.c.pointer.move({ x: 0.05, y: 0.5 });
    s.c.pointer.wheel(-300);
    s.render();
    expect(s.pan()).toBeLessThan(-0.1);
    s.key(" ");
    expect(s.c.state.mode).toBe("map");
    s.render(0.2);
    expect(s.pan()).toBeLessThan(0);
    s.c.pointer.down();
    expect(s.c.state).toMatchObject({ mode: "map", rotate: "one" });
    s.render();
    expect(s.zoom()).toBe(1);
    expect(s.pan()).toBe(0);
    expect(s.yaw()).toBe(0);
    s.c.pointer.wheel(-100); // 지도 확대는 다시 가운데 기준, panX 0 그대로
    s.render();
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    expect(s.pan()).toBe(0);
  });

  it("map zoom keeps panX 0", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    s.c.pointer.move({ x: 0.05, y: 0.5 }); // 포인터가 왼쪽 끝이어도 지도는 가운데 기준
    s.c.pointer.wheel(-300);
    s.render();
    expect(s.zoom()).toBeCloseTo(1.331, 9);
    expect(s.pan()).toBe(0);
    // 두 주먹(왼쪽)도 가운데 기준: 중점 이동은 회전이다
    const h = setup({ pick: () => null });
    await h.c.start("hands");
    h.frames(6, fists(0.7, 0.78));
    expect(h.c.state).toMatchObject({ mode: "map", rotate: "two" });
    h.frame(fists(0.68, 0.8));
    h.render();
    expect(h.zoom()).toBeCloseTo(1.5, 9);
    expect(h.pan()).toBe(0);
  });

  it("leaving spread resets zoom and pan", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    enterSpread(s);
    s.c.pointer.move({ x: 0.1, y: 0.5 });
    s.c.pointer.wheel(-300);
    s.render();
    const p0 = s.pan()!;
    expect(s.zoom()).toBeCloseTo(1.331, 9);
    expect(p0).toBeLessThan(0);
    s.key(" ");
    expect(s.c.state.mode).toBe("map");
    s.render(0.3); // 부드럽게 가운데·1배로
    expect(s.pan()).toBeGreaterThan(p0);
    expect(s.pan()).toBeLessThan(0);
    s.render(0.4);
    expect(s.zoom()).toBe(1);
    expect(s.pan()).toBe(0);
    s.c.pointer.wheel(-100); // 지도에서는 다시 가운데 기준
    s.render();
    expect(s.zoom()).toBeCloseTo(1.1, 9);
    expect(s.pan()).toBe(0);

    // 두 주먹으로 확대해 잡은 채 브이(전체 보기)로 나가도 풀린다. 움직임 줄이기: 즉시
    const h = setup({ pick: () => null, extra: { reducedMotion: true } });
    await h.c.start("hands");
    enterSpread(h);
    h.frames(6, fists(0.7, 0.78));
    h.frame(fists(0.68, 0.8));
    h.render();
    expect(h.pan()).toBeLessThan(0);
    h.key("Escape");
    expect(h.c.state).toMatchObject({ mode: "map", rotate: "none" });
    h.render(0.001);
    expect(h.zoom()).toBe(1);
    expect(h.pan()).toBe(0);
  });

  it("big screen message carries panX", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("mouse");
    enterSpread(s);
    s.glide(1000);
    s.wire.length = 0;
    const sent = () => s.wire.filter((w) => w.msg.type === "stage").map((w) => w.msg as StageMessage);
    s.c.pointer.move({ x: 0.05, y: 0.5 });
    s.c.pointer.wheel(-100);
    s.glide(16);
    const m = sent().at(-1)!;
    expect(m).toMatchObject({ mode: "spread", lifted: null, yaw: 0, zoom: s.zoom(), panX: s.pan() });
    expect(m.panX).toBeCloseTo(-0.9 + 0.9 / 1.1, 9);
    expect(Object.keys(m).every((k) => ALLOWED_KEYS.stage.includes(k))).toBe(true);
    // 하트비트에도 실린다
    s.wire.length = 0;
    s.clock.advance(HEARTBEAT_MS);
    expect(sent().at(-1)).toMatchObject({ zoom: s.zoom(), panX: s.pan() });
    // 나가면 가운데로 돌아간 값까지 보낸다
    s.key(" ");
    s.glide(1000);
    expect(sent().at(-1)).toMatchObject({ mode: "map", yaw: 0, zoom: 1, panX: 0 });
    await flush();
    expect(s.c.publishFailed).toBe(false); // 모의 채널(toWire)이 모두 받아들였다
  });

  it("no rotation in spread from one fist or flick", async () => {
    const s = setup({ pick: () => null });
    await s.c.start("hands");
    enterSpread(s);
    s.frames(4, [hand("Open_Palm", 0.6, 0.5)]);
    s.frames(6, [hand("Closed_Fist", 0.6, 0.5)]); // 빈 곳 한 손 주먹: 펼친 화면에서는 무시
    expect(s.c.state).toMatchObject({ mode: "spread", rotate: "none", lifted: null });
    let x = 0.6;
    for (let i = 0; i < 6; i++) s.play(33, [hand("Closed_Fist", (x -= 0.04), 0.5)]);
    for (let i = 0; i < 8; i++) s.play(33, [hand("Open_Palm", (x -= 0.04), 0.5)]); // 휙 놓기
    s.play(500, [hand("Open_Palm", x, 0.5)]);
    expect(s.c.state).toMatchObject({ mode: "spread", rotate: "none", spinning: false });
    expect(s.yaw()).toBe(0);

    // 두 주먹 휙: 함께 밀다 끝에서 한 손을 펴도(지도라면 관성) 돌지 않는다
    const t = setup({ pick: () => null });
    await t.c.start("hands");
    enterSpread(t);
    let p = 0.6;
    let q = 0.8;
    t.frames(6, fists(p, q));
    expect(t.c.state).toMatchObject({ mode: "spread", rotate: "two" });
    for (let i = 0; i < 6; i++) t.play(33, fists((p -= 0.04), (q -= 0.04)));
    expect(t.yaw()).toBe(0);
    t.play(33, [hand("Closed_Fist", (p -= 0.04), 0.5), hand("Open_Palm", (q -= 0.04), 0.5)]);
    for (let i = 0; i < 8 && t.c.state.rotate === "two"; i++) t.play(33, [hand("Closed_Fist", p, 0.5), hand("Open_Palm", q, 0.5)]);
    expect(t.c.state).toMatchObject({ mode: "spread", rotate: "none", spinning: false });
    t.render(0.5);
    expect(t.yaw()).toBe(0);

    // 마우스: 빈 곳 빠른 끌기도 돌리지 않는다
    const m = setup({ pick: () => null });
    await m.c.start("mouse");
    enterSpread(m);
    m.c.pointer.move({ x: 0.2, y: 0.5 });
    m.c.pointer.down();
    for (let i = 1; i <= 6; i++) { m.c.pointer.move({ x: 0.2 + i * 0.05, y: 0.5 }); m.glide(16); }
    m.c.pointer.up();
    m.glide(500);
    expect(m.c.state).toMatchObject({ mode: "spread", rotate: "none", spinning: false });
    expect(m.yaw()).toBe(0);
  });
});
