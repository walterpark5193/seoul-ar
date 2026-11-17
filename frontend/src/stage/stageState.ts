// 무대 상태 리듀서 (CONTRACTS-stage 3.1, 설계 5.3). 순수·불변. 시간은 이벤트의 now로만 받는다.
import type { Metric, Stat } from "../data/types";
import { GU_ORDER } from "../data/gu";
import type { InputMode, StageEvent, StageState, VoteMethod, VoteState } from "./types";
import { VOTE_MAX, VOTE_TIMING } from "./types";

type Index = VoteState["index"];
type Triple<T> = [T, T, T];

export function initialStageState(month: string, input: InputMode): StageState {
  return { mode: "map", hover: null, lifted: null, focus: null, input, vote: null, month, metric: "price", round: 0 };
}

/** 결과 화면이 아닌 투표가 있으면 진행 중. 진행 중에는 제스처를 받지 않는다. */
function voting(s: StageState): boolean {
  return s.vote !== null && s.vote.phase !== "result";
}

function setAt<T>(t: Triple<T>, i: Index, value: T): Triple<T> {
  const next: Triple<T> = [t[0], t[1], t[2]];
  next[i] = value;
  return next;
}

function isIndex(i: number): i is Index {
  return i === 0 || i === 1 || i === 2;
}

/**
 * 직접 선택 방식의 counting 대기 시각. 현재 후보의 값을 이미 직접 골랐으면(prompt 중이나 카메라 창 중에 고른 경우)
 * "고르면 1초 뒤 다음"을 그대로 적용하고, 아니면 타이머 없이 선택을 기다린다.
 */
function manualWait(v: VoteState, now: number): number | null {
  return v.sources[v.index] === "manual" ? now + VOTE_TIMING.manualAdvanceMs : null;
}

/** 후보 i의 안내 단계 길이: voteStart가 준 값(최소 VOTE_TIMING.promptMs), 없거나 숫자가 아니면 기본값. */
function promptFor(v: VoteState, i: Index): number {
  const ms = v.promptMs?.[i];
  return ms !== undefined && Number.isFinite(ms) ? Math.max(VOTE_TIMING.promptMs, ms) : VOTE_TIMING.promptMs;
}

/** 다음 후보로, 세 번째 뒤에는 집계 확인으로. */
function advance(v: VoteState, now: number): VoteState {
  if (v.index < 2) {
    const index = (v.index + 1) as Index;
    return { ...v, index, phase: "prompt", endsAt: now + promptFor(v, index) };
  }
  return { ...v, phase: "review", endsAt: now + VOTE_TIMING.reviewMs, reviewEdited: false };
}

/** 확정: 승자를 정하고 지도 배치로 돌아가 승자를 focus. */
function confirm(s: StageState, v: VoteState, now: number): StageState {
  const { winner, allZero } = winnerOf(v);
  return {
    ...s,
    vote: { ...v, phase: "result", winner, allZero, endsAt: now + VOTE_TIMING.resultMs },
    focus: winner, lifted: null, mode: "map",
  };
}

/** 카메라 값 방어: 정수 0~VOTE_MAX로 자르고, 숫자가 아니면 인식 실패(null)로 본다. */
function cleanCameraCount(c: number | null): number | null {
  if (c === null || !Number.isFinite(c)) return null;
  return Math.min(VOTE_MAX, Math.max(0, Math.round(c)));
}

function withVote(s: StageState, vote: VoteState): StageState {
  return { ...s, vote };
}

