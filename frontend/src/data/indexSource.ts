// 지금 쓰는 data/index.json 한 벌. 새 달을 가져오면 refresh()로 바꾸고 구독자(화면)에게 알린다.
import type { DataIndex } from "./types";

export interface IndexSource {
  readonly current: DataIndex;
  /** 다시 읽어 current를 바꾼다. 동시에 여러 번 불러도 요청은 하나. 실패하면 current는 그대로. */
  refresh(): Promise<DataIndex>;
  subscribe(cb: (index: DataIndex) => void): () => void;
}

export function createIndexSource(initial: DataIndex, reload: () => Promise<DataIndex>): IndexSource {
  let current = initial;
  let inflight: Promise<DataIndex> | null = null;
  const subs = new Set<(index: DataIndex) => void>();

  return {
    get current() { return current; },
    refresh() {
      inflight ??= reload()
        .then((next) => {
          current = next;
          for (const cb of [...subs]) cb(next);
          return next;
        })
        .finally(() => { inflight = null; });
      return inflight;
    },
    subscribe(cb) {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
  };
}
