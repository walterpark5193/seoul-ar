// 상태 변화 → 부수 효과 목록. 계약: docs/CONTRACTS-stage.md 3.2. 순수 함수.
import type { Effect, StageState, VoteState } from "./types";

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

export function diffEffects(prev: StageState, next: StageState): Effect[] {
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
      const releaseBack = prev.lifted !== null && next.lifted === null;
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

  if (nv) {
    if (newRound(pv, nv)) narr.push(narrate(NARRATION_IDS.voteIntro, true, true));
    if (nv.phase === "prompt" && (newRound(pv, nv) || pv!.phase !== "prompt" || pv!.index !== nv.index)) {
      narr.push(narrate(NARRATION_IDS.votePrompt(nv.candidates[nv.index]), false, true));
    }
    if (entered(pv, nv, "counting")) counter.push({ type: "counter.reset" });
    if (resultEntered && nv.winner) {
      const n = nv.counts[nv.candidates.indexOf(nv.winner)] ?? 0;
      narr.push(narrate(nv.allZero ? NARRATION_IDS.voteNone(nv.winner) : NARRATION_IDS.voteResult(nv.winner, n), true));
      narr.push(narrate(NARRATION_IDS.gu(next.month, nv.winner), false));
      pubVote.push({ type: "publish.vote" });
    }
  }

  return [
    ...layout, ...lift, ...focus, ...hover, ...data, ...counter, ...narr,
    ...(pubState ? [{ type: "publish.state" } as Effect] : []),
    ...(pubStage ? [{ type: "publish.stage" } as Effect] : []),
    ...pubVote,
  ];
}
