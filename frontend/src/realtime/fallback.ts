// 실시간 실패가 화면을 깨지 않게: 주 클라이언트(AppSync) 연결이 실패하면 모의 클라이언트로 갈아타고
// 상태는 "error"로 정직하게 알린다. 발행은 모의(같은 기기 탭)와 주 클라이언트의 HTTP 발행을 둘 다 시도한다.
import type { ConnStatus, RealtimeClient, StateMessage } from "./types";

export function withFallback(primary: RealtimeClient | null, makeFallback: () => RealtimeClient): RealtimeClient {
  const handlers = new Set<(msg: StateMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  const detach: Array<() => void> = [];
  let status: ConnStatus = "idle";
  let active: RealtimeClient | null = null;
  let degraded = false;
  let connecting: Promise<void> | null = null;

  const setStatus = (s: ConnStatus) => {
    if (s === status) return;
    status = s;
    for (const cb of [...statusSubs]) cb(s);
  };
  const fanOut = (msg: StateMessage) => { for (const h of [...handlers]) h(msg); };
  const attach = (client: RealtimeClient, forwardStatus: boolean) => {
    active = client;
    detach.push(client.subscribe(fanOut));
    if (forwardStatus) detach.push(client.onStatus(setStatus));
  };

  async function doConnect(): Promise<void> {
    setStatus("connecting");
    if (primary) {
      try {
        await primary.connect();
        attach(primary, true);
        setStatus(primary.status);
        return;
      } catch (err) {
        console.warn("[realtime] 실시간 연결 실패, 같은 기기 모의 연결로 전환", err);
      }
    }
    const fb = makeFallback();
    await fb.connect();
    degraded = primary !== null;
    attach(fb, !degraded);
    setStatus(degraded ? "error" : fb.status);
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
      if (!active) throw new Error("실시간 연결이 없습니다");
      if (!degraded) return active.publish(msg);
      await active.publish(msg);
      if (primary) await primary.publish(msg);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => { statusSubs.delete(cb); };
    },
    close() {
      for (const off of detach.splice(0)) off();
      active?.close();
      if (primary && primary !== active) primary.close();
      setStatus("closed");
    },
  };
  return client;
}
