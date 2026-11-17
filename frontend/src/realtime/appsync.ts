// AWS AppSync Events 실시간 클라이언트 (CONTRACTS 6절 /seoul/state, 10.4절 /seoul/jobs).
// 구독은 WebSocket, 발행은 HTTP(events.post)라서 소켓이 막혀도 발행은 시도할 수 있다.
// 채널마다 같은 규율을 쓴다: 연결 시간 제한, 세대 번호로 늦은 콜백 무시, 실패하면(첫 시도 포함) 백오프 재연결.
// 상태 채널의 연결 상태만 onStatus로 알린다. jobs 채널은 처음 subscribeJobs 할 때 열고, 실패해도 조용히 재시도만 한다.
import { Amplify } from "aws-amplify";
import { events, type EventsChannel } from "aws-amplify/data";
import type { EventsConfig } from "../config";
import {
  CHANNEL, JOBS_CHANNEL, isJobMessage, isStateMessage,
  type ConnStatus, type JobMessage, type RealtimeClient, type StateMessage,
} from "./types";

const CONNECT_TIMEOUT_MS = 8000;
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 30000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: ${ms}ms 안에 응답 없음`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 이벤트 본문은 Amplify가 이미 JSON.parse 해서 d.event로 준다. 문자열이면 한 번 더 풀어 본다. */
function payload(d: unknown): unknown {
  const ev = (d as { event?: unknown } | null)?.event;
  if (typeof ev !== "string") return ev;
  try { return JSON.parse(ev); } catch { return null; }
}

interface Link {
  connect(): Promise<void>;
  close(): void;
}

/** 채널 하나의 연결 수명. onValue에는 검증 전 본문이 간다. */
function openLink(path: string, onValue: (value: unknown) => void, onStatus: (s: ConnStatus) => void): Link {
  let channel: EventsChannel | null = null;
  let sub: { unsubscribe(): void } | null = null;
  let closed = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // 연결 시도마다 1씩 올린다. 이전 시도의 늦은 콜백(오류, 데이터, 늦게 열린 채널)은 세대가 달라 무시된다.
  let gen = 0;

  const teardown = () => {
    try { sub?.unsubscribe(); } catch { /* 이미 닫힘 */ }
    try { channel?.close(); } catch { /* 이미 닫힘 */ }
    sub = null;
    channel = null;
  };

  const clearRetry = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };

  /** 백오프 재시도는 언제나 하나만 돈다(첫 연결 실패, 시간 초과, 구독 오류가 모두 여기로 온다). */
  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open().catch(() => { /* open이 실패하면 스스로 다음 재시도를 건다 */ });
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const fail = (mine: number) => {
    if (mine !== gen || closed) return;
    teardown();
    onStatus("error");
    scheduleRetry();
  };

  async function open(): Promise<void> {
    const mine = ++gen;
    teardown();
    onStatus("connecting");
    const pending = events.connect(path);
    try {
      const ch = await withTimeout(pending, CONNECT_TIMEOUT_MS, "events.connect").catch((err: unknown) => {
        // 시간 초과 뒤에 늦게 열린 채널은 받아들이지 않고 닫는다(소켓 누수 방지).
        pending.then((late) => late.close(), () => {});
        throw err;
      });
      if (mine !== gen) { ch.close(); return; } // 기다리는 사이 close()나 새 시도가 있었다
      channel = ch;
      const s = ch.subscribe({
        next: (d: unknown) => { if (mine === gen) onValue(payload(d)); },
        error: (err: unknown) => {
          if (mine !== gen) return;
          console.warn(`[realtime] ${path} 구독 오류`, err);
          fail(mine);
        },
      });
      sub = s;
      await withTimeout(s.ready, CONNECT_TIMEOUT_MS, "subscribe");
      if (mine !== gen) return;
      retryMs = RETRY_MIN_MS;
      onStatus("open");
    } catch (err) {
      fail(mine);
      throw err;
    }
  }

  return {
    connect() {
      closed = false;
      clearRetry();
      return open();
    },
    close() {
      closed = true;
      gen++;
      clearRetry();
      teardown();
    },
  };
}

export function createAppSyncRealtime(cfg: EventsConfig): RealtimeClient {
  Amplify.configure({
    API: { Events: { endpoint: cfg.httpEndpoint, region: cfg.region, defaultAuthMode: "apiKey", apiKey: cfg.apiKey } },
  });

  const handlers = new Set<(msg: StateMessage) => void>();
  const jobHandlers = new Set<(msg: JobMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  let status: ConnStatus = "idle";
  let closed = false;

  const setStatus = (s: ConnStatus) => {
    if (closed || s === status) return;
    status = s;
    for (const cb of [...statusSubs]) cb(s);
  };

  const stateLink = openLink(CHANNEL, (v) => {
    if (!isStateMessage(v)) return;
    for (const h of [...handlers]) h(v);
  }, setStatus);

  let jobsLink: Link | null = null;
  const ensureJobs = () => {
    if (jobsLink || closed) return;
    jobsLink = openLink(JOBS_CHANNEL, (v) => {
      if (!isJobMessage(v)) return;
      for (const h of [...jobHandlers]) h(v);
    }, (s) => { if (s === "error") console.warn("[realtime] 수집 진행 채널 연결 실패, 재시도합니다"); });
    jobsLink.connect().catch(() => { /* 링크가 스스로 재시도한다. 화면은 계속 그린다 */ });
  };

  return {
    get status() { return status; },
    connect: () => {
      closed = false;
      return stateLink.connect();
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    subscribeJobs(handler) {
      jobHandlers.add(handler);
      ensureJobs();
      return () => { jobHandlers.delete(handler); };
    },
    async publish(msg) {
      const failed = await events.post(CHANNEL, { ...msg });
      if (Array.isArray(failed) && failed.length > 0) throw new Error("AppSync가 이벤트 발행을 거부했습니다");
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => { statusSubs.delete(cb); };
    },
    close() {
      stateLink.close();
      jobsLink?.close();
      jobsLink = null;
      setStatus("closed");
      closed = true;
    },
  };
}
