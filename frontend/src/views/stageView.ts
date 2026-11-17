// #/stage: 발표 화면의 3D 서울을 손짓·마우스·키로 움직이고 미리 만든 해설을 튼다 (CONTRACTS-stage 9절, 설계 5.1~5.4).
// 조립 규칙은 createStageController(DOM 없음, 테스트 대상)에 있고, mountStageView는 DOM을 잇는 얇은 껍데기다.
// 이 파일은 main.ts가 #/stage에 들어갈 때만 동적으로 읽는다(관객 번들에 무대·MediaPipe 코드가 들어가지 않게).
import "../stage/ui/vote.css";
import "../stage/ui/hud.css";
import "../stage/ui/overlay.css";
import "../stage/stage.css";
import { WebGLRenderer, type Camera } from "three";
import { GU_ORDER } from "../data/gu";
import type { DataIndex, GuData, Metric, Stat } from "../data/types";
import type { ConnStatus, RealtimeClient, StateMessage } from "../realtime/types";
import type { SeoulScene } from "../scene/seoulScene";
import { NARRATION_IDS, diffEffects } from "../stage/effects";
import { createCursorMapper, mapToScreen, palmCenter, toNdc, type CursorMapper } from "../stage/hands/cursor";
import { DEFAULT_GESTURE_CONFIG, createGestureMachine, type GestureMachine } from "../stage/hands/gestureMachine";
import { MODEL_PATH, startHandSource, type HandSource, type HandSourceError } from "../stage/hands/recognizer";
import { createVoteCounter, type VoteCounter } from "../stage/hands/voteCounter";
import { attachPointer, keyToAction, type PointerHandlers, type UiAction } from "../stage/keys";
import { createNarrator, loadManifest, type AudioLike, type NarrationManifest, type Narrator } from "../stage/narrator";
import { toStageMessage, toVoteMessage } from "../stage/net/messages";
import type { StageChannel } from "../stage/net/stageChannel";
import { createRotator, type Rotator } from "../stage/rotate";
import { createStageRenderer } from "../stage/stageRenderer";
import { defaultCandidates, initialStageState, parseVoteParam, reduceStage } from "../stage/stageState";
import {
  VOTE_MAX, VOTE_TIMING, type Effect, type GestureEvent, type GestureOutput, type HandFrame, type HandObs, type InputMode, type Point, type StageEvent, type StageMode, type StageState,
} from "../stage/types";
import { renderCaption, renderHints, renderStart, renderTopBar } from "../stage/ui/hud";
import { cursorClass, drawSkeleton, nextPreviewMode, renderDiag, type PreviewMode } from "../stage/ui/overlay";
import { renderVotePanel } from "../stage/ui/votePanel";
import { fmtMonth } from "../ui/format";
import type { MountView, ViewContext } from "./types";

/** 투표 진행(voteTick)·패널 초 표시·진단·인식 실패 감시 간격 */
export const VOTE_TICK_MS = 250;
/** 늦게 들어온 관객을 위해 state·stage를 다시 보내는 간격(본체 호스트와 같다) */
export const HEARTBEAT_MS = 10_000;
/** HandSource.errors(연속 인식 실패)가 이 값을 넘으면(30fps로 약 2초) 마우스로 바꾼다. */
export const HAND_ERROR_LIMIT = 60;
/** 손 모드 준비(카메라 권한·모델·wasm·GPU)를 이만큼 기다리고, 넘으면 마우스로 진행한다. */
export const HAND_START_TIMEOUT_MS = 20_000;
/** 손 모드에서 인식 프레임이 이만큼 오지 않으면 카메라 영상이 끊긴 것으로 보고 마우스로 바꾼다. */
export const HAND_STALL_MS = 1500;
/** 펼치기는 지표와 무관하게 늘 ㎡당 가격순으로 줄 세운다(해설 "㎡당 가격순 … 왼쪽이 가장 비쌉니다"가 늘 참). 막대 색은 현재 지표. */
export const SPREAD_METRIC: Metric = "price";
/** 투표 결과가 뜬 뒤 이 시간 동안은 grab·spread·victory를 받지 않는다(투표 내내 쥐고 있던 주먹·키가 결과를 지우지 않게). */
export const RESULT_GUARD_MS = 1500;
/** 주 손이 이 시간 이상 안 보여야 진짜로 놓친 것. gestureMachine이 추적 손을 기억하는 시간과 같다. */
const CURSOR_GAP_MS = DEFAULT_GESTURE_CONFIG.releaseAfterMs;
/** 큰 화면에 각도·배율을 보내는 최소 간격(초당 최대 5회, CONTRACTS-stage 13.6). 멈추면 마지막 값을 한 번 더 보낸다. */
export const VIEW_PUBLISH_MS = 200;
/** 휠 deltaY(픽셀 환산)를 이만큼 모을 때마다 확대 한 단계. 트랙패드의 잦은 작은 값이 한 번에 0.7~1.6을 넘지 않게(Ruling). */
export const WHEEL_STEP_PX = 100;
/**
 * 두 손바닥 중심이 이보다 가까우면(화면 정규 좌표) 한 손이 두 번 잡힌 것으로 보고 두 손 회전에 쓰지 않는다.
 * 맞붙인 두 주먹도 중심은 주먹 하나 폭(약 0.1)만큼 떨어진다. 거의 0인 거리를 확대 기준으로 잡으면 진짜 둘째 손이 들어오는 순간 1.6배로 튄다.
 */
const TWO_HAND_MIN_DIST = 0.04;
/** WheelEvent.deltaMode 1(줄)·2(페이지)를 픽셀로 바꾸는 배수. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

const HAND_FAIL: Record<HandSourceError, string> = {
  denied: "카메라 권한이 거부되어 마우스로 진행합니다",
  "no-camera": "카메라를 찾지 못해 마우스로 진행합니다",
  "model-missing": "동작 인식 모델이 없어 마우스로 진행합니다",
  "wasm-failed": "동작 인식을 시작하지 못해 마우스로 진행합니다",
  unsupported: "이 브라우저는 동작 인식을 지원하지 않아 마우스로 진행합니다",
};
const HAND_ERRORS_TOAST = "손 인식이 계속 실패해 마우스로 바꿨습니다. G로 다시 시도할 수 있어요";
const HAND_SLOW_TOAST = "동작 인식 준비가 늦어 마우스로 진행합니다 · G로 다시 시도할 수 있어요";
const HAND_STALL_TOAST = "카메라 영상이 끊겨 마우스로 바꿨습니다 · G로 다시 시도할 수 있어요";
const AUDIO_BLOCKED_TOAST = "소리가 막혔습니다 · 화면을 한 번 눌러 주세요";
// "마우스로 계속"은 start("mouse")로 이어진다: 준비를 기다리지 않고 마우스로 바로 시작한다.
const STARTING_HTML = `<section class="stage-start"><p class="start-note" role="status">카메라와 동작 인식을 준비하는 중</p>` +
  `<button type="button" class="start-sub" data-start="mouse">마우스로 계속</button></section>`;

// ---------- 순수 도우미 ----------

/**
 * URL 후보(유효 이름, 앞 세 개)를 먼저, 모자라면 기본 후보로, 그래도 모자라면 GU_ORDER로 채운다.
 * 기본 후보는 스펙대로 현재 지표와 무관하게 "현재 월 ㎡당 중앙값 1위·13위·25위"(비싼 곳·중간·싼 곳)다.
 */
export function voteCandidates(hash: string, summary: Record<string, Stat>): [string, string, string] {
  const picked = (parseVoteParam(hash, GU_ORDER) ?? []).slice(0, 3);
  for (const g of [...defaultCandidates(summary, "price", GU_ORDER), ...GU_ORDER]) {
    if (picked.length >= 3) break;
    if (!picked.includes(g)) picked.push(g);
  }
  return [picked[0]!, picked[1]!, picked[2]!];
}

/** 투표 안내 단계는 안내 클립이 끝나고 이만큼 더 기다린다(마지막 말을 듣고 손을 들 틈). */
export const VOTE_PROMPT_PAD_MS = 300;

