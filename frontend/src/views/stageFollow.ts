// 관객 폰이 무대(발표 화면)의 펼침·들어올림·투표 결과를 따라가게 하는 순수 모듈 (CONTRACTS-stage 10절).
import type { DataIndex } from "../data/types";
import type { Store } from "../state/store";
import type { StageChannel } from "../stage/net/stageChannel";
import { isStageMessage, isVoteMessage, type StageMessage, type VoteMessage } from "../stage/net/messages";
import type { StageMode } from "../stage/types";

export interface StageFollowOptions {
  channel: StageChannel; store: Store; index: DataIndex;
  onLayout(mode: StageMode): void; onLift(gu: string | null): void; onVote(text: string): void;
}

/** "투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표" */
export function voteLine(m: VoteMessage): string {
  const parts = m.candidates.map((gu, i) => `${gu} ${m.counts[i] ?? 0}표`);
  return `투표 결과 ${parts.join(" · ")}`;
}

/** follow가 true일 때만 onLayout/onLift. 투표 결과는 follow와 무관하게 onVote. */
export function bindStageFollow(o: StageFollowOptions): () => void {
  let last: StageMessage | null = null;
  const apply = (m: StageMessage) => {
    o.onLayout(m.mode);
    o.onLift(m.lifted);
  };
  const offMsg = o.channel.subscribe((m) => {
    if (isStageMessage(m)) {
      last = m;
      if (o.store.getState().follow) apply(m);
    } else if (isVoteMessage(m)) {
      if (m.phase === "result") o.onVote(voteLine(m));
    }
    // 그 밖의 메시지는 무시한다.
  });
  // 따라가기를 다시 켜면 마지막으로 받은 무대 상태로 맞춘다.
  const offStore = o.store.subscribe((s, prev) => {
    if (s.follow && !prev.follow && last) apply(last);
  });
  return () => { offMsg(); offStore(); };
}
