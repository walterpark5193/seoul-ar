// 제스처 판정기. 계약: docs/CONTRACTS-stage.md 2.2, 설계 5.2·4.4.
// 순수 모듈: HandFrame 시퀀스를 받아 grab/release/spread/victory 이벤트와 주 손을 낸다.
import { VOTE_MAX, type GestureEvent, type GestureName, type GestureOutput, type HandFrame, type HandObs, type Vec3 } from "../types";

export interface GestureConfig { minScore: number; confirmFrames: number; cooldownMs: number; releaseAfterMs: number; }
export const DEFAULT_GESTURE_CONFIG: GestureConfig = Object.freeze({ minScore: 0.6, confirmFrames: 6, cooldownMs: 800, releaseAfterMs: 300 });
export interface GestureMachine { push(frame: HandFrame, ctx: { voting: boolean }): GestureOutput; reset(): void; readonly fist: boolean; }

const WRIST = 0;
const INDEX_MCP = 5;
const PINKY_MCP = 17;
/** 추적 중인 손을 다시 잡을 때 허용하는 손목 거리(영상 정규 좌표). 이보다 먼 손은 다른 손으로 본다. */
const TRACK_RADIUS = 0.15;

/** 영상 평면(x, y) 거리. 랜드마크가 없으면 null. */
function planar(a: Vec3 | undefined, b: Vec3 | undefined): number | null {
  if (!a || !b) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 손목이 wrist에 가장 가까운 손과 그 거리. 같으면 앞 손. */
function nearest(hands: readonly HandObs[], wrist: Vec3): { i: number; d: number } | null {
  let best: { i: number; d: number } | null = null;
  for (const [i, h] of hands.entries()) {
    const d = planar(h.landmarks[WRIST], wrist);
    if (d !== null && (best === null || d < best.d)) best = { i, d };
  }
  return best;
}

/** 손바닥 폭(5↔17)이 가장 큰 손. 같으면 앞 손. 손이 없으면 null. */
function widest(hands: readonly HandObs[]): number | null {
  let best: number | null = null;
  let bestW = -Infinity;
  for (const [i, h] of hands.entries()) {
    const w = planar(h.landmarks[INDEX_MCP], h.landmarks[PINKY_MCP]) ?? 0;
    if (w > bestW) { best = i; bestW = w; }
  }
  return best;
}

export function createGestureMachine(cfg: Partial<GestureConfig> = {}): GestureMachine {
  const c: GestureConfig = { ...DEFAULT_GESTURE_CONFIG };
  for (const k of Object.keys(c) as (keyof GestureConfig)[]) {
    const v = cfg[k];
    if (v !== undefined) c[k] = v;
  }
  c.confirmFrames = Math.max(1, Math.floor(c.confirmFrames));   // 0 이하면 손 없는 첫 프레임에서도 확정되므로 막는다

  let fist = false;
  // 추적 중인 주 손: 마지막으로 본 손목과 그 시각. releaseAfterMs 동안 기억한다.
  let tracked: { wrist: Vec3; t: number } | null = null;
  let cooldownUntil = -Infinity;
  // 조건별 연속 참 프레임 수
  let fistRun = 0;
  let notFistRun = 0;
  let spreadRun = 0;
  let victoryRun = 0;
  // 래치: 한 번 낸 뒤 "그 손 모양이 아님"(제스처 이름 기준)이 confirmFrames 연속 나와야 다시 낼 수 있다
  let spreadArmed = true;
  let victoryArmed = true;
  let spreadOffRun = 0;
  let victoryOffRun = 0;

  const sure = (h: HandObs, g: GestureName) => h.gesture === g && h.score >= c.minScore;
  const confirmed = (run: number) => run >= c.confirmFrames;

  function reset(): void {
    fist = false;
    tracked = null;
    cooldownUntil = -Infinity;
    fistRun = notFistRun = spreadRun = victoryRun = 0;
    spreadArmed = victoryArmed = true;
    spreadOffRun = victoryOffRun = 0;
  }

  function push(frame: HandFrame, ctx: { voting: boolean }): GestureOutput {
    const { t, hands } = frame;
    const handCount = Math.min(hands.length, VOTE_MAX);

    // 주 손. 추적 손을 기억하는 동안에는 그 손목 근처(TRACK_RADIUS 안)의 손만 다시 잡는다.
    // 근처에 손이 없으면 이번 프레임은 "추적 손 없음"이고, 다른 손으로 넘어가지 않는다.
    // releaseAfterMs 동안 추적 손이 안 보이면 기억을 버리고 가장 큰 손으로 돌아간다.
    let remembered = tracked !== null && t - tracked.t < c.releaseAfterMs;
    if (tracked !== null && !remembered && fist) {
      // 정지 가드: 프레임 자체가 releaseAfterMs 넘게 멈췄다 다시 온 경우(느린 기기·탭 전환·3fps 이하),
      // 쥔 손이 추적 손목 근처에 그대로 있으면 놓지 않고 같은 손으로 이어 잡는다.
      // 손이 실제로 화면을 벗어났다면 손 없는 프레임이 이어지므로 그대로 releaseAfterMs에 놓인다.
      const n = nearest(hands, tracked.wrist);
      if (n !== null && n.d <= TRACK_RADIUS) remembered = true;
    }
    const lostTracked = tracked !== null && !remembered;
    let primary: number | null;
    if (tracked !== null && remembered) {
      const n = nearest(hands, tracked.wrist);
      primary = n !== null && n.d <= TRACK_RADIUS ? n.i : null;
    } else {
      primary = widest(hands);
    }
    const p = primary === null ? undefined : hands[primary];
    const w = p?.landmarks[WRIST];
    if (w) tracked = { wrist: w, t };
    else if (!remembered) tracked = null;

    const isFist = p !== undefined && sure(p, "Closed_Fist");
    const isNotFist = p !== undefined && !isFist;
    const isSpread = hands.length === 2 && hands.every((h) => sure(h, "Open_Palm"));
    const isVictory = p !== undefined && sure(p, "Victory");
    fistRun = isFist ? fistRun + 1 : 0;
    // 추적 손이 없는 프레임은 비주먹 확정에 중립(늘리지도 끊지도 않음). 손이 사라진 경우는 releaseAfterMs가 맡는다.
    notFistRun = isNotFist ? notFistRun + 1 : p === undefined ? notFistRun : 0;
    spreadRun = isSpread ? spreadRun + 1 : 0;
    victoryRun = isVictory ? victoryRun + 1 : 0;

    // 래치 풀림은 제스처 이름으로 보고(점수 흔들림 제외), confirmFrames 연속이어야 한다(한 프레임 흔들림 제외).
    const spreadShape = hands.length === 2 && hands.every((h) => h.gesture === "Open_Palm");
    spreadOffRun = spreadShape ? 0 : spreadOffRun + 1;
    victoryOffRun = p?.gesture === "Victory" ? 0 : victoryOffRun + 1;
    if (confirmed(spreadOffRun)) spreadArmed = true;
    if (confirmed(victoryOffRun)) victoryArmed = true;

    if (ctx.voting) {
      // 투표 중: 이벤트 없음. 쥔 주먹은 조용히 놓고, 투표 중 본 프레임은 확정에도 래치 풀림에도 쓰지 않는다.
      // 투표가 끝날 때 들고 있던 두 손·브이가 곧바로 spread·victory가 되지 않게 래치를 잠가 둔다.
      fist = false;
      fistRun = notFistRun = spreadRun = victoryRun = 0;
      spreadOffRun = victoryOffRun = 0;
      spreadArmed = victoryArmed = false;
      return { primary, events: [], handCount };
    }

    const events: GestureEvent[] = [];
    const fire = (e: GestureEvent) => { events.push(e); cooldownUntil = t + c.cooldownMs; };
    const ready = () => !fist && t >= cooldownUntil;

    if (fist && (confirmed(notFistRun) || lostTracked)) {
      // 쿨다운 무시, 쿨다운 시작. 주먹을 두 손 펴기로 놓았을 때 이어서 spread가 나지 않게 spread 래치를 잠근다.
      fist = false;
      spreadArmed = false;
      spreadOffRun = 0;
      fire({ type: "release" });
    }
    if (ready() && confirmed(fistRun)) { fist = true; fire({ type: "grab" }); }
    if (ready() && spreadArmed && confirmed(spreadRun)) { spreadArmed = false; fire({ type: "spread" }); }
    if (ready() && victoryArmed && confirmed(victoryRun)) { victoryArmed = false; fire({ type: "victory" }); }

    return { primary, events, handCount };
  }

  return { push, reset, get fist() { return fist; } };
}