/**
 * 투표 안내 단계 길이(voteStart의 promptMs·introMs). 후보마다 안내 클립 길이 + 300ms(최소 VOTE_TIMING.promptMs),
 * 첫 후보에는 소개 클립 길이를 더한다(소개 뒤에 첫 안내가 나오므로). 클립을 모르면 기본값, 소개를 모르면 더하지 않는다.
 * clipMs는 narrator.clipMs(manifest의 ms, 없으면 자막 글자 수 × 150ms).
 */
export function voteTiming(candidates: readonly [string, string, string], clipMs: (id: string) => number | null): { promptMs: [number, number, number]; introMs?: number } {
  const prompt = (gu: string): number => {
    const ms = clipMs(NARRATION_IDS.votePrompt(gu));
    return ms === null ? VOTE_TIMING.promptMs : Math.max(VOTE_TIMING.promptMs, ms + VOTE_PROMPT_PAD_MS);
  };
  const intro = clipMs(NARRATION_IDS.voteIntro);
  return { promptMs: [prompt(candidates[0]), prompt(candidates[1]), prompt(candidates[2])], ...(intro !== null ? { introMs: intro } : {}) };
}

/**
 * 한글 입력 상태에서는 V가 "ㅍ"로, Windows 한국어 IME에서는 "Process"로 들어온다.
 * 그럴 때는 물리 키(code)로 바꾼다: 글자 키는 영문 소문자, 숫자 키는 숫자, 스페이스는 " ".
 */
export function normalizeKey(key: string, code: string | undefined): string {
  if (!code || !(key === "Process" || /^[ㄱ-ㅣ]$/.test(key))) return key;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  if (code === "Space") return " ";
  return key;
}

/** WheelEvent의 deltaY를 픽셀 단위로(deltaMode 0 픽셀, 1 줄 ×16, 2 페이지 ×800). */
export function wheelPixels(deltaY: number, deltaMode = 0): number {
  return deltaY * (deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? WHEEL_PAGE_PX : 1);
}

/**
 * 이벤트의 클라이언트 좌표 → 무대 화면 좌표(요소 기준 0..1). attachPointer의 pointermove와 같은 환산이다
 * (마우스 좌표는 거울 보정하지 않는다: 거울은 손 영상에만). 요소 크기가 0이면 null.
 */
