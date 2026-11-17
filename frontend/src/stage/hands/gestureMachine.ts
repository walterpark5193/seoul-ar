// 제스처 판정기. 계약: docs/CONTRACTS-stage.md 2.2, 설계 5.2·4.4.
// 순수 모듈: HandFrame 시퀀스를 받아 grab/release/spread/victory 이벤트와 주 손을 낸다.
import { VOTE_MAX, type GestureEvent, type GestureName, type GestureOutput, type HandFrame, type HandObs, type Vec3 } from "../types";

export interface GestureConfig { minScore: number; confirmFrames: number; cooldownMs: number; releaseAfterMs: number; }
export const DEFAULT_GESTURE_CONFIG: GestureConfig = Object.freeze({ minScore: 0.6, confirmFrames: 6, cooldownMs: 800, releaseAfterMs: 300 });
export interface GestureMachine { push(frame: HandFrame, ctx: { voting: boolean }): GestureOutput; reset(): void; readonly fist: boolean; }

const WRIST = 0;
const INDEX_MCP = 5;
const PINKY_MCP = 17;

/** 영상 평면(x, y) 거리. 랜드마크가 없으면 null. */
function planar(a: Vec3 | undefined, b: Vec3 | undefined): number | null {
  if (!a || !b) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 직전 주 손 손목에 가장 가까운 손, 직전 주 손이 없으면 손바닥 폭(5↔17)이 가장 큰 손. 같으면 앞 손. */
function pickPrimary(hands: readonly HandObs[], prevWrist: Vec3 | null): number | null {
  if (hands.length === 0) return null;
  let best = 0;
  let bestScore = -Infinity;
  hands.forEach((h, i) => {
    const score = prevWrist
      ? -(planar(h.landmarks[WRIST], prevWrist) ?? Infinity)
      : planar(h.landmarks[INDEX_MCP], h.landmarks[PINKY_MCP]) ?? 0;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

export function createGestureMachine(cfg: Partial<GestureConfig> = {}): GestureMachine {
  const c: GestureConfig = { ...DEFAULT_GESTURE_CONFIG };
  for (const k of Object.keys(c) as (keyof GestureConfig)[]) {
    const v = cfg[k];
    if (v !== undefined) c[k] = v;
  }

  let fist = false;
  let prevWrist: Vec3 | null = null;     // 직전 프레임 주 손의 손목. 손이 없던 프레임 뒤에는 null
  let lastHandT: number | null = null;   // 손이 하나라도 보인 마지막 프레임 시각
  let cooldownUntil = -Infinity;
  // 조건별 연속 참 프레임 수
  let fistRun = 0;
  let notFistRun = 0;
  let spreadRun = 0;
  let victoryRun = 0;
  // 래치: 한 번 낸 뒤 손 모양이 바뀐 프레임이 나와야 다시 낼 수 있다
  let spreadArmed = true;
  let victoryArmed = true;

  const sure = (h: HandObs, g: GestureName) => h.gesture === g && h.score >= c.minScore;

  function reset(): void {
    fist = false;
    prevWrist = null;
    lastHandT = null;
    cooldownUntil = -Infinity;
    fistRun = notFistRun = spreadRun = victoryRun = 0;
    spreadArmed = victoryArmed = true;
  }

  function push(frame: HandFrame, ctx: { voting: boolean }): GestureOutput {
    const { t, hands } = frame;
    const primary = pickPrimary(hands, prevWrist);
    const p = primary === null ? undefined : hands[primary];
    prevWrist = p?.landmarks[WRIST] ?? null;
    if (hands.length > 0) lastHandT = t;
    const handCount = Math.min(hands.length, VOTE_MAX);

    const isFist = p !== undefined && sure(p, "Closed_Fist");
    const isNotFist = p !== undefined && !isFist;          // 손 없음은 여기 넣지 않는다(releaseAfterMs 규칙이 맡음)
    const isSpread = hands.length === 2 && hands.every((h) => sure(h, "Open_Palm"));
    const isVictory = p !== undefined && sure(p, "Victory");
    fistRun = isFist ? fistRun + 1 : 0;
    notFistRun = isNotFist ? notFistRun + 1 : 0;
    spreadRun = isSpread ? spreadRun + 1 : 0;
    victoryRun = isVictory ? victoryRun + 1 : 0;

    // 래치 풀림은 제스처 이름으로 본다. 점수가 한 프레임 minScore 아래로 흔들린 것만으로는 풀리지 않는다.
    if (!(hands.length === 2 && hands.every((h) => h.gesture === "Open_Palm"))) spreadArmed = true;
    if (p?.gesture !== "Victory") victoryArmed = true;

    if (ctx.voting) {
      // 투표 중: 이벤트 없음. 쥔 주먹은 조용히 놓고, 투표 중 본 프레임은 확정에 쓰지 않는다.
      // 투표가 끝날 때 들고 있던 두 손·브이가 곧바로 spread·victory가 되지 않게 래치를 잠가 둔다.
      fist = false;
      fistRun = notFistRun = spreadRun = victoryRun = 0;
      spreadArmed = victoryArmed = false;
      return { primary, events: [], handCount };
    }

    const events: GestureEvent[] = [];
    const confirmed = (run: number) => run >= c.confirmFrames;
    const fire = (e: GestureEvent) => { events.push(e); cooldownUntil = t + c.cooldownMs; };
    const ready = () => !fist && t >= cooldownUntil;

    if (fist) {
      const lost = hands.length === 0 && lastHandT !== null && t - lastHandT >= c.releaseAfterMs;
      if (confirmed(notFistRun) || lost) {
        // 쿨다운 무시, 쿨다운 시작. 주먹을 두 손 펴기로 놓았을 때 이어서 spread가 나지 않게 spread 래치를 잠근다.
        fist = false;
        spreadArmed = false;
        fire({ type: "release" });
      }
    }
    if (ready() && confirmed(fistRun)) { fist = true; fire({ type: "grab" }); }
    if (ready() && spreadArmed && confirmed(spreadRun)) { spreadArmed = false; fire({ type: "spread" }); }
    if (ready() && victoryArmed && confirmed(victoryRun)) { victoryArmed = false; fire({ type: "victory" }); }

    return { primary, events, handCount };
  }

  return { push, reset, get fist() { return fist; } };
}
