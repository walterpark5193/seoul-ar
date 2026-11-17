import { VOTE_MAX } from "../types";

export interface VoteCounter {
  push(tMs: number, handCount: number): void;
  result(): number | null;
  reset(): void;
}

/** 같은 손 개수가 stableMs 이상 이어진 구간들 중 최댓값(상한 max). 없으면 null. */
export function createVoteCounter(opts: { stableMs?: number; max?: number } = {}): VoteCounter {
  const stableMs = opts.stableMs ?? 500;
  const max = opts.max ?? VOTE_MAX;
  let cur: number | null = null;
  let start = 0;
  let last = 0;
  let best: number | null = null;

  const close = () => {
    if (cur !== null && last - start >= stableMs && (best === null || cur > best)) best = cur;
  };

  return {
    push(tMs, handCount) {
      const n = Math.min(Math.max(0, Math.floor(handCount)), max);
      if (n !== cur) {
        close();
        cur = n;
        start = tMs;
      }
      last = tMs;
    },
    result() {
      const saved = best;
      close();
      const r = best;
      best = saved;
      return r;
    },
    reset() {
      cur = null;
      best = null;
      start = 0;
      last = 0;
    },
  };
}