export function stagePoint(
  el: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } },
  e: { clientX: number; clientY: number },
): Point | null {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

/**
 * 한 인식 프레임의 이벤트 순서. grab과 twoFist가 같은 프레임에 나면 twoFist를 먼저 보낸다:
 * 리듀서가 돌리는 중의 grab을 무시하므로 두 주먹이 구 위에서 한꺼번에 쥐어져도 구를 들었다 내리지(해설·깜빡임) 않는다.
 */
export function orderGestureEvents(events: readonly GestureEvent[]): GestureEvent[] {
  const g = events.findIndex((e) => e.type === "grab");
  const t = events.findIndex((e) => e.type === "twoFist");
  if (g < 0 || t < 0 || t < g) return [...events];
  const out = events.filter((_, i) => i !== t);
  out.splice(g, 0, events[t]!);
  return out;
}

/** 상단 연결 표시: 두 채널(본체 state, 무대 stage)이 모두 열려야 "실시간 연결". */
export function combineConn(a: ConnStatus, b: ConnStatus): ConnStatus {
  if (a === "open" && b === "open") return "open";
  if ([a, b].some((s) => s === "error" || s === "closed")) return "error";
  return "connecting";
}

// ---------- 컨트롤러 ----------

export type UiPart = "top" | "hints" | "caption" | "vote" | "live" | "diag" | "start";

/** 컨트롤러가 화면에 내보내는 것. html이 null이면 그 부분을 숨긴다. */
export interface StageUi {
  set(part: UiPart, html: string | null): void;
  cursor(p: Point | null, cls: string): void;                     // p: 화면 정규 좌표
  preview(mode: PreviewMode, video: HTMLVideoElement | null): void;
  skeleton(frame: HandFrame | null): void;                          // null이면 지움
}

/** group: 회전기가 도는 각도를 수직 축(rotation.y)에 그대로 얹는다(큰 화면도 같은 부호). */
export type StageScene = Pick<SeoulScene, "setOverview" | "focus" | "setHover" | "lift" | "setLayout" | "pick"> & { readonly group: { rotation: { y: number } } };
/** onFrame: 렌더 루프 한 번마다(dt 초). 회전기 tick·확대·옆 이동(setPan, 계약 13.8)을 여기서 적용한다. */
export interface StageCamera {
  camera: Camera; setMode(mode: StageMode, instant?: boolean): void; setZoom(z: number): void; setPan(p: number): void;
  onFrame(cb: (dt: number) => void): () => void;
}
export type StartResult = { ok: true; source: HandSource } | { ok: false; reason: HandSourceError };
export interface StageClock { now(): number; every(ms: number, fn: () => void): () => void; }

export interface StageControllerDeps {
  index: DataIndex;
  month: string;
  /** 시작 지표(호스트에서 고른 값을 이어받는다). 없으면 "price". */
  metric?: Metric;
  loadGu(month: string, gu: string): Promise<GuData>;
  realtime: Pick<RealtimeClient, "publish" | "status" | "onStatus">;
  stageChannel: Pick<StageChannel, "publish" | "status" | "onStatus">;
  scene: StageScene;
  renderer: StageCamera | null;                                     // WebGL이 없으면 null(pick 없음)
  narrator: Narrator;
  ui: StageUi;
  toast(message: string): void;
  startHands(): Promise<StartResult>;
  hash(): string;
  modelReady?(): Promise<boolean>;
  /**
   * 페이지가 보이지 않는가(document.hidden). 숨은 탭에서는 프레임이 멈추고 타이머도 늦춰지므로(길면 1분에 한 번)
   * 정지 감지·손 준비 시간 제한을 쉬고, 다시 보이게 된 때부터 새로 잰다.
   */
  hidden?(): boolean;
  /** 페이지 보임이 바뀔 때 cb를 부른다(visibilitychange). 숨은 동안 틱이 한 번도 돌지 않았어도 돌아온 순간 기준을 맞춘다. */
  onVisibilityChange?(cb: () => void): () => void;
  /** 본체 state를 발행할 때마다(호스트 화면과 store를 맞추는 용도) */
  onState?(msg: StateMessage): void;
  clock?: StageClock;
  gestures?: GestureMachine;
  cursor?: CursorMapper;
  counter?: VoteCounter;
  rotator?: Rotator;
  /** 움직임 줄이기: 정면 복귀(rotate.reset)를 보간 없이 즉시. */
  reducedMotion?: boolean;
}

export interface KeyLike { key: string; code?: string; repeat?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; }
/** 투표 패널 버튼의 data 속성(이벤트 위임) */
export interface PanelTarget { set?: string | null; confirm?: boolean; method?: string | null; }
/**
 * 무대 포인터: 휠은 deltaMode(0 픽셀·1 줄·2 페이지)와 휠 이벤트 자리(at, stagePoint)까지 받는다
 * (attachPointer는 deltaY만 넘기므로 DOM 껍데기가 직접 잇는다). at이 없으면 마지막 포인터 자리.
 */
export interface StagePointer extends PointerHandlers { wheel(deltaY: number, deltaMode?: number, at?: Point | null): void; }

export interface StageController {
  readonly state: StageState;
  readonly publishFailed: boolean;
  readonly started: boolean;
  /** "무대 시작"/"마우스로 시작" 클릭 안에서 부른다(오디오 잠금 해제가 동기로 먼저 일어난다). */
  start(mode: InputMode): Promise<void>;
  /** 처리했으면 true(호출자가 preventDefault). */
  key(e: KeyLike): boolean;
  readonly pointer: StagePointer;
  panel(t: PanelTarget): void;
  dispose(): void;
}

const systemClock: StageClock = {
  now: () => Date.now(),
  every(ms, fn) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

/** 이벤트가 어디서 왔나: 회전기에 넘길 점(손 커서·마우스)과 시간 기준(f.t·clock)이 갈린다. */
type InputSrc = "hand" | "mouse" | "key";

/** 손 인식 준비를 기다린 결과: 준비 결과, 시간 초과, 또는 "마우스로 계속"·화면 떠남으로 그만 기다림. */
type HandWait = { kind: "result"; r: StartResult } | { kind: "timeout" } | { kind: "skip" };

function stopSource(src: HandSource): void {
  try { src.stop(); } catch (err) { console.warn("[stage] 인식기 정지 실패", err); }
}

export function createStageController(deps: StageControllerDeps): StageController {
  const clock = deps.clock ?? systemClock;
  const gestures = deps.gestures ?? createGestureMachine();
  const cursor = deps.cursor ?? createCursorMapper();
  const counter = deps.counter ?? createVoteCounter();
  const rotator = deps.rotator ?? createRotator();
  const reducedMotion = deps.reducedMotion ?? false;
  const { scene, renderer, narrator, ui, index } = deps;

  let state: StageState = { ...initialStageState(deps.month, "mouse"), metric: deps.metric ?? "price" };
  let phase: "idle" | "starting" | "running" | "disposed" = "idle";
  let modelReady = true;
  const failed = { state: false, stage: false };
  let reviewRow = 0;
  let hintsOn = true;
  let diagOn = false;
  let preview: PreviewMode = "video";
  let source: HandSource | null = null;
  let offFrame: (() => void) | null = null;
  let acquiring = false;
  let skipHandWait: (() => void) | null = null; // 손 준비 대기 중이면 그만 기다리게 하는 함수
  let frameAt = 0;                               // 마지막 인식 프레임을 받은 시각(clock). 정지 감지용
  let handWaitFrom = 0;                          // 손 준비를 기다리기 시작한 시각(clock). 시작 시간 제한용
  let wasHidden = false;                         // 마지막으로 본 페이지 숨김 여부
  let liveHands = 0;
  let gesture = { name: "None", score: 0 };
  let handPoint: Point | null = null;
  let handSeenAt: number | null = null;
  let handLost = true;
  let mousePoint: Point | null = null;
  let mouseDown = false;
  let resultAt = -Infinity; // 투표 결과 화면에 들어온 시각(clock)
  let focusToken = 0;
  // ----- 회전(계약 13): 잡은 쪽, 미룬 잡기, 이번 프레임의 두 손바닥 점, 관성 표시, 휠 누적, 큰 화면에 보낸 각도
  let rotBy: "hand" | "mouse" | null = null;       // 지금 잡고 있는 입력(점·시간 기준이 이쪽을 따른다)
  let pendingGrab: "one" | "two" | null = null;    // 잡을 점이 아직 없어 첫 점이 오면 잡는다
  let frameT = 0;                                  // 마지막 인식 프레임의 f.t(손 회전의 시간 기준)
  let openT: number | null = null;                 // 손으로 돌리는 중 추적 손이 처음 주먹이 아니게 된 프레임의 f.t(휙 속도를 손을 편 순간으로 잰다)
  let twoPts: [Point, Point] | null = null;        // 이번 프레임 주 손·둘째 손 손바닥(화면 좌표). 정확히 두 손일 때만
  let spinShown = false;                           // 마지막으로 spinState로 알린 회전기 관성 여부
  let wheelAcc = 0;                                // 모은 휠 픽셀(부호 = 방향)
  let sentView = { yaw: 0, zoom: 1, panX: 0 };     // 마지막 StageMessage에 실은 각도·배율·옆 이동
  let sentAt = -Infinity;                          // 그때 시각(clock)
  const guCache = new Map<string, GuData>();                                   // 받은 구 자료(월|구)
  const guLoading = new Map<string, Promise<GuData | null>>();                  // 받는 중인 요청(같은 구를 두 번 받지 않게)
  const shown = new Map<UiPart, string | null>();
  const stops: (() => void)[] = [];

  const summary = () => index.summary[state.month] ?? {};
  const publishFailed = () => failed.state || failed.stage;

  // ----- 그리기: 바뀐 부분만 내보낸다(투표 패널은 상태가 바뀌거나 남은 초가 바뀔 때만 다시 그려진다).
  const setPart = (part: UiPart, html: string | null) => {
    if (shown.has(part) && shown.get(part) === html) return;
    shown.set(part, html);
    ui.set(part, html);
  };
  const renderTop = () => setPart("top", renderTopBar(state, {
    conn: combineConn(deps.realtime.status, deps.stageChannel.status), publishFailed: publishFailed(), monthLabel: fmtMonth(state.month),
  }));
  const renderHintsPart = () => setPart("hints", hintsOn ? renderHints(state) : null);
  const renderVote = () => {
    const v = state.vote;
    setPart("vote", v ? renderVotePanel(v, { reviewRow, now: clock.now() }) : null);
    // 패널에는 실시간 손 개수 칸이 없다. 카메라로 세는 동안만 따로 한 줄(집계값 counts는 리듀서 상태 그대로).
    const live = v !== null && v.phase === "counting" && v.method === "camera";
    setPart("live", live ? `<p class="vote-live">카메라: 지금 ${liveHands}손</p>` : null);
  };
  const renderDiagPart = () => setPart("diag", diagOn ? renderDiag({
    fps: source?.fps ?? 0, hands: liveHands, gesture: gesture.name, score: gesture.score,
    cursor: state.input === "hands" ? (handLost ? null : handPoint) : mousePoint,
    loadMs: source?.loadMs ?? null, delegate: source?.delegate ?? null, input: state.input,
  }) : null);
  const renderStartPart = () => setPart("start",
    phase === "idle" ? renderStart({ modelReady, reason: null }) : phase === "starting" ? STARTING_HTML : null);
  const renderCursor = () => {
    const visible = state.input === "hands" && source !== null && handPoint !== null && !handLost;
    ui.cursor(handPoint, cursorClass({ visible, fist: gestures.fist, hovering: state.hover !== null }));
  };
  const renderAll = () => { renderTop(); renderHintsPart(); renderVote(); renderDiagPart(); renderStartPart(); renderCursor(); };

  // ----- 발행: 채널마다 실패를 따로 기억한다(한쪽 성공이 다른 쪽 실패를 지우지 않게).
  const setFailed = (ch: keyof typeof failed, v: boolean) => {
    if (phase === "disposed" || failed[ch] === v) return;
    failed[ch] = v;
    renderTop();
  };
  const track = (ch: keyof typeof failed, send: () => Promise<void>) => {
    let p: Promise<void>;
    try { p = send(); } catch (err) { p = Promise.reject(err); }
    p.then(() => setFailed(ch, false), (err: unknown) => {
      if (!failed[ch]) console.warn(`[stage] ${ch} 발행 실패`, err);
      setFailed(ch, true);
    });
  };
  const publishState = () => {
    const msg: StateMessage = { v: 1, type: "state", month: state.month, gu: state.focus, metric: state.metric, ts: clock.now() };
    deps.onState?.(msg);
    track("state", () => deps.realtime.publish(msg));
  };
  /** 모든 StageMessage에 지금 각도·배율·옆 이동을 싣는다(큰 화면은 없으면 정면 0·1·가운데로 돌아가므로 들기·펼치기 메시지에도). */
  const publishStage = () => {
    const { yaw, zoom, panX } = rotator.state;
    sentView = { yaw, zoom, panX };
    sentAt = clock.now();
    const msg = toStageMessage(state, sentAt, sentView);
    track("stage", () => deps.stageChannel.publish(msg));
  };
  /** 각도·배율·옆 이동이 마지막으로 보낸 값과 다르면 VIEW_PUBLISH_MS 간격으로 보낸다(처음 바뀐 렌더에 바로, 멈추면 남은 값을 한 번). */
  const publishView = () => {
    if (phase !== "running") return;
    const { yaw, zoom, panX } = rotator.state;
    if (yaw === sentView.yaw && zoom === sentView.zoom && panX === sentView.panX) return;
    if (clock.now() - sentAt < VIEW_PUBLISH_MS) return;
    publishStage();
  };
  const publishVote = () => {
    if (!state.vote) return;
    const msg = toVoteMessage(state.vote, clock.now());
    track("stage", () => deps.stageChannel.publish(msg));
  };

  // ----- 씬
  const guKey = (month: string, gu: string) => `${month}|${gu}`;
  /** 구 자료를 받는다(실패하면 null). 받는 중이면 그 요청을 이어 쓰고, 받은 것은 guCache에 둔다. */
  function fetchGu(month: string, gu: string): Promise<GuData | null> {
    const key = guKey(month, gu);
    const loading = guLoading.get(key);
    if (loading) return loading;
    const p = deps.loadGu(month, gu).then(
      (d): GuData | null => d,
      (err: unknown) => { console.warn("[stage] 구 자료를 읽지 못함", err); return null; },
    ).then((d) => {
      guLoading.delete(key);
      if (d) guCache.set(key, d);
      return d;
    });
    guLoading.set(key, p);
    return p;
  }
  /** 곧 focus될 구(들어 올린 구, 투표 후보)의 자료를 미리 받아 둔다. */
  const prefetch = (gu: string) => {
    if (!guCache.has(guKey(state.month, gu))) void fetchGu(state.month, gu);
  };

  function drawFocus(): void {
    const { focus: gu, month } = state;
    const mine = ++focusToken;
    if (gu === null) { scene.focus(null, null, state.metric); return; }
    const cached = guCache.get(guKey(month, gu));
    if (cached) { scene.focus(gu, cached, state.metric); return; }
    // 자료가 아직이면 구부터 바로 올린다: 지도로 돌아오는 같은 차례에 focus가 바뀌어 옛 focus 구의 막대가 다시 자라 보이지 않는다.
    // 막대는 자료가 오면 자란다(실패하면 구만 올라 있다).
    scene.focus(gu, null, state.metric);
    void fetchGu(month, gu).then((d) => {
      if (phase === "disposed" || mine !== focusToken || !d) return;
      scene.focus(gu, d, state.metric);
    });
  }

  /** 잡은 입력의 시간 기준: 손은 인식 프레임 시각(f.t), 마우스는 clock. 회전기 속도 표본이 한 기준으로만 쌓이게. */
  const rotT = () => (rotBy === "hand" ? frameT : clock.now());
  const clearHold = () => { rotBy = null; pendingGrab = null; openT = null; };

  function run(fx: Effect, src: InputSrc): void {
    switch (fx.type) {
      case "rotate.grabOne": {
        // grab은 손 프레임이나 마우스 누르기에서만 온다. 잡는 점: 손이면 손 커서, 마우스면 마지막 포인터 자리.
        rotBy = src === "hand" ? "hand" : "mouse";
        openT = null;
        const at = rotBy === "hand" ? (handLost ? null : handPoint) : mousePoint;
        pendingGrab = at ? null : "one";
        if (at) rotator.grabOne(at, rotT());
        return;
      }
      case "rotate.grabTwo":
        // 주 손·둘째 손이 이번 프레임에 다 있어야 잡는다. 없으면 둘 다 보이는 첫 프레임에 잡는다.
        rotBy = "hand";
        openT = null;
        pendingGrab = twoPts ? null : "two";
        if (twoPts) rotator.grabTwo(twoPts[0], twoPts[1], frameT);
        return;
      case "rotate.release":
        // 손의 "놓기"는 손을 편 순간이다: 놓기 확정(6프레임 뒤)이 아니라 처음 편 프레임까지의 속도로 휙을 잰다(계약 13.2).
        rotator.release(rotBy === "hand" ? (openT ?? frameT) : clock.now());
        clearHold();
        return;
      case "rotate.catch": rotator.catch(); return;
      case "rotate.reset": rotator.reset(reducedMotion); clearHold(); wheelAcc = 0; return;
      case "scene.layout":
        scene.setLayout(fx.mode, summary(), SPREAD_METRIC);
        renderer?.setMode(fx.mode);
        return;
      case "scene.lift":
        scene.lift(fx.gu);
        if (fx.gu !== null) prefetch(fx.gu); // 들고 있는 동안 받아 두면 놓을 때 바로 앉는다
        return;
      case "scene.focus": drawFocus(); return;
      case "scene.hover": scene.setHover(fx.gu); return;
      case "scene.data":
        scene.setOverview(summary(), state.metric);
        if (state.mode === "spread") scene.setLayout("spread", summary(), SPREAD_METRIC); // 새 달이면 다시 줄 세움(지표만 바뀌면 그대로)
        if (state.focus !== null) drawFocus();
        return;
      case "narrate": narrator.say(fx.id, { interrupt: fx.interrupt, protect: fx.protect }); return;
      case "narrate.stop": narrator.stop(); return;
      case "counter.reset": counter.reset(); return;
      case "publish.state": publishState(); return;
      case "publish.stage": publishStage(); return;
      case "publish.vote": publishVote(); return;
    }
  }

  /** 결과 화면에 막 들어왔다: 손짓·포인터·키로 결과를 곧바로 지우지 않는다. */
  const resultGuarded = () => state.vote?.phase === "result" && clock.now() - resultAt < RESULT_GUARD_MS;
  const GUARDED = new Set<StageEvent["type"]>(["grab", "spread", "victory", "twoFist"]);

  /**
   * 회전기가 관성으로 돌기 시작하거나 멈추면 리듀서에 알린다(spinState). 놓은 바로 그 차례(dispatch 끝)와 매 렌더에서 부른다.
   * 리듀서가 "돈다"를 받지 않으면(잡기·펼치기·투표 중) 회전기도 멈춰 둘이 어긋나지 않게 한다.
   */
  function syncSpin(): void {
    const spinning = rotator.state.mode === "spinning";
    if (spinning === spinShown) return;
    spinShown = spinning;
    dispatch({ type: "spinState", spinning });
    if (spinning && !state.spinning) {
      rotator.catch();
      spinShown = false;
    }
  }

  function dispatch(e: StageEvent, src: InputSrc = "key"): void {
    if (phase === "disposed") return;
    if (GUARDED.has(e.type) && resultGuarded()) return;
    const prev = state;
    const next = reduceStage(prev, e);
    if (next === prev) return;
    state = next;
    // 펼친 화면은 확대만(계약 13.8): 회전기를 잠가 끌기·두 주먹·관성이 yaw를 바꾸지 않게. 효과(리셋·잡기)보다 먼저.
    if (prev.mode !== next.mode) rotator.setYawLocked(state.mode === "spread");
    const pv = prev.vote;
    const nv = next.vote;
    if (nv && (!pv || pv.round !== nv.round)) {
      reviewRow = 0;
      for (const g of nv.candidates) prefetch(g); // 결과가 뜨면 승자가 바로 앉게
    }
    if (nv?.phase === "result" && (pv?.phase !== "result" || pv.round !== nv.round)) resultAt = clock.now();
    // effects는 counting에 들어갈 때만 counter.reset을 낸다. counting 중 카메라 방식으로 바뀌면(N·토글·setInput)
    // 그 전에 쌓인 프레임을 버리고 지금부터 센다.
    if (pv && nv && pv.round === nv.round && pv.phase === "counting" && nv.phase === "counting" && pv.method !== "camera" && nv.method === "camera") {
      counter.reset();
    }
    for (const fx of diffEffects(prev, next, e)) run(fx, src); // 원인 이벤트: 돌리기만 한 지도의 브이도 정면 복귀
    syncSpin();
    renderTop();
    renderHintsPart();
    renderVote();
    if (prev.hover !== next.hover || prev.input !== next.input) renderCursor();
  }

  // ----- 입력
  /** 브라우저가 해설 재생을 막았으면 사용자 입력(키·클릭) 처리 안에서 잠금 해제를 다시 시도한다. */
  const retryUnlock = () => {
    if (narrator.blocked) void narrator.unlock().catch(() => {});
  };
  const pickAt = (p: Point): string | null => {
    if (!renderer) return null;
    const n = toNdc(p);
    return scene.pick(n.x, n.y, renderer.camera);
  };
  const hoverTo = (gu: string | null) => { if (gu !== state.hover) dispatch({ type: "hover", gu }); };

  /**
   * 주 손·둘째 손의 손바닥 중심(커서와 같은 거울·가장자리 매핑). 정확히 두 손이 보이고 둘 다 있을 때만:
   * 셋 이상이면 둘째 손이 프레임마다 바뀔 수 있고, 너무 가까우면 한 손이 두 번 잡힌 것이다.
   */
  function twoPalms(f: HandFrame, out: GestureOutput): [Point, Point] | null {
    if (out.handCount !== 2 || out.primary === null || out.secondary === null) return null;
    const a = f.hands[out.primary];
    const b = f.hands[out.secondary];
    if (!a || !b) return null;
    const pa = mapToScreen(palmCenter(a.landmarks));
    const pb = mapToScreen(palmCenter(b.landmarks));
    return Math.hypot(pb.x - pa.x, pb.y - pa.y) < TWO_HAND_MIN_DIST ? null : [pa, pb];
  }

  /**
   * 손으로 잡고 있으면 이번 프레임 점으로 돌린다(한 손: 커서, 두 손: 두 손바닥). 미룬 잡기는 점이 생긴 첫 프레임에.
   * regrab: 커서 손을 다시 잡았거나 주 손이 다른 손으로 바뀐 프레임(커서 필터를 새로 시작한 프레임). 이 점은 앞 점과
   * 이어지지 않으므로 move 대신 grabOne으로 기준만 다시 잡는다(각도 그대로, 튐·가짜 관성 없음).
   */
  function followHands(cur: Point | null, t: number, regrab: boolean): void {
    if (state.rotate === "one" && rotBy === "hand" && cur) {
      if (pendingGrab === "one" || regrab) { pendingGrab = null; openT = null; rotator.grabOne(cur, t); }
      else rotator.move(cur, t);
    } else if (state.rotate === "two" && twoPts) {
      // 두 손이 아닌 프레임(셋째 손·한 손 놓침)은 건너뛴다. 끝내는 것은 twoFistEnd가 맡는다.
      if (pendingGrab === "two") { pendingGrab = null; rotator.grabTwo(twoPts[0], twoPts[1], t); }
      else rotator.moveTwo(twoPts[0], twoPts[1], t);
    }
  }

  /** gestureMachine과 같은 "확실한 주먹"(점수 미달 주먹은 주먹이 아니다). */
  const sureFist = (h: HandObs) => h.gesture === "Closed_Fist" && h.score >= DEFAULT_GESTURE_CONFIG.minScore;
  /**
   * 손으로 돌리는 중 손을 편 첫 프레임을 기억한다(놓기 확정을 낼 비주먹 연속과 같은 기준).
   * 한 손: 추적 손이 주먹이 아니면 기록, 주먹이면 지운다. 안 보이는 프레임은 중립.
   * 두 손: 손이 둘 이상 보이는 프레임에서 "정확히 두 손이 모두 주먹"이 아니면 기록, 맞으면 지운다. 두 손 미만은 중립.
   */
  function trackOpen(f: HandFrame, p: HandObs | undefined): void {
    if (rotBy !== "hand") return;
    if (state.rotate === "one") {
      if (!p) return;
      if (sureFist(p)) openT = null;
      else openT ??= f.t;
    } else if (state.rotate === "two") {
      if (f.hands.length < 2) return;
      if (f.hands.length === 2 && f.hands.every(sureFist)) openT = null;
      else openT ??= f.t;
    }
  }

  function onFrame(f: HandFrame): void {
    frameAt = clock.now(); // 프레임 시각 f.t(performance)와 섞지 않고 clock 한쪽으로만 잰다
    if (phase !== "running") return;
    const v = state.vote;
    const hands = state.input === "hands";
    // 관성 중이면 한 손 주먹이 쿨다운을 기다리지 않는다(휙 놓자마자 쥐어도 잡혀 멈춘다, 계약 13.3).
    const out = hands ? gestures.push(f, { voting: v !== null && v.phase !== "result", spinning: state.spinning }) : null;
    liveHands = out ? out.handCount : Math.min(f.hands.length, VOTE_MAX);
    // 카메라로 세는 동안은 손이 0개인 프레임까지 모두 넣는다(0이 500ms 이어지면 0표).
    if (v && v.phase === "counting" && v.method === "camera") counter.push(f.t, liveHands);
    if (preview !== "hidden") ui.skeleton(f);
    if (!out) return;

    frameT = f.t;
    const p = out.primary === null ? undefined : f.hands[out.primary];
    gesture = p ? { name: p.gesture, score: p.score } : { name: "None", score: 0 };
    // 진짜로 놓쳤다가 다시 잡으면 필터를 새로 시작한다. gestureMachine은 간격이 releaseAfterMs에 닿는 프레임에
    // 곧바로 다른(가장 큰) 손을 주 손으로 잡으므로, 그 경우도 간격으로 판정한다. 이 프레임은 회전 기준도 다시 잡는다.
    const regrab = p !== undefined && (handLost || (handSeenAt !== null && f.t - handSeenAt >= CURSOR_GAP_MS));
    if (p) {
      if (regrab) { cursor.reset(); handLost = false; }
      handPoint = cursor.map(p.landmarks, f.t);
      handSeenAt = f.t;
      if (state.rotate === "none") hoverTo(pickAt(handPoint)); // 돌리는 동안에는 구를 고르지 않는다(hover null 유지)
    } else if (!handLost && (handSeenAt === null || f.t - handSeenAt >= CURSOR_GAP_MS)) {
      // 추적 손이 잠깐(releaseAfterMs 미만) 안 보이는 동안에는 커서와 hover를 그대로 둔다.
      handLost = true;
      hoverTo(null);
    }
    twoPts = twoPalms(f, out);
    followHands(p ? handPoint : null, f.t, regrab); // 이벤트 앞: 놓는 프레임의 마지막 움직임까지 속도에 든다
    trackOpen(f, p);
    renderCursor();
    for (const e of orderGestureEvents(out.events)) dispatch({ type: e.type }, "hand");
  }

  function attach(src: HandSource): void {
    source = src;
    frameAt = clock.now();
    offFrame = src.onFrame(onFrame);
    ui.preview(preview, src.video);
  }
  function detach(): void {
    offFrame?.();
    offFrame = null;
    if (source) stopSource(source);
    source = null;
    liveHands = 0;
    handLost = true;
    ui.preview(preview, null);
    ui.skeleton(null);
  }
  function useHands(): void {
    gestures.reset();
    cursor.reset();
    handLost = true;
    dispatch({ type: "setInput", input: "hands", now: clock.now() });
  }
  /**
   * 숨은 탭에서는 프레임이 멈추고 타이머도 늦춰진다(길면 1분에 한 번). 숨어 있는 동안과 다시 보이게 된 첫 순간에
   * 시간 기준(마지막 프레임 시각, 손 준비 대기 시작 시각)을 지금으로 맞춘다: 묵은 기준 때문에 돌아온 첫 틱이
   * 정지 폴백·시작 시간 초과로 잘못 빠지지 않게. 틱·손 준비 감시·visibilitychange에서 부른다.
   */
  function syncVisibility(): void {
    const hidden = deps.hidden?.() ?? false;
    if (hidden || wasHidden) {
      const now = clock.now();
      frameAt = now;
      handWaitFrom = now;
    }
    wasHidden = hidden;
  }
  /**
   * 손 인식 준비를 기다린다. 보이는 시간으로 HAND_START_TIMEOUT_MS가 지나거나 skipHandWait(마우스로 계속·화면 떠남)가
   * 불리면 그것을 먼저 돌려주고, 그 뒤에 도착한 소스는 받는 즉시 끈다(카메라·GPU가 남지 않게).
   */
  function waitHands(): Promise<HandWait> {
    return new Promise((resolve) => {
      let settled = false;
      let cancelTimer = () => {};
      const settle = (w: HandWait) => {
        if (settled) {
          if (w.kind === "result" && w.r.ok) stopSource(w.r.source);
          return;
        }
        settled = true;
        cancelTimer();
        skipHandWait = null;
        resolve(w);
      };
      // 한 번짜리 20초 타이머가 아니라 틱 간격으로 잰다: 숨은 탭에서 밀린 타이머가 돌아오자마자 터지지 않게.
      handWaitFrom = clock.now();
      cancelTimer = clock.every(VOTE_TICK_MS, () => {
        syncVisibility();
        if (clock.now() - handWaitFrom >= HAND_START_TIMEOUT_MS) settle({ kind: "timeout" });
      });
      skipHandWait = () => settle({ kind: "skip" });
      let p: Promise<StartResult>;
      try { p = deps.startHands(); } catch (err) { p = Promise.reject(err); }
      p.then((r) => settle({ kind: "result", r }), (err: unknown) => {
        console.warn("[stage] 손 인식 시작 실패", err);
        settle({ kind: "result", r: { ok: false, reason: "wasm-failed" } });
      });
    });
  }
  async function acquireHands(): Promise<void> {
    if (acquiring) return;
    acquiring = true;
    const w = await waitHands();
    acquiring = false;
    if (phase === "disposed") { if (w.kind === "result" && w.r.ok) stopSource(w.r.source); return; }
    if (w.kind === "timeout") { deps.toast(HAND_SLOW_TOAST); return; }
    if (w.kind === "skip") return;
    if (!w.r.ok) { deps.toast(HAND_FAIL[w.r.reason]); return; }
    attach(w.r.source);
    useHands();
  }
  /** 손 인식이 죽었을 때(연속 실패·영상 끊김): 인식기를 끄고, 들고 있던 구는 내려놓고, 마우스로 바꾸고 알린다. */
  function fallbackToMouse(message: string): void {
    detach();
    gestures.reset();
    if (state.input === "hands") {
      if (state.lifted !== null) dispatch({ type: "release" });
      dispatch({ type: "setInput", input: "mouse", now: clock.now() });
    }
    renderCursor();
    deps.toast(message);
  }
  function toggleInput(): void {
    if (state.input === "hands") { dispatch({ type: "setInput", input: "mouse", now: clock.now() }); return; }
    if (source) useHands();
    else void acquireHands();
  }

  function uiAction(a: UiAction): void {
    switch (a) {
      case "toggleInput": toggleInput(); return;
      case "mute":
        narrator.setMuted(!narrator.muted);
        deps.toast(narrator.muted ? "해설 소리를 껐습니다" : "해설 소리를 켰습니다");
        return;
      case "preview":
        preview = nextPreviewMode(preview);
        ui.preview(preview, source?.video ?? null);
        if (preview === "hidden") ui.skeleton(null);
        return;
      case "diag": diagOn = !diagOn; renderDiagPart(); return;
      case "hints": hintsOn = !hintsOn; renderHintsPart(); return;
      case "monthPrev":
      case "monthNext": {
        const i = index.months.indexOf(state.month);
        const j = a === "monthPrev" ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < index.months.length) dispatch({ type: "month", month: index.months[j]! });
        return;
      }
      case "voteToggle": {
        const v = state.vote;
        if (v && v.phase !== "result") dispatch({ type: "voteCancel" });
        else {
          const candidates = voteCandidates(deps.hash(), summary());
          // 안내 단계 길이를 실제 해설 길이에 맞춘다(첫 후보 카메라 창이 소개·안내 음성과 겹치지 않게).
          const timing = voteTiming(candidates, (id) => narrator.clipMs(id));
          dispatch({ type: "voteStart", candidates, now: clock.now(), ...timing });
        }
        return;
      }
      case "rowUp":
      case "rowDown":
        reviewRow = Math.max(0, Math.min(2, reviewRow + (a === "rowUp" ? -1 : 1)));
        renderVote();
        return;
    }
  }

  function tick(): void {
    syncVisibility(); // 숨은 탭: 프레임이 멈추는 게 정상이다. 돌아온 때부터 다시 잰다
    if (!renderer) frameTick(VOTE_TICK_MS / 1000);
    const now = clock.now();
    if (source && source.errors > HAND_ERROR_LIMIT) fallbackToMouse(HAND_ERRORS_TOAST);
    else if (source && state.input === "hands" && now - frameAt > HAND_STALL_MS) fallbackToMouse(HAND_STALL_TOAST);
    if (state.vote) dispatch({ type: "voteTick", now, cameraCount: counter.result() });
    renderVote();
    renderDiagPart();
  }
  const heartbeat = () => { publishState(); publishStage(); };

  /** 렌더 루프 한 번: 관성·정면 복귀를 진행하고 도시 group과 카메라 거리·옆 이동에 적용, 관성 변화를 알리고 큰 화면에 보낸다. */
  function frameTick(dt: number): void {
    const v = rotator.tick(dt);
    scene.group.rotation.y = v.yaw;
    renderer?.setZoom(v.zoom);
    renderer?.setPan(v.panX);
    syncSpin();
    publishView();
  }

  /**
   * 휠: 지도·펼친 화면에서, 든 구 없음·투표 진행 중 아님일 때만. 픽셀로 모아 WHEEL_STEP_PX마다 한 단계(방향이 바뀌면 새로 센다).
   * 기준점(계약 13.8): 펼친 화면은 휠 이벤트 자리 at의 ndc x(x·2 − 1). at이 없으면 마지막 포인터 자리, 그것도 없으면 가운데.
   * 지도는 가운데(panX 0 유지).
   */
  function wheel(deltaY: number, deltaMode = 0, at?: Point | null): void {
    if (phase !== "running") return;
    const v = state.vote;
    if (state.lifted !== null || (v !== null && v.phase !== "result")) { wheelAcc = 0; return; }
    const px = wheelPixels(deltaY, deltaMode);
    if (!Number.isFinite(px) || px === 0) return;
    if (Math.sign(px) !== Math.sign(wheelAcc)) wheelAcc = 0;
    wheelAcc += px;
    const p = at ?? mousePoint;
    const anchor = state.mode === "spread" && p ? p.x * 2 - 1 : 0;
    while (Math.abs(wheelAcc) >= WHEEL_STEP_PX) {
      const dir = Math.sign(wheelAcc);
      rotator.wheel(dir, anchor);
      wheelAcc -= dir * WHEEL_STEP_PX;
    }
  }

  const pointer: StagePointer = {
    move(p) {
      if (phase !== "running") return;
      mousePoint = p;
      if (state.rotate === "none") { hoverTo(pickAt(p)); return; } // 돌리는 동안에는 구를 고르지 않는다
      if (state.rotate !== "one" || rotBy !== "mouse") return;
      if (pendingGrab === "one") { pendingGrab = null; rotator.grabOne(p, clock.now()); }
      else rotator.move(p, clock.now());
    },
    // 누르기는 지금의 grab 길: 구 위면 들기, 빈 지도면 돌리기, 관성 중이면 잡기(리듀서 13.4).
    down() {
      if (phase !== "running") return;
      retryUnlock();
      mouseDown = true;
      dispatch({ type: "grab" }, "mouse");
    },
    up() {
      if (phase !== "running" || !mouseDown) return;
      mouseDown = false;
      dispatch({ type: "release" }, "mouse");
      // 돌리는 동안 건너뛴 hover를 포인터 아래에서 다시 고른다(움직이지 않고 놓아도 구가 밝아지게).
      if (mousePoint && state.rotate === "none") hoverTo(pickAt(mousePoint));
    },
    leave() {
      if (phase !== "running") return;
      mousePoint = null;
      pointer.up();
      if (state.input === "mouse") hoverTo(null);
    },
    wheel,
  };

  // ----- 처음 그림: 시작 화면 뒤로 전체 지도가 보인다.
  scene.setOverview(summary(), state.metric);
  renderer?.setMode("map", true);
  rotator.setYawLocked(state.mode === "spread"); // 넘겨받은 회전기도 처음 모드(지도)에 맞춘다
  // 회전기는 렌더 루프에서 진행한다. WebGL이 없으면(3D 없음) 틱 간격으로 진행해 관성이 멈추고 큰 화면도 따라간다.
  if (renderer) stops.push(renderer.onFrame(frameTick));
  stops.push(narrator.onCaption((t) => setPart("caption", renderCaption(t))));
  stops.push(narrator.onBlocked(() => { if (phase !== "disposed") deps.toast(AUDIO_BLOCKED_TOAST); }));
  stops.push(deps.realtime.onStatus(() => renderTop()), deps.stageChannel.onStatus(() => renderTop()));
  if (deps.onVisibilityChange) stops.push(deps.onVisibilityChange(syncVisibility));
  setPart("caption", renderCaption(null));
  renderAll();
  deps.modelReady?.().then(
    (ok) => { modelReady = ok; renderStartPart(); },
    () => { modelReady = false; renderStartPart(); },
  );

  return {
    get state() { return state; },
    get publishFailed() { return publishFailed(); },
    get started() { return phase === "running"; },
    async start(mode) {
      // 준비 덮개의 "마우스로 계속": 손 준비를 그만 기다리고 마우스로 바로 시작한다(늦게 온 소스는 도착할 때 끈다).
      if (phase === "starting" && mode === "mouse") { skipHandWait?.(); return; }
      if (phase !== "idle") return;
      // 오토플레이 정책: 사용자 클릭 처리 안에서 await보다 먼저 불러야 한다.
      void narrator.unlock().catch(() => {});
      phase = "starting";
      renderStartPart();
      if (mode === "hands") await acquireHands();
      if (phase !== "starting") return; // 기다리는 사이 화면을 떠났다
      phase = "running";
      renderAll();
      stops.push(clock.every(VOTE_TICK_MS, tick), clock.every(HEARTBEAT_MS, heartbeat));
      narrator.say(NARRATION_IDS.hello, { interrupt: true });
      publishState();
      publishStage();
    },
    key(e) {
      if (phase !== "running") return false;
      retryUnlock();
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const r = keyToAction(normalizeKey(e.key, e.code), state, { reviewRow, now: clock.now() });
      if (!r) return false;
      // 누르고 있어 반복되는 키는 줄 이동만 받는다(투표 토글·펼치기가 연달아 일어나지 않게). 반복도 기본 동작은 막는다.
      if (e.repeat && !(r.kind === "ui" && (r.action === "rowUp" || r.action === "rowDown"))) return true;
      if (r.kind === "event") dispatch(r.event);
      else uiAction(r.action);
      return true;
    },
    pointer,
    panel(t) {
      if (phase !== "running") return;
      retryUnlock();
      if (!state.vote) return;
      const now = clock.now();
      if (t.set) {
        const m = /^([0-2]):(\d)$/.exec(t.set);
        if (!m) return;
        const i = Number(m[1]);
        if (state.vote.phase === "review") reviewRow = i;
        dispatch({ type: "voteSet", index: i, n: Number(m[2]), now });
        renderVote();
      } else if (t.confirm) {
        dispatch({ type: "voteConfirm", now });
      } else if (t.method === "camera" || t.method === "manual") {
        dispatch({ type: "voteMethod", method: t.method, now });
      }
    },
    dispose() {
      if (phase === "disposed") return;
      const wasRunning = phase === "running";
      phase = "disposed";
      skipHandWait?.();
      if (wasRunning) {
        // 무대를 떠난다: 따라오던 폰이 펼치기·들어 올림에 갇히지 않게 지도·내려놓음을 한 번 보낸다(실패는 무시).
        const last = toStageMessage({ ...state, mode: "map", lifted: null }, clock.now());
        try { deps.stageChannel.publish(last).catch(() => {}); } catch { /* 무시 */ }
      }
      for (const stop of stops.splice(0)) stop();
      detach();
      narrator.stop();
    },
  };
}

// ---------- DOM 껍데기 ----------

const PARTS: readonly UiPart[] = ["top", "hints", "caption", "vote", "live", "diag", "start"];

const LAYOUT = `<div class="stage-view">` +
  `<div class="stage-3d" data-3d></div>` +
  `<div class="stage-ui">` +
  `<div data-part="top"></div>` +
  `<div class="stage-vote-host" data-part="vote" hidden></div>` +
  `<div class="stage-live-host" data-part="live" hidden></div>` +
  `<div class="stage-bottom"><div data-part="caption"></div><div data-part="hints"></div></div>` +
  `</div>` +
  // 거울 규칙(overlay.css): .is-mirror는 video만 뒤집는다. 골격 canvas는 뒤집지 않고 drawSkeleton(mirror=true)이 x를 뒤집는다.
  `<div class="stage-preview is-mirror is-hidden" data-preview><canvas data-skeleton aria-hidden="true"></canvas></div>` +
  `<div class="stage-cursor is-hidden" data-cursor aria-hidden="true"></div>` +
  `<div data-part="diag" hidden></div>` +
  `<div class="stage-start-host" data-part="start"></div>` +
  `</div>`;

/** 다시 그려도 키보드 포커스가 같은 투표 버튼에 남게 한다. */
function voteFocusKey(el: Element | null): string | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el.dataset.voteSet && /^\d:\d$/.test(el.dataset.voteSet)) return `[data-vote-set="${el.dataset.voteSet}"]`;
  if (el.dataset.voteMethod === "camera" || el.dataset.voteMethod === "manual") return `[data-vote-method="${el.dataset.voteMethod}"]`;
  if (el.hasAttribute("data-vote-confirm")) return "[data-vote-confirm]";
  return null;
}

