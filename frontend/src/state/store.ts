// 앱 상태와 리듀서 (CONTRACTS 8절).
import type { DataIndex, Metric } from "../data/types";
import type { ConnStatus, StateMessage } from "../realtime/types";

export interface AppState { month: string; gu: string | null; metric: Metric; follow: boolean; conn: ConnStatus; }
export type Action =
  | { type: "remote"; msg: StateMessage }
  | { type: "local"; month?: string; gu?: string | null; metric?: Metric }
  | { type: "follow" }
  | { type: "conn"; status: ConnStatus };

/** month는 인덱스를 읽기 전이라 비어 있다. 인덱스를 읽은 뒤 initialStateFor로 채운다. */
export const INITIAL_STATE: AppState = Object.freeze({ month: "", gu: null, metric: "price", follow: true, conn: "idle" });

export function initialStateFor(index: Pick<DataIndex, "months">): AppState {
  return { ...INITIAL_STATE, month: index.months.at(-1) ?? "" };
}

export function reduce(state: AppState, action: Action, lastRemote: StateMessage | null): AppState {
  switch (action.type) {
    case "remote": {
      if (!state.follow) return state;
      if (lastRemote && action.msg.ts < lastRemote.ts) return state;
      const { month, gu, metric } = action.msg;
      return { ...state, month, gu, metric };
    }
    case "local": {
      const next: AppState = { ...state, follow: false };
      if (action.month !== undefined) next.month = action.month;
      if (action.gu !== undefined) next.gu = action.gu;
      if (action.metric !== undefined) next.metric = action.metric;
      return next;
    }
    case "follow": {
      if (!lastRemote) return { ...state, follow: true };
      const { month, gu, metric } = lastRemote;
      return { ...state, follow: true, month, gu, metric };
    }
    case "conn":
      return { ...state, conn: action.status };
  }
}

export function sameState(a: AppState, b: AppState): boolean {
  return a.month === b.month && a.gu === b.gu && a.metric === b.metric && a.follow === b.follow && a.conn === b.conn;
}

export interface Store {
  getState(): AppState;
  dispatch(action: Action): void;
  subscribe(fn: (state: AppState, prev: AppState) => void): () => void;
}

export function createStore(initial: AppState = INITIAL_STATE): Store {
  let state = initial;
  let lastRemote: StateMessage | null = null;
  const subs = new Set<(state: AppState, prev: AppState) => void>();

  return {
    getState: () => state,
    dispatch(action) {
      const prev = state;
      state = reduce(state, action, lastRemote);
      // 따라가지 않는 동안 받은 원격 상태도 기억해 두었다가 "라이브로 돌아가기"에서 복원한다.
      if (action.type === "remote" && (!lastRemote || action.msg.ts >= lastRemote.ts)) lastRemote = action.msg;
      if (sameState(prev, state)) { state = prev; return; }
      for (const fn of [...subs]) fn(state, prev);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}
