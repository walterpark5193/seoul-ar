// 실시간 실패가 화면을 깨지 않게 감싼다.
// - 주 클라이언트(AppSync)의 구독과 상태는 처음부터 붙여 둔다. 첫 연결이 실패해도 주 클라이언트가
//   스스로 재연결에 성공하면 그 메시지가 그대로 들어오고, 상태도 "open"으로 돌아온다.
// - 첫 연결이 실패하면 모의 클라이언트(같은 기기의 다른 탭)를 함께 붙인다. 그동안 상태는 주 클라이언트를 따라 "error".
// - 발행은 모의(있으면, 같은 기기 탭)와 주 클라이언트(HTTP)에 모두 보낸다. 주 클라이언트의 실패만 호출자에게 알린다.
import type { ConnStatus, RealtimeClient, StateMessage } from "./types";

export function withFallback(primary: RealtimeClient | null, makeFallback: () => RealtimeClient): RealtimeClient {
  const handlers = new Set<(msg: StateMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  const detach: Array<() => void> = [];
  let status: ConnStatus = "idle";
  let fallback: RealtimeClient | null = null;
  let connecting: Promise<void> | null = null;

  const setStatus = (s: ConnStatus) => {
    if (s === status) return;
    status = s;
    for (const cb of [...statusSubs]) cb(s);
  };
  const fanOut = (msg: StateMessage) => { for (const h of [...handlers]) h(msg); };

  if (primary) {
    detach.push(primary.subscribe(fanOut));
    detach.push(primary.onStatus(setStatus));
  }

  async function addFallback(): Promise<void> {
    if (fallback) return;
    const fb = makeFallback();
    fallback = fb;
    detach.push(fb.subscribe(fanOut));
    if (!primary) detach.push(fb.onStatus(setStatus));
    await fb.connect();
  }

  async function doConnect(): Promise<void> {
    setStatus("connecting");
    if (!primary) {
      await addFallback();
      setStatus(fallback!.status);
      return;
    }
    try {
      await primary.connect();
      setStatus(primary.status);
    } catch (err) {
      console.warn("[realtime] 실시간 첫 연결 실패. 같은 기기 모의 연결을 함께 쓰고, 재연결은 계속 시도합니다", err);
      await addFallback();
      // 그사이 주 클라이언트가 이미 회복했을 수도 있다.
      setStatus(primary.status === "open" ? "open" : "error");
    }
  }

  const client: RealtimeClient = {
    get status() { return status; },
    connect() {
      connecting ??= doConnect();
      return connecting;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    async publish(msg) {
      await client.connect();
      if (fallback) await fallback.publish(msg).catch((err: unknown) => console.warn("[realtime] 모의 발행 실패", err));
      if (primary) await primary.publish(msg);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => { statusSubs.delete(cb); };
    },
    close() {
      for (const off of detach.splice(0)) off();
      primary?.close();
      fallback?.close();
      setStatus("closed");
    },
  };
  return client;
}