function domUi(root: HTMLElement) {
  const parts = Object.fromEntries(PARTS.map((p) => [p, root.querySelector<HTMLElement>(`[data-part="${p}"]`)!])) as Record<UiPart, HTMLElement>;
  const previewEl = root.querySelector<HTMLElement>("[data-preview]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-skeleton]")!;
  const ctx2d = canvas.getContext("2d");
  const cursorEl = root.querySelector<HTMLElement>("[data-cursor]")!;
  const viewEl = root.querySelector<HTMLElement>(".stage-view")!;
  const voteEl = parts.vote;
  // 미리보기 상자를 실제 카메라 비율에 맞춘다(1280×720 요청을 못 지킨 4:3 웹캠에서도 골격이 영상과 맞게).
  let fitted: HTMLVideoElement | null = null;
  const fit = () => {
    if (fitted && fitted.videoWidth > 0 && fitted.videoHeight > 0) previewEl.style.aspectRatio = `${fitted.videoWidth} / ${fitted.videoHeight}`;
  };

  // 투표 패널 버튼을 누르는 사이(pointerdown~click)에 패널이 바뀌면 click이 사라진다. 누르는 동안에는 미뤄 둔다.
  let held = false;
  let pending: { html: string | null } | null = null;
  const write = (part: UiPart, html: string | null) => {
    const el = parts[part];
    el.hidden = html === null;
    if (part === "diag") viewEl.classList.toggle("has-diag", html !== null); // 아래 띠가 왼쪽 진단 칸을 비운다
    if (part !== "vote") { el.innerHTML = html ?? ""; return; }
    const active = document.activeElement;
    const key = active && el.contains(active) ? voteFocusKey(active) : null;
    el.innerHTML = html ?? "";
    if (key) el.querySelector<HTMLElement>(key)?.focus({ preventScroll: true });
  };
  const hold = () => { held = true; };
  const unhold = () => {
    if (!held) return;
    held = false;
    setTimeout(() => {
      if (held || !pending) return;
      const { html } = pending;
      pending = null;
      write("vote", html);
    }, 0);
  };
  voteEl.addEventListener("pointerdown", hold);
  window.addEventListener("pointerup", unhold);
  window.addEventListener("pointercancel", unhold);

  const ui: StageUi = {
    set(part, html) {
      if (part === "vote") {
        if (held) { pending = { html }; return; }
        pending = null; // 클릭 처리로 새로 그린 것이 미뤄 둔 옛 내용보다 나중이다
      }
      write(part, html);
    },
    cursor(p, cls) {
      cursorEl.className = cls;
      if (p) {
        cursorEl.style.left = `${(p.x * 100).toFixed(2)}%`;
        cursorEl.style.top = `${(p.y * 100).toFixed(2)}%`;
      }
    },
    preview(mode, video) {
      const current = previewEl.querySelector("video");
      if (current && current !== video) current.remove();
      if (video && video.parentElement !== previewEl) {
        video.setAttribute("aria-hidden", "true");
        previewEl.prepend(video);
      }
      if (video !== fitted) {
        fitted?.removeEventListener("loadedmetadata", fit);
        fitted = video;
        video?.addEventListener("loadedmetadata", fit);
        fit();
      }
      const visible = mode !== "hidden" && video !== null;
      previewEl.classList.toggle("is-hidden", !visible);
      previewEl.classList.toggle("is-skeleton", mode === "skeleton");
      viewEl.classList.toggle("has-preview", visible); // 아래 띠(자막·안내)가 오른쪽 미리보기 칸을 비운다
    },
    skeleton(frame) {
      if (!ctx2d) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      if (!frame) { ctx2d.clearRect(0, 0, w, h); return; }
      drawSkeleton(ctx2d, frame, w, h, true);
    },
  };
  const dispose = () => {
    fitted?.removeEventListener("loadedmetadata", fit);
    voteEl.removeEventListener("pointerdown", hold);
    window.removeEventListener("pointerup", unhold);
    window.removeEventListener("pointercancel", unhold);
  };
  return { ui, parts, dispose };
}

