import { VOTE_MAX } from "../types";

export interface VoteCounter {
  push(tMs: number, handCount: number): void;
  result(): number | null;
  reset(): void;
}

/** 이 시간 이하로 끼어든 다른 값(손 하나가 한두 프레임 빠짐 등)은 구간을 끊지 않는다. */
export const VOTE_BLIP_MS = 120;

/**
 * 같은 손 개수가 stableMs 이상 이어진 구간들 중 최댓값(상한 max). 없으면 null.
 * 구간 사이에 다른 값이 VOTE_BLIP_MS 이하로 끼었다가 원래 값으로 돌아오면 같은 구간으로 이어 본다.
 * 단, 끼어들기 직전에 원래 값이 VOTE_BLIP_MS 이상 이어져 있었어야 한다(두 값이 번갈아 튀는 깜박임은 이어 주지 않는다).
 * 끼어든 값 자체는 VOTE_BLIP_MS < stableMs라 구간이 되지 못한다(순간 최댓값 금지 유지).
 */
export function createVoteCounter(opts: { stableMs?: number; max?: number; blipMs?: number } = {}): VoteCounter {
  const stableMs = opts.stableMs ?? 500;
  const max = opts.max ?? VOTE_MAX;
  const blipMs = opts.blipMs ?? VOTE_BLIP_MS;
  let cur: number | null = null;
  let start = 0;     // 현재 구간 시작
  let last = 0;      // 현재 값을 마지막으로 본 시각
  let runStart = 0;  // 마지막 끼어들기 뒤 현재 값이 다시 시작된 시각
  // 현재 값과 다른 값이 이어지는 중: firstOff는 끼어들기 시작, n·start·last는 그중 가장 최근 값의 구간
  let off: { firstOff: number; n: number; start: number; last: number } | null = null;
  let best: number | null = null;

  const closeSeg = (n: number | null, from: number, to: number) => {
    if (n !== null && to - from >= stableMs && (best === null || n > best)) best = n;
  };
  const begin = (n: number, t: number) => { cur = n; start = runStart = last = t; off = null; };
  /** 끼어든 값이 진짜 바뀐 것: 현재 구간을 닫고 그 값의 구간을 시작한다. */
  const commit = (t: number) => {
    const o = off!;
    closeSeg(cur, start, last);
    cur = o.n; start = runStart = o.start; last = t; off = null;
  };

  return {
    push(tMs, handCount) {
      const n = Math.min(Math.max(0, Math.floor(handCount)), max);
      if (cur === null) { begin(n, tMs); return; }
      if (n === cur) {
        if (off) {
          const bridged = tMs - off.firstOff <= blipMs && last - runStart >= blipMs;
          if (!bridged) {
            // 다음 프레임이 늦게 와서 끼어든 값이 얼마나 이어졌는지 모른다: 끊는다.
            closeSeg(cur, start, last);
            closeSeg(off.n, off.start, off.last);
            begin(n, tMs);
            return;
          }
          off = null;
          runStart = tMs;
        }
        last = tMs;
        return;
      }
      if (!off) off = { firstOff: tMs, n, start: tMs, last: tMs };
      else if (off.n !== n) { off.n = n; off.start = tMs; off.last = tMs; }
      else off.last = tMs;
      if (tMs - off.firstOff > blipMs || last - runStart < blipMs) commit(tMs);
    },
    result() {
      const saved = best;
      closeSeg(cur, start, last);
      if (off) closeSeg(off.n, off.start, off.last);
      const r = best;
      best = saved;
      return r;
    },
    reset() {
      cur = null;
      off = null;
      best = null;
      start = last = runStart = 0;
    },
  };
}
