// 실시간 메시지 계약 (CONTRACTS 6절 상태, 10.4절 수집 진행).

export interface StateMessage { v: 1; type: "state"; month: string; gu: string | null; metric: "price" | "count"; ts: number; }
/** kind(12.2): 없으면 월 수집. "narration"은 AI 해설 생성. */
export interface JobMessage { v: 1; type: "job"; kind?: "fetch" | "narration"; jobId: string; month: string; state: "running" | "done" | "error"; done: number; total: number; gu?: string; message?: string; ts: number; }
export type ConnStatus = "idle" | "connecting" | "open" | "error" | "closed";

export interface RealtimeClient {
  connect(): Promise<void>;
  subscribe(handler: (msg: StateMessage) => void): () => void;
  /** /seoul/jobs 채널(월 수집 진행). AppSync 구현은 처음 구독할 때 연결한다. 실패해도 화면은 계속 돈다. */
  subscribeJobs(handler: (msg: JobMessage) => void): () => void;
  publish(msg: StateMessage): Promise<void>;
  readonly status: ConnStatus;
  onStatus(cb: (s: ConnStatus) => void): () => void;
  close(): void;
}

export const CHANNEL = "/seoul/state";
export const JOBS_CHANNEL = "/seoul/jobs";

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

const JOB_STATES = new Set(["running", "done", "error"]);
const count = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const optionalString = (x: unknown) => x === undefined || typeof x === "string";

/** 런타임 검사(모양만). 다른 버전이나 손상된 진행 메시지는 false. */
export function isJobMessage(x: unknown): x is JobMessage {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const m = x as Record<string, unknown>;
  return (
    m.v === 1 &&
    m.type === "job" &&
    typeof m.jobId === "string" && m.jobId.length > 0 &&
    typeof m.month === "string" && MONTH.test(m.month) &&
    typeof m.state === "string" && JOB_STATES.has(m.state) &&
    count(m.done) && count(m.total) &&
    optionalString(m.gu) && optionalString(m.message) &&
    (m.kind === undefined || m.kind === "fetch" || m.kind === "narration") &&
    typeof m.ts === "number" && Number.isFinite(m.ts)
  );
}