async function modelOnServer(): Promise<boolean> {
  // SPA 폴백(200 + text/html)은 모델 없음으로 본다(recognizer와 같은 규칙).
  const res = await fetch(MODEL_PATH, { method: "HEAD" });
  return res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
}

function tryWebGL(): WebGLRenderer | null {
  try {
    return new WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    console.warn("[stage] WebGL을 만들 수 없음", err);
    return null;
  }
}

function renderBuildError(root: HTMLElement): void {
  root.innerHTML = `<main class="boot boot--fail"><h1>무대 화면을 준비하지 못했습니다</h1>` +
    `<p>새로 고침하거나 발표자 화면으로 돌아가 주세요.</p>` +
    `<button type="button" class="btn btn-primary" data-retry>다시 시도</button></main>`;
  root.querySelector("[data-retry]")?.addEventListener("click", () => location.reload());
}

/**
 * 무대 화면을 만든다. 만든 것마다 해제 함수를 쌓아 두고, 중간에 던지면 쌓인 것을 거꾸로 풀고 실패 문구를 그린다
 * ("준비하는 중"에서 멈추거나 렌더 루프·WebGL 컨텍스트·카메라가 남지 않게).
 */
function build(root: HTMLElement, ctx: ViewContext, manifest: NarrationManifest | null): () => void {
  const undo: (() => void)[] = [];
  const teardown = () => {
    for (const fn of undo.splice(0).reverse()) {
      try { fn(); } catch (err) { console.warn("[stage] 해제 실패", err); }
    }
  };
  try {
    root.innerHTML = LAYOUT;
    const layer = root.querySelector<HTMLElement>("[data-3d]")!;
    const dom = domUi(root);
    undo.push(dom.dispose);

    // WebGLRenderer를 여기서 만들어 넘긴다: 떠날 때 forceContextLoss로 컨텍스트를 바로 반납하려고(orbitView와 같다).
    const gl = tryWebGL();
    if (gl) undo.push(() => gl.forceContextLoss());
    const renderer = gl ? createStageRenderer(layer, { reducedMotion: ctx.reducedMotion, makeRenderer: () => gl }) : null;
    if (renderer) undo.push(() => renderer.dispose());
    const city = ctx.createScene();
    undo.push(() => city.dispose());
    if (renderer) {
      renderer.world.add(city.group); // 씬 group이 조명을 들고 있다
      undo.push(renderer.onFrame((dt) => city.update(dt, renderer.camera)));
    } else {
      layer.innerHTML = `<p class="stage-fail">이 기기에서는 3D를 그릴 수 없습니다. 투표와 해설은 그대로 진행할 수 있습니다.</p>`;
    }

    const narrator = createNarrator(manifest, { createAudio: () => new Audio() as unknown as AudioLike });
    const { month, metric } = ctx.store.getState();
    const controller = createStageController({
      index: ctx.index,
      month: month || (ctx.index.months.at(-1) ?? ""),
      metric, // 호스트에서 고른 지표를 이어받아, 시작 발행이 관객 지표를 바꾸지 않게
      loadGu: ctx.loadGu,
      realtime: ctx.realtime,
      stageChannel: ctx.stageChannel,
      scene: city,
      renderer,
      narrator,
      ui: dom.ui,
      toast: ctx.toast,
      startHands: () => startHandSource(),
      hash: () => location.hash,
      modelReady: modelOnServer,
      hidden: () => document.hidden,
      onVisibilityChange: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
      onState: (m) => ctx.store.dispatch({ type: "local", month: m.month, gu: m.gu, metric: m.metric }),
      reducedMotion: ctx.reducedMotion,
    });
    undo.push(() => controller.dispose());

    const onStart = (ev: Event) => {
      const btn = (ev.target as Element).closest<HTMLElement>("[data-start]");
      if (btn) void controller.start(btn.dataset.start === "hands" ? "hands" : "mouse");
    };
    const onVote = (ev: Event) => {
      const btn = (ev.target as Element).closest<HTMLButtonElement>("button");
      if (!btn || btn.disabled) return;
      controller.panel({ set: btn.dataset.voteSet ?? null, confirm: btn.hasAttribute("data-vote-confirm"), method: btn.dataset.voteMethod ?? null });
    };
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (controller.key(ev)) ev.preventDefault();
    };
    dom.parts.start.addEventListener("click", onStart);
    dom.parts.vote.addEventListener("click", onVote);
    document.addEventListener("keydown", onKey);
    undo.push(() => {
      document.removeEventListener("keydown", onKey);
      dom.parts.start.removeEventListener("click", onStart);
      dom.parts.vote.removeEventListener("click", onVote);
    });
    // 휠은 deltaMode(줄·페이지 단위 장치)가 있어야 해서 attachPointer(deltaY만 넘김) 대신 여기서 받는다.
    const { move, down, up, leave } = controller.pointer;
    undo.push(attachPointer(layer, { move, down, up, leave }));
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault(); // 페이지가 스크롤·확대되지 않게(passive: false)
      controller.pointer.wheel(ev.deltaY, ev.deltaMode, stagePoint(layer, ev)); // 기준점은 휠이 일어난 자리(13.8)
    };
    layer.addEventListener("wheel", onWheel, { passive: false });
    undo.push(() => layer.removeEventListener("wheel", onWheel));
    return teardown;
  } catch (err) {
    console.error("[stage] 무대 화면을 만들지 못함", err);
    teardown();
    renderBuildError(root);
    return () => {};
  }
}

export const mountStageView: MountView = (root, ctx) => {
  // 무대는 원본이다: 다른 화면의 원격 상태를 따라가지 않는다(main.ts도 #/stage에서 원격을 무시한다).
  ctx.store.dispatch({ type: "local" });
  root.innerHTML = `<p class="boot" role="status">무대를 준비하는 중</p>`;
  let alive = true;
  let teardown: (() => void) | null = null;
  // 해설 manifest가 있어야 narrator를 만들 수 있다. 없거나 깨졌으면 null(자막·음성 없이 진행).
  void loadManifest().then((manifest) => {
    if (!alive) return;
    teardown = build(root, ctx, manifest);
  });
  return () => {
    alive = false;
    teardown?.();
    root.innerHTML = "";
  };
};
