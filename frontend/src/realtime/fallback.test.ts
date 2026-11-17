import { describe, expect, it, vi } from "vitest";
import { withFallback } from "./fallback";
import { createMockRealtime } from "./mock";
import type { ConnStatus, JobMessage, RealtimeClient, StateMessage } from "./types";

const msg: StateMessage = { v: 1, type: "state", month: "202611", gu: null, metric: "count", ts: 2 };

function brokenClient(publish = vi.fn(async () => {})): RealtimeClient {
  let status: ConnStatus = "idle";
  return {
    get status() { return status; },
    async connect() { status = "error"; throw new Error("socket refused"); },
    subscribe: () => () => {},
    subscribeJobs: () => () => {},
    publish,
    onStatus: () => () => {},
    close() { status = "closed"; },
  };
}

/** First connect() fails like a timed-out socket; recover() is the client's own background retry succeeding. */
function flakyClient() {
  let status: ConnStatus = "idle";
  const handlers = new Set<(m: StateMessage) => void>();
  const jobHandlers = new Set<(m: JobMessage) => void>();
  const statusSubs = new Set<(s: ConnStatus) => void>();
  const set = (s: ConnStatus) => { status = s; for (const cb of statusSubs) cb(s); };
  const client: RealtimeClient & { recover(): void; emit(m: StateMessage): void; emitJob(m: JobMessage): void } = {
    get status() { return status; },
    async connect() { set("connecting"); set("error"); throw new Error("events.connect: 8000ms timeout"); },
    subscribe(h) { handlers.add(h); return () => { handlers.delete(h); }; },
    subscribeJobs: vi.fn((h: (m: JobMessage) => void) => { jobHandlers.add(h); return () => { jobHandlers.delete(h); }; }),
    publish: vi.fn(async () => {}),
    onStatus(cb) { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; },
    close() { set("closed"); },
    recover() { set("connecting"); set("open"); },
    emit(m) { for (const h of handlers) h(m); },
    emitJob(m) { for (const h of jobHandlers) h(m); },
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

  describe("jobs", () => {
    const job: JobMessage = { v: 1, type: "job", jobId: "j", month: "202610", state: "done", done: 25, total: 25, ts: 3 };

    it("subscribes to the primary's jobs lazily and forwards them", async () => {
      const primary = flakyClient();
      const rt = withFallback(primary, () => createMockRealtime({ channel: () => null }));
      await rt.connect();
      expect(primary.subscribeJobs).not.toHaveBeenCalled();
      const onJob = vi.fn();
      rt.subscribeJobs(onJob);
      expect(primary.subscribeJobs).toHaveBeenCalledTimes(1);
      rt.subscribeJobs(vi.fn());
      expect(primary.subscribeJobs).toHaveBeenCalledTimes(1);
      primary.emitJob(job);
      expect(onJob).toHaveBeenCalledWith(job);
    });

    it("also forwards jobs from the same-device mock while degraded", async () => {
      const mock = createMockRealtime({ channel: () => null });
      const rt = withFallback(flakyClient(), () => mock);
      const onJob = vi.fn();
      rt.subscribeJobs(onJob);
      await rt.connect();
      mock.publishJob(job);
      expect(onJob).toHaveBeenCalledWith(job);
    });

    it("stops forwarding after unsubscribe", async () => {
      const primary = flakyClient();
      const rt = withFallback(primary, () => createMockRealtime({ channel: () => null }));
      const onJob = vi.fn();
      const off = rt.subscribeJobs(onJob);
      off();
      primary.emitJob(job);
      expect(onJob).not.toHaveBeenCalled();
    });
  });
});
