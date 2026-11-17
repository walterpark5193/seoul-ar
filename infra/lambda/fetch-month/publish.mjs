// AppSync Events 로 작업 진행을 알린다 (CONTRACTS 10.4).
// HTTP 발행: POST {EVENTS_HTTP_ENDPOINT}, 헤더 x-api-key, 본문 {"channel": "/seoul/jobs", "events": ["<JobMessage JSON 문자열>"]}.

export const JOBS_CHANNEL = "/seoul/jobs";
const TIMEOUT_MS = 5_000;

/**
 * JobMessage: { v: 1, type: "job", kind?, jobId, month, state, done, total, gu?, message?, ts }.
 * kind(12.2): 없으면 월 수집, "narration" 은 AI 해설.
 * 브라우저 isJobMessage 가 그대로 받도록 숫자는 숫자로, 선택 필드는 값이 있을 때만 넣는다.
 */
export function jobMessage({ kind, jobId, month, state, done, total, gu, message, ts }) {
  const msg = { v: 1, type: "job" };
  if (kind !== undefined) msg.kind = kind;
  Object.assign(msg, { jobId, month, state, done, total });
  if (gu !== undefined) msg.gu = gu;
  if (message !== undefined) msg.message = message;
  msg.ts = ts;
  return msg;
}

/** fetch 로 AppSync Events HTTP 엔드포인트에 한 건 발행하는 함수를 만든다. 오류 메시지에 키·URL 을 넣지 않는다. */
export function createPublisher({ fetch, endpoint, apiKey, channel = JOBS_CHANNEL, timeoutMs = TIMEOUT_MS }) {
  return async function publish(msg) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ channel, events: [JSON.stringify(msg)] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("AppSync 발행 실패 (연결)");
    }
    if (!res.ok) throw new Error(`AppSync 발행 실패 (HTTP ${Number(res.status) || 0})`);
    let out = null;
    try {
      out = await res.json();
    } catch {
      // 본문이 없어도 2xx 면 성공으로 본다
    }
    if (out && Array.isArray(out.failed) && out.failed.length > 0) throw new Error("AppSync 발행 실패 (거부된 이벤트)");
  };
}

/**
 * 진행 보고: 발행과 작업 기록을 보낸 순서대로 하나씩 처리한다(동시에 돌아도 done 순서가 뒤집히지 않게).
 * 둘 다 최선 노력이다. 실패는 warn 로그만 남기고 작업은 계속한다(폴링 기록이 발행 실패를 메운다).
 */
export function createReporter({ publish, record, log }) {
  let chain = Promise.resolve();
  return function report(msg) {
    chain = chain.then(async () => {
      const [p, r] = await Promise.allSettled([publish(msg), record(msg)]);
      if (p.status === "rejected") log("warn", "진행 이벤트 발행 실패", { reason: String(p.reason?.message ?? p.reason) });
      if (r.status === "rejected") log("warn", "작업 기록 쓰기 실패", { reason: String(r.reason?.name ?? r.reason) });
    });
    return chain;
  };
}
