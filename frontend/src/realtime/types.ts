// 실시간 상태 메시지 계약 (CONTRACTS 6절).

export interface StateMessage { v: 1; type: "state"; month: string; gu: string | null; metric: "price" | "count"; ts: number; }
export type ConnStatus = "idle" | "connecting" | "open" | "error" | "closed";

export interface RealtimeClient {
  connect(): Promise<void>;
  subscribe(handler: (msg: StateMessage) => void): () => void;
  publish(msg: StateMessage): Promise<void>;
  readonly status: ConnStatus;
  onStatus(cb: (s: ConnStatus) => void): () => void;
  close(): void;
}

export const CHANNEL = "/seoul/state";

const MONTH = /^\d{6}$/;

/** 런타임 검사. 손상되었거나 다른 버전인 메시지는 false. */
export function isStateMessage(x: unknown): x is StateMessage {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const m = x as Record<string, unknown>;
  return (
    m.v === 1 &&
    m.type === "state" &&
    typeof m.month === "string" && MONTH.test(m.month) &&
    (m.gu === null || (typeof m.gu === "string" && m.gu.length > 0)) &&
    (m.metric === "price" || m.metric === "count") &&
    typeof m.ts === "number" && Number.isFinite(m.ts)
  );
}