function tickVote(s: StageState, v: VoteState, now: number, cameraCount: number | null): StageState {
  if (v.endsAt === null || now < v.endsAt) return s;
  switch (v.phase) {
    case "prompt":
      return withVote(s, {
        ...v, phase: "counting",
        endsAt: v.method === "camera" ? now + VOTE_TIMING.countMs : manualWait(v, now),
      });
    case "counting": {
      // 직접 고른 값이 있으면(카메라 창 끝이든 직접 선택 뒤 1초든) 그 값을 유지하고 넘어간다.
      if (v.method === "manual" || v.sources[v.index] === "manual") return withVote(s, advance(v, now));
      const n = cleanCameraCount(cameraCount);
      if (n === null) return withVote(s, { ...v, phase: "awaitManual", endsAt: null });
      return withVote(s, advance({ ...v, counts: setAt(v.counts, v.index, n), sources: setAt(v.sources, v.index, "camera") }, now));
    }
    case "awaitManual":
      return withVote(s, advance(v, now));
    case "review":
      return v.reviewEdited ? s : confirm(s, v, now);
    case "result":
      return { ...s, vote: null };
  }
}

function setVote(s: StageState, v: VoteState, index: number, n: number, now: number): StageState {
  if (!Number.isInteger(n) || n < 0 || n > VOTE_MAX) return s;
  if (!isIndex(index)) return s;
  if (v.phase === "result") return s; // 확정 뒤에는 고치지 않는다(승자·publish와 어긋남).
  if (v.phase !== "review" && index > v.index) return s; // 아직 안 온 후보는 review에서만.
  const next: VoteState = { ...v, counts: setAt(v.counts, index, n), sources: setAt(v.sources, index, "manual") };
  if (v.phase === "review") return withVote(s, { ...next, reviewEdited: true, endsAt: null });
  // 현재 후보를 고른 경우: 선택을 기다리던 중(awaitManual, 직접 선택 counting)이면 1초 뒤 다음으로.
  // prompt 중에는 안내 시간을 그대로 두고 값만 적어 둔다(counting 진입 때 manualWait가 이어받음).
  // 카메라 counting 중에는 창을 그대로 두고, 창이 끝날 때 직접 값이 이긴다.
  if (index === v.index && (v.phase === "awaitManual" || (v.phase === "counting" && v.method === "manual"))) {
    next.endsAt = now + VOTE_TIMING.manualAdvanceMs;
  }
  return withVote(s, next);
}

function changeMethod(v: VoteState, method: VoteMethod, now: number): VoteState {
  if (v.method === method) return v;
  const next: VoteState = { ...v, method };
  if (v.phase === "counting") next.endsAt = method === "camera" ? now + VOTE_TIMING.countMs : manualWait(next, now);
  return next;
}

export function reduceStage(s: StageState, e: StageEvent): StageState {
  switch (e.type) {
    case "hover":
      return s.hover === e.gu ? s : { ...s, hover: e.gu };

    case "grab":
    case "release":
    case "spread":
    case "victory": {
      if (voting(s)) return s;
      // 결과 화면에서 grab·spread·victory가 오면 투표 표시를 지우고 그대로 적용한다.
      const base = s.vote !== null && e.type !== "release" ? { ...s, vote: null } : s;
      switch (e.type) {
        case "grab":
          return base.hover === null ? base : { ...base, lifted: base.hover };
        case "release":
          return base.lifted === null ? base : { ...base, focus: base.lifted, lifted: null, mode: "map" };
        case "spread":
          return base.lifted !== null ? base : { ...base, mode: base.mode === "map" ? "spread" : "map" };
        case "victory":
          return { ...base, focus: null, lifted: null, mode: "map" };
      }
    }

    case "voteStart": {
      if (voting(s)) return s;
      const round = s.round + 1;
      const [a, b, c] = e.candidates;
      const vote: VoteState = {
        round, candidates: [a, b, c], index: 0, phase: "prompt", method: s.input === "mouse" ? "manual" : "camera",
        counts: [null, null, null], sources: [null, null, null], reviewEdited: false, winner: null, allZero: false,
        endsAt: null,
      };
      if (e.promptMs) vote.promptMs = [e.promptMs[0], e.promptMs[1], e.promptMs[2]];
      // 첫 후보 안내는 소개 클립 뒤에 나온다: 소개 길이만큼 더 기다린다.
      const intro = e.introMs !== undefined && Number.isFinite(e.introMs) && e.introMs > 0 ? e.introMs : 0;
      vote.endsAt = e.now + intro + promptFor(vote, 0);
      return { ...s, round, lifted: null, vote };
    }

    case "voteTick":
      return s.vote === null ? s : tickVote(s, s.vote, e.now, e.cameraCount);

    case "voteSet":
      return s.vote === null ? s : setVote(s, s.vote, e.index, e.n, e.now);

    case "voteMethod": {
      if (s.vote === null) return s;
      const v = changeMethod(s.vote, e.method, e.now);
      return v === s.vote ? s : withVote(s, v);
    }

    case "voteConfirm":
      return s.vote !== null && s.vote.phase === "review" ? confirm(s, s.vote, e.now) : s;

    case "voteCancel":
      return s.vote === null ? s : { ...s, vote: null };

    case "setInput": {
      if (s.input === e.input) return s;
      const next: StageState = { ...s, input: e.input };
      if (e.input === "mouse") {
        // 손으로 들고 있던 구는 내려놓는다(focus는 그대로).
        next.lifted = null;
        if (s.vote !== null && voting(s)) next.vote = changeMethod(s.vote, "manual", e.now);
      }
      return next;
    }

    case "month":
      return s.month === e.month ? s : { ...s, month: e.month };

    case "metric":
      return s.metric === e.metric ? s : { ...s, metric: e.metric };
  }
}

