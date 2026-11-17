// AWS AppSync Events 실시간 클라이언트 (CONTRACTS 6절). 채널 /seoul/state.
// 구독은 WebSocket, 발행은 HTTP(events.post)라서 소켓이 막혀도 발행은 시도할 수 있다.
import { Amplify } from "aws-amplify";
import { events, type EventsChannel } from "aws-amplify/data";
import type { EventsConfig } from "../config";
import { CHANNEL, isStateMessage, type ConnStatus, type RealtimeClient, type StateMessage } from "./types";

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
function extract(d: unknown): StateMessage | null {
  const ev = (d as { event?: unknown } | null)?.event;
  let value = ev;
  if (typeof ev === "string") {
    try { value = JSON.parse(ev); } catch { return null; }
  }
  return isStateMessage(value) ? value : null;
}

export function createAppSyncRealtime(cfg: EventsConfig): RealtimeClient {
  Amplify.configure({
    API: { Events: { endpoint: cfg.httpEndpoint, region: cfg.region, defaultAuthMode: "apiKey", apiKey: cfg.apiKey } },
  });

  const handlers = new Set<(msg: StateMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  let status: ConnStatus = "idle";
  let channel: EventsChannel | null = null;
  let sub: { unsubscribe(): void } | null = null;
  let closed = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: ConnStatus) => {
    if (s === status) return;
    status = s;
    for (const cb of [...statusSubs]) cb(s);
  };

  const teardown = () => {
    try { sub?.unsubscribe(); } catch { /* 이미 닫힘 */ }
    try { channel?.close(); } catch { /* 이미 닫힘 */ }
    sub = null;
    channel = null;
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open().catch(() => scheduleRetry());
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  async function open(): Promise<void> {
    teardown();
    setStatus("connecting");
    try {
      const ch = await withTimeout(events.connect(CHANNEL), CONNECT_TIMEOUT_MS, "events.connect");
      channel = ch;
      const s = ch.subscribe({
        next: (d: unknown) => {
          const msg = extract(d);
          if (!msg) return;
          for (const h of [...handlers]) h(msg);
        },
        error: (err: unknown) => {
          console.warn("[realtime] 구독 오류", err);
          if (closed) return;
          setStatus("error");
          scheduleRetry();
        },
      });
      sub = s;
      await withTimeout(s.ready, CONNECT_TIMEOUT_MS, "subscribe");
      retryMs = RETRY_MIN_MS;
      setStatus("open");
    } catch (err) {
      teardown();
      if (!closed) setStatus("error");
      throw err;
    }
  }

  return {
    get status() { return status; },
    connect: () => {
      closed = false;
      return open();
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
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
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      teardown();
      setStatus("closed");
    },
  };
}
