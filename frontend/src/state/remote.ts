// 뷰어로 들어오는 원격 상태의 관문. isStateMessage(모양 검사)를 통과한 메시지라도
// 인덱스에 없는 월·구이거나 ts가 30초 넘게 미래면 버린다. 미래 ts를 lastRemote로 받아 두면
// 그 뒤의 정상 발표자 메시지가 전부 "오래된 것"으로 보이기 때문이다(위조 방어).
import type { DataIndex } from "../data/types";
import type { RealtimeClient, StateMessage } from "../realtime/types";
import type { Store } from "./store";

export const MAX_FUTURE_MS = 30_000;

export function acceptRemote(msg: StateMessage, index: Pick<DataIndex, "months" | "gus">, now: number): boolean {
  if (msg.ts > now + MAX_FUTURE_MS) return false;
  if (!index.months.includes(msg.month)) return false;
  if (msg.gu !== null && !index.gus.includes(msg.gu)) return false;
  return true;
}

export interface BindRemoteOptions {
  realtime: RealtimeClient;
  store: Store;
  index: Pick<DataIndex, "months" | "gus">;
  /** 발표자 화면에서는 원격 상태를 반영하지 않는다. */
  isHost(): boolean;
  now?: () => number;
}

export function bindRemote(o: BindRemoteOptions): () => void {
  const now = o.now ?? Date.now;
  return o.realtime.subscribe((msg) => {
    if (o.isHost()) return;
    if (!acceptRemote(msg, o.index, now())) {
      console.warn("[realtime] 인덱스와 맞지 않거나 미래 시각인 원격 상태를 버림", msg);
      return;
    }
    o.store.dispatch({ type: "remote", msg });
  });
}