/** null은 0표로 본다. 동률이면 후보 순서상 앞선 구. 모두 0이면 첫 후보 + allZero. */
export function winnerOf(v: VoteState): { winner: string; allZero: boolean } {
  const n = v.counts.map((c) => c ?? 0);
  let best = 0;
  for (let i = 1; i < 3; i++) if (n[i]! > n[best]!) best = i;
  return { winner: v.candidates[best]!, allZero: n[best] === 0 };
}

function metricValue(st: Stat | undefined, metric: Metric): number | null {
  if (!st) return null;
  return metric === "price" ? st.medPerM2 : st.n;
}

const ORDER_RANK = new Map<string, number>(GU_ORDER.map((g, i) => [g, i]));
const rankOf = (g: string) => ORDER_RANK.get(g) ?? GU_ORDER.length;

/**
 * 기본 후보: 지표 내림차순(값 null 제외, 동률 GU_ORDER 순) 1위·13위·25위.
 * 유효 구가 25 미만이면 첫째·가운데 floor((k-1)/2)·마지막. 3 미만이면 남은 구를 GU_ORDER 순으로 채워 서로 다른 세 곳을 만든다.
 */
export function defaultCandidates(summary: Record<string, Stat>, metric: Metric, gus: readonly string[]): [string, string, string] {
  const unique = [...new Set(gus)];
  const ranked = unique
    .map((g) => ({ g, v: metricValue(summary[g], metric) }))
    .filter((x): x is { g: string; v: number } => x.v !== null && Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v || rankOf(a.g) - rankOf(b.g))
    .map((x) => x.g);
  const k = ranked.length;
  if (k >= 25) return [ranked[0]!, ranked[12]!, ranked[24]!];
  if (k >= 3) return [ranked[0]!, ranked[Math.floor((k - 1) / 2)]!, ranked[k - 1]!];
  const rest = [...unique].sort((a, b) => rankOf(a) - rankOf(b));
  const pool = [...new Set([...ranked, ...rest, ...GU_ORDER])];
  return [pool[0]!, pool[1]!, pool[2]!];
}

/** "#/stage?vote=강남구,마포구,노원구" → gus 안의 이름만, 중복 제거, 순서 유지. 하나도 없으면 null. */
export function parseVoteParam(hash: string, gus: readonly string[]): string[] | null {
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const raw = new URLSearchParams(hash.slice(q + 1)).get("vote");
  if (raw === null) return null;
  const valid = new Set(gus);
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (valid.has(name) && !out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : null;
}
