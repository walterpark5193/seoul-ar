// 무대 채널 (CONTRACTS-stage 4.2). 채널 /seoul/stage. 구조는 realtime/appsync.ts와 같다.
import { Amplify } from "aws-amplify";
import { events, type EventsChannel } from "aws-amplify/data";
import type { EventsConfig } from "../../config";
import type { BroadcastLike } from "../../realtime/mock";
import type { ConnStatus } from "../../realtime/types";
import { STAGE_CHANNEL, isStageChannelMessage, toWire, type StageChannelMessage } from "./messages";

const CONNECT_TIMEOUT_MS = 8000;
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 30000;

export interface StageChannel {
  connect(): Promise<void>;
  subscribe(h: (m: StageChannelMessage) => void): () => void;
  publish(m: StageChannelMessage): Promise<void>;
  readonly status: ConnStatus;
  onStatus(cb: (s: ConnStatus) => void): () => void;
  close(): void;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: ${ms}ms 안에 응답 없음`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function extract(d: unknown): StageChannelMessage | null {
  const ev = (d as { event?: unknown } | null)?.event;
  let value = ev;
  if (typeof ev === "string") {
    try { value = JSON.parse(ev); } catch { return null; }
  }
  return isStageChannelMessage(value) ? value : null;
}

/** 구독자 집합과 상태 알림을 공유하는 뼈대. */
function makeCore() {
  const handlers = new Set<(m: StageChannelMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  let status: ConnStatus = "idle";
  return {
    get status() { return status; },
    setStatus(s: ConnStatus) {
      if (s === status) return;
      status = s;
      for (const cb of [...statusSubs]) cb(s);
    },
    deliver(m: StageChannelMessage) { for (const h of [...handlers]) h(m); },
    subscribe(h: (m: StageChannelMessage) => void) { handlers.add(h); return () => { handlers.delete(h); }; },
    onStatus(cb: (s: ConnStatus) => void) { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; },
  };
}

export function createAppSyncStageChannel(cfg: EventsConfig): StageChannel {
  Amplify.configure({
    API: { Events: { endpoint: cfg.httpEndpoint, region: cfg.region, defaultAuthMode: "apiKey", apiKey: cfg.apiKey } },
  });

  const core = makeCore();
  let channel: EventsChannel | null = null;
  let sub: { unsubscribe(): void } | null = null;
  let closed = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
    core.setStatus("connecting");
    try {
      const ch = await withTimeout(events.connect(STAGE_CHANNEL), CONNECT_TIMEOUT_MS, "events.connect");
      channel = ch;
      const s = ch.subscribe({
        next: (d: unknown) => {
          const msg = extract(d);
          if (msg) core.deliver(msg);
        },
        error: (err: unknown) => {
          console.warn("[stage] 구독 오류", err);
          if (closed) return;
          core.setStatus("error");
          scheduleRetry();
        },
      });
      sub = s;
      await withTimeout(s.ready, CONNECT_TIMEOUT_MS, "subscribe");
      if (closed) { teardown(); return; }
      retryMs = RETRY_MIN_MS;
      core.setStatus("open");
    } catch (err) {
      teardown();
      if (!closed) core.setStatus("error");
      throw err;
    }
  }

  return {
    get status() { return core.status; },
    connect: () => { closed = false; return open(); },
    subscribe: core.subscribe,
    async publish(msg) {
      const wire = toWire(msg);
      const failed = await events.post(STAGE_CHANNEL, { ...wire });
      if (Array.isArray(failed) && failed.length > 0) throw new Error("AppSync가 이벤트 발행을 거부했습니다");
    },
    onStatus: core.onStatus,
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      teardown();
      core.setStatus("closed");
    },
  };
}

function defaultChannel(): BroadcastLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const bc = new BroadcastChannel("seoul-ar-stage");
  const like: BroadcastLike = {
    onmessage: null,
    postMessage: (data) => bc.postMessage(data),
    close: () => bc.close(),
  };
  bc.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  return like;
}

export function createMockStageChannel(opts: { channel?: () => BroadcastLike | null } = {}): StageChannel {
  const makeChannel = opts.channel ?? defaultChannel;
  const core = makeCore();
  let channel: BroadcastLike | null = null;

  return {
    get status() { return core.status; },
    async connect() {
      if (core.status === "open") return;
      channel = makeChannel();
      if (channel) channel.onmessage = (ev) => { if (isStageChannelMessage(ev.data)) core.deliver(ev.data); };
      core.setStatus("open");
    },
    subscribe: core.subscribe,
    async publish(msg) {
      const wire = toWire(msg);
      core.deliver(wire);
      channel?.postMessage(wire);
    },
    onStatus: core.onStatus,
    close() {
      if (channel) { channel.onmessage = null; channel.close(); channel = null; }
      core.setStatus("closed");
    },
  };
}

export function makeStageChannel(events: EventsConfig | null): StageChannel {
  if (!events) return createMockStageChannel();
  try {
    return createAppSyncStageChannel(events);
  } catch (err) {
    console.warn("[stage] AppSync 채널 생성 실패, 모의 채널로 대체", err);
    return createMockStageChannel();
  }
}
