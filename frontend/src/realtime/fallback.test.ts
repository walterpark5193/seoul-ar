import { describe, expect, it, vi } from "vitest";
import { withFallback } from "./fallback";
import { createMockRealtime } from "./mock";
import type { ConnStatus, RealtimeClient, StateMessage } from "./types";

const msg: StateMessage = { v: 1, type: "state", month: "202611", gu: null, metric: "count", ts: 2 };

function brokenClient(publish = vi.fn(async () => {})): RealtimeClient {
  let status: ConnStatus = "idle";
  return {
    get status() { return status; },
    async connect() { status = "error"; throw new Error("socket refused"); },
    subscribe: () => () => {},
    publish,
    onStatus: () => () => {},
    close() { status = "closed"; },
  };
}

/** First connect() fails like a timed-out socket; recover() is the client's own background retry succeeding. */
function flakyClient() {
  let status: ConnStatus = "idle";
  const handlers = new Set<(m: StateMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  const set = (s: ConnStatus) => { status = s; for (const cb of statusSubs) cb(s); };
  const client: RealtimeClient & { recover(): void; emit(m: StateMessage): void } = {
    get status() { return status; },
    async connect() { set("connecting"); set("error"); throw new Error("events.connect: 8000ms timeout"); },
    subscribe(h) { handlers.add(h); return () => { handlers.delete(h); }; },
    publish: vi.fn(async () => {}),
    onStatus(cb) { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; },
    close() { set("closed"); },
    recover() { set("connecting"); set("open"); },
    emit(m) { for (const h of handlers) h(m); },
  };
  return client;
}

describe("withFallback", () => {
  it("uses the primary client when it connects", async () => {
    const primary = createMockRealtime({ channel: () => null });
    const rt = withFallback(primary, () => createMockRealtime({ channel: () => null }));
    const handler = vi.fn();
    rt.subscribe(handler);
    await rt.connect();
    expect(rt.status).toBe("open");
    await primary.publish(msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("falls back to the mock and reports error when the primary fails", async () => {
    const primaryPublish = vi.fn(async () => {});
    const rt = withFallback(brokenClient(primaryPublish), () => createMockRealtime({ channel: () => null }));
    const statuses: ConnStatus[] = [];
    rt.onStatus((s) => statuses.push(s));
    const handler = vi.fn();
    rt.subscribe(handler);
    await expect(rt.connect()).resolves.toBeUndefined();
    expect(rt.status).toBe("error");
    expect(statuses.at(-1)).toBe("error");
    await rt.publish(msg);
    expect(handler).toHaveBeenCalledWith(msg);
    expect(primaryPublish).toHaveBeenCalledWith(msg);
  });

  it("primary fails once, recovers, and its message reaches the subscriber", async () => {
    const primary = flakyClient();
    const rt = withFallback(primary, () => createMockRealtime({ channel: () => null }));
    const handler = vi.fn();
    rt.subscribe(handler);
    await rt.connect();
    expect(rt.status).toBe("error");
    primary.recover();
    primary.emit(msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("status returns to open when the primary recovers", async () => {
    const primary = flakyClient();
    const rt = withFallback(primary, () => createMockRealtime({ channel: () => null }));
    const statuses: ConnStatus[] = [];
    rt.onStatus((s) => statuses.push(s));
    await rt.connect();
    expect(rt.status).toBe("error");
    primary.recover();
    expect(rt.status).toBe("open");
    expect(statuses.at(-1)).toBe("open");
  });

  it("works with no primary at all", async () => {
    const rt = withFallback(null, () => createMockRealtime({ channel: () => null }));
    await rt.connect();
    expect(rt.status).toBe("open");
  });
});
