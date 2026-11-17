// 상태 변화 → 부수 효과 목록. 계약: docs/CONTRACTS-stage.md 3.2, 13.4(rotate.*), 13.8(펼치기 나갈 때 리셋). 순수 함수.
import type { Effect, StageEvent, StageState, VoteState } from "./types";

export const NARRATION_IDS = {
  hello: "stage-hello" as const,
  spread: "spread-intro" as const,
  mapBack: "map-back" as const,
  voteIntro: "vote-intro" as const,
  gu: (month: string, gu: string): string => `gu-${month}-${gu}`,
  votePrompt: (gu: string): string => `vote-prompt-${gu}`,
  voteResult: (gu: string, n: number): string => `vote-result-${gu}-${n}`,
  voteNone: (gu: string): string => `vote-none-${gu}`,
};

const narrate = (id: string, interrupt: boolean, protect = false): Effect => ({ type: "narrate", id, interrupt, protect });

function newRound(prev: VoteState | null, next: VoteState): boolean {
  return !prev || prev.round !== next.round;
}
function entered(prev: VoteState | null, next: VoteState, phase: VoteState["phase"]): boolean {
  return next.phase === phase && (newRound(prev, next) || prev!.phase !== phase);
}

/**
 * 회전기 조작(계약 13.4). 정면 복귀(펼치기 진입·나가기·투표 시작·입력 전환·브이)면 rotate.reset 하나만 낸다(놓기·관성 없음).
 * 펼치기에서 나갈 때(토글·앉히기·브이·투표 확정 등 원인과 무관)도 들어갈 때처럼 리셋해 펼침 확대·panX를 지도에 남기지 않는다(13.8).
 * 아니면 잡기 상태 변화대로: 놓으면 release, 잡으면 grabOne/grabTwo, 관성 중에 잡았으면 그 앞에 catch.
 * 브이는 상태가 그대로일 수 있어(돌려 놓고 놓인 지도) 상태 차이로는 알 수 없다: cause로 알아본다.
 */
function rotateEffects(prev: StageState, next: StageState, cause: StageEvent | undefined): Effect[] {
  const reset =
    prev.mode !== next.mode ||
    (next.vote !== null && newRound(prev.vote, next.vote)) ||
    prev.input !== next.input ||
    (cause?.type === "victory" && next !== prev); // 리듀서가 무시한 이벤트는 같은 객체를 돌려준다
  if (reset) return [{ type: "rotate.reset" }];
  if (prev.rotate === next.rotate) return [];
  if (next.rotate === "none") return [{ type: "rotate.release" }];
  const out: Effect[] = prev.spinning && !next.spinning ? [{ type: "rotate.catch" }] : [];
  out.push({ type: next.rotate === "one" ? "rotate.grabOne" : "rotate.grabTwo" });
  return out;
}

/**
 * prev → next 변화의 효과. cause(next를 만든 이벤트)는 선택이지만 stageView는 넘겨야 한다:
 * 없으면 상태가 그대로인 브이의 정면 복귀(rotate.reset)와, 두 주먹이 들기를 취소할 때의 해설 멈춤(narrate.stop)을
 * 알 수 없다. 나머지 효과는 cause와 무관하다.
 */
export function diffEffects(prev: StageState, next: StageState, cause?: StageEvent): Effect[] {
  const rotate = rotateEffects(prev, next, cause);
  const layout: Effect[] = [];
  const lift: Effect[] = [];
  const focus: Effect[] = [];
  const hover: Effect[] = [];
  const data: Effect[] = [];
  const counter: Effect[] = [];
  const narr: Effect[] = [];
  let pubState = false;
  let pubStage = false;
  const pubVote: Effect[] = [];

  const pv = prev.vote;
  const nv = next.vote;
  const resultEntered = !!nv && entered(pv, nv, "result");

  if (prev.mode !== next.mode) {
    layout.push({ type: "scene.layout", mode: next.mode });
    pubStage = true;
    if (next.mode === "spread") narr.push(narrate(NARRATION_IDS.spread, true));
    else {
      // release는 focus를 lifted로 설정하고, victory는 focus를 null로 만든다.
      const releaseBack = prev.lifted !== null && next.lifted === null && next.focus === prev.lifted;
      if (!resultEntered && !releaseBack) narr.push(narrate(NARRATION_IDS.mapBack, true));
    }
  }
  if (prev.lifted !== next.lifted) {
    lift.push({ type: "scene.lift", gu: next.lifted });
    pubStage = true;
    if (next.lifted !== null) narr.push(narrate(NARRATION_IDS.gu(next.month, next.lifted), true));
  }
  if (prev.focus !== next.focus) {
    focus.push({ type: "scene.focus", gu: next.focus });
    pubState = true;
  }
  if (prev.hover !== next.hover) hover.push({ type: "scene.hover", gu: next.hover });
  if (prev.month !== next.month || prev.metric !== next.metric) {
    data.push({ type: "scene.data" });
    pubState = true;
  }

  // 투표를 취소하면(결과 화면이 아닌 투표가 사라짐) 보호된 소개·안내 클립까지 멈추고 대기열을 비운다.
  if (pv && pv.phase !== "result" && !nv) narr.push({ type: "narrate.stop" });
  // 두 주먹이 막 든 구를 내려놓으면(주 손 주먹이 먼저 확정된 경우) 그 구 해설도 멈춘다(계약 13.4).
  // 두 주먹은 투표 진행 중에 오지 않으므로 보호 클립을 끊을 일이 없다.
  else if (cause?.type === "twoFist" && prev.lifted !== null && next.lifted === null) narr.push({ type: "narrate.stop" });

  if (nv) {
    if (newRound(pv, nv)) narr.push(narrate(NARRATION_IDS.voteIntro, true, true));
    if (nv.phase === "prompt" && (newRound(pv, nv) || pv!.phase !== "prompt" || pv!.index !== nv.index)) {
      narr.push(narrate(NARRATION_IDS.votePrompt(nv.candidates[nv.index]), false, true));
    }
    if (entered(pv, nv, "counting")) counter.push({ type: "counter.reset" });
    if (resultEntered && nv.winner) {
      const n = nv.counts[nv.candidates.indexOf(nv.winner)] ?? 0;
      narr.push({ type: "narrate.stop" }); // 남은 투표 안내(보호 클립)가 결과 해설을 밀어내지 않게
      narr.push(narrate(nv.allZero ? NARRATION_IDS.voteNone(nv.winner) : NARRATION_IDS.voteResult(nv.winner, n), true));
      narr.push(narrate(NARRATION_IDS.gu(next.month, nv.winner), false));
      pubVote.push({ type: "publish.vote" });
    }
  }

  return [
    ...rotate, ...layout, ...lift, ...focus, ...hover, ...data, ...counter, ...narr,
    ...(pubState ? [{ type: "publish.state" } as Effect] : []),
    ...(pubStage ? [{ type: "publish.stage" } as Effect] : []),
    ...pubVote,
  ];
}
