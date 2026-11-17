// 모의 실시간: 같은 탭은 즉시 전달, 다른 탭은 BroadcastChannel("seoul-ar")로 전달(있을 때만).
import { isStateMessage, type ConnStatus, type RealtimeClient, type StateMessage } from "./types";

export interface BroadcastLike {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

export interface MockOptions { channel?: () => BroadcastLike | null; }

function defaultChannel(): BroadcastLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const bc = new BroadcastChannel("seoul-ar");
  const like: BroadcastLike = {
    onmessage: null,
    postMessage: (data) => bc.postMessage(data),
    close: () => bc.close(),
  };
  bc.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  return like;
}

export function createMockRealtime(opts: MockOptions = {}): RealtimeClient {
  const makeChannel = opts.channel ?? defaultChannel;
  const handlers = new Set<(msg: StateMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  let status: ConnStatus = "idle";
  let channel: BroadcastLike | null = null;

  const setStatus = (s: ConnStatus) => {
    if (s === status) return;
    status = s;
    for (const cb of [...statusSubs]) cb(s);
  };
  const deliver = (msg: StateMessage) => { for (const h of [...handlers]) h(msg); };

  return {
    get status() { return status; },
    async connect() {
      if (status === "open") return;
      channel = makeChannel();
      if (channel) channel.onmessage = (ev) => { if (isStateMessage(ev.data)) deliver(ev.data); };
      setStatus("open");
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    async publish(msg) {
      deliver(msg);
      channel?.postMessage(msg);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => { statusSubs.delete(cb); };
    },
    close() {
      if (channel) { channel.onmessage = null; channel.close(); channel = null; }
      setStatus("closed");
    },
  };
}
