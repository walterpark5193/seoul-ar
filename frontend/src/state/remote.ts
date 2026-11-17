// 뷰어로 들어오는 원격 상태의 관문. isStateMessage(모양 검사)를 통과한 메시지라도
// 인덱스에 없는 월·구이거나 ts가 30초 넘게 미래면 버린다. 미래 ts를 lastRemote로 받아 두면
// 그 뒤의 정상 발표자 메시지가 전부 "오래된 것"으로 보이기 때문이다(위조 방어).
// 모르는 달이면(발표자가 방금 가져온 달일 수 있다, CONTRACTS 10.5) index를 한 번 다시 읽고 다시 판단한다(같은 달은 30초에 한 번).
import { inFetchRange } from "../data/months";
import type { DataIndex } from "../data/types";
import type { RealtimeClient, StateMessage } from "../realtime/types";
import type { Store } from "./store";

export const MAX_FUTURE_MS = 30_000;
/** 같은 달은 이 시간 안에 다시 읽지 않는다. 위조 메시지가 그 달의 기회를 영영 써 버리지 않게 기한을 둔다. */
export const REFRESH_RETRY_MS = 30_000;

type IndexLike = Pick<DataIndex, "months" | "gus">;

export function acceptRemote(msg: StateMessage, index: IndexLike, now: number): boolean {
  if (msg.ts > now + MAX_FUTURE_MS) return false;
  if (!index.months.includes(msg.month)) return false;
  if (msg.gu !== null && !index.gus.includes(msg.gu)) return false;
  return true;
}

export interface BindRemoteOptions {
  realtime: RealtimeClient;
  store: Store;
  /** 지금 쓰는 index(새로 읽으면 바뀐다). */
  index(): IndexLike;
  /** 모르는 달을 만났을 때 index를 no-store로 다시 읽는다. 없으면 그냥 버린다. */
  refreshIndex?(): Promise<unknown>;
  /** 발표자 화면에서는 원격 상태를 반영하지 않는다. */
  isHost(): boolean;
  now?: () => number;
}

export function bindRemote(o: BindRemoteOptions): () => void {
  const now = o.now ?? Date.now;
  const tried = new Map<string, number>(); // 달 → 마지막으로 다시 읽은 시각(위조 메시지로 index를 계속 읽게 하지 못하게)
  const drop = (msg: StateMessage) => console.warn("[realtime] 인덱스와 맞지 않거나 미래 시각인 원격 상태를 버림", msg);
  const apply = (msg: StateMessage): boolean => {
    if (!acceptRemote(msg, o.index(), now())) return false;
    o.store.dispatch({ type: "remote", msg });
    return true;
  };

  return o.realtime.subscribe((msg) => {
    if (o.isHost()) return;
    if (apply(msg)) return;
    const refreshable = o.refreshIndex !== undefined &&
      msg.ts <= now() + MAX_FUTURE_MS &&
      !o.index().months.includes(msg.month) &&
      inFetchRange(msg.month, now()) &&
      now() - (tried.get(msg.month) ?? -Infinity) >= REFRESH_RETRY_MS;
    if (!refreshable) { drop(msg); return; }
    tried.set(msg.month, now());
    o.refreshIndex!().then(
      () => { if (!o.isHost() && !apply(msg)) drop(msg); },
      (err: unknown) => { console.warn("[data] index를 다시 읽지 못함", err); },
    );
  });
}
