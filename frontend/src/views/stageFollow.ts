// 관객 폰이 무대(발표 화면)의 펼침·들어올림·투표 결과를 따라가게 하는 순수 모듈 (CONTRACTS-stage 10절).
import type { DataIndex, Metric, Stat } from "../data/types";
import type { SeoulScene } from "../scene/seoulScene";
import type { Store } from "../state/store";
import type { StageChannel } from "../stage/net/stageChannel";
import { isStageMessage, isVoteMessage, type StageMessage, type VoteMessage } from "../stage/net/messages";
import type { StageMode } from "../stage/types";

export interface StageFollowOptions {
  channel: StageChannel; store: Store; index: DataIndex;
  onLayout(mode: StageMode): void; onLift(gu: string | null): void; onVote(text: string): void;
  /** 무대가 살아 있는지. StageMessage를 받으면 true, STAGE_STALE_MS 동안 소식이 없으면 false(arView 배너). */
  onStage?(active: boolean): void;
  /** 따라가는 중 StageMessage가 오면 그 yaw·zoom(없으면 0, 1). 따라가기를 끄거나 무대가 사라지면 (0, 1). 큰 화면만 쓴다. */
  onView?(yaw: number, zoom: number): void;
}

/** 무대 하트비트(10초)의 3배. 이 시간 동안 StageMessage가 없으면 무대가 떠난 것으로 본다. */
export const STAGE_STALE_MS = 30_000;

/** 펼치기 배치 지표. 무대 해설("㎡당 가격순으로 펼쳤습니다")이 늘 참이도록 지표와 무관하게 price다. 막대 색·시트는 현재 지표 그대로. */
export const SPREAD_METRIC: Metric = "price";

const EMPTY_SUMMARY: Record<string, Stat> = Object.freeze({}) as Record<string, Stat>;

/** 따라가는 폰의 배치. 요약이 없는 달이면 늘 같은 빈 요약을 넘겨 setLayout의 같은 참조 조기 반환이 듣게 한다. */
export function followLayout(city: Pick<SeoulScene, "setLayout">, index: DataIndex, month: string, mode: StageMode): void {
  city.setLayout(mode, index.summary[month] ?? EMPTY_SUMMARY, SPREAD_METRIC);
}

/** "투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표" */
export function voteLine(m: VoteMessage): string {
  const parts = m.candidates.map((gu, i) => `${gu} ${m.counts[i] ?? 0}표`);
  return `투표 결과 ${parts.join(" · ")}`;
}

/**
 * follow가 true일 때만 onLayout/onLift. 투표 결과는 follow와 무관하게 onVote.
 * 무대 탭이 닫히거나 노트북이 잠들어 STAGE_STALE_MS 동안 StageMessage가 없으면 지도·들어올림 없음으로 되돌리고
 * 마지막 무대 상태를 잊는다(따라가기를 다시 켜도 낡은 펼침이 돌아오지 않게).
 */
export function bindStageFollow(o: StageFollowOptions): () => void {
  let last: StageMessage | null = null;
  let applied = false;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const apply = (m: StageMessage) => {
    applied = true;
    o.onLayout(m.mode);
    o.onLift(m.lifted);
    o.onView?.(m.yaw ?? 0, m.zoom ?? 1);
  };
  const expire = () => {
    staleTimer = null;
    last = null;
    if (applied && o.store.getState().follow) {
      o.onLayout("map");
      o.onLift(null);
      o.onView?.(0, 1);
    }
    applied = false;
    o.onStage?.(false);
  };
  const offMsg = o.channel.subscribe((m) => {
    if (isStageMessage(m)) {
      last = m;
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(expire, STAGE_STALE_MS);
      o.onStage?.(true);
      if (o.store.getState().follow) apply(m);
    } else if (isVoteMessage(m)) {
      if (m.phase === "result") o.onVote(voteLine(m));
    }
    // 그 밖의 메시지는 무시한다.
  });
  // 따라가기를 다시 켜면 마지막으로 받은 무대 상태로 맞춘다.
  const offStore = o.store.subscribe((s, prev) => {
    if (prev.follow && !s.follow) {
      // 따라가기를 끄면 폰 자기 화면으로 돌아간다. 낡은 펼침이 남지 않게 한다.
      applied = false;
      o.onLayout("map");
      o.onLift(null);
      o.onView?.(0, 1);
      return;
    }
    if (!s.follow || !last) return;
    if (!prev.follow) apply(last);
    // 따라가는 중 월이 바뀌면 순위·높이가 새 달 값에 맞도록 배치를 다시 계산한다.
    // 펼치기는 늘 ㎡당 가격순이라 지표만 바뀌면 배치는 그대로다.
    else if (applied && s.month !== prev.month) o.onLayout(last.mode);
  });
  return () => {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    offMsg();
    offStore();
  };
}

export const VOTE_LINE_MS = 6000;

/** 투표 결과 한 줄을 6초 보였다가 숨기는 공용 표시기. orbitView와 arView가 함께 쓴다. */
export function createVoteLine(el: HTMLElement): { show(text: string): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    show(text) {
      el.textContent = text;
      el.hidden = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { el.hidden = true; }, VOTE_LINE_MS);
    },
    dispose() { if (timer) clearTimeout(timer); timer = null; },
  };
}
