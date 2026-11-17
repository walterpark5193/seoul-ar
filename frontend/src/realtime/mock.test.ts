import { describe, expect, it, vi } from "vitest";
import { createMockRealtime, type BroadcastLike } from "./mock";
import type { JobMessage, StateMessage } from "./types";

const msg: StateMessage = { v: 1, type: "state", month: "202611", gu: "중구", metric: "price", ts: 1 };

/** Two fake BroadcastChannel endpoints wired to each other (like two tabs). */
function fakePair(): [BroadcastLike, BroadcastLike] {
  const make = (): BroadcastLike & { peer?: BroadcastLike } => ({
    onmessage: null,
    postMessage(data: unknown) { this.peer?.onmessage?.({ data }); },
    close() { this.peer = undefined; },
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("createMockRealtime", () => {
  it("status is open after connect", async () => {
    const rt = createMockRealtime({ channel: () => null });
    expect(rt.status).toBe("idle");
    const seen = vi.fn();
    rt.onStatus(seen);
    await rt.connect();
    expect(rt.status).toBe("open");
    expect(seen).toHaveBeenCalledWith("open");
    rt.close();
    expect(rt.status).toBe("closed");
  });

  it("publish after subscribe delivers in the same tab", async () => {
    const rt = createMockRealtime({ channel: () => null });
    await rt.connect();
    const handler = vi.fn();
    rt.subscribe(handler);
    await rt.publish(msg);
    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("does not deliver after unsubscribe", async () => {
    const rt = createMockRealtime({ channel: () => null });
    await rt.connect();
    const handler = vi.fn();
    const off = rt.subscribe(handler);
    off();
    await rt.publish(msg);
    expect(handler).not.toHaveBeenCalled();
  });

  it("relays to another tab through the broadcast channel and drops junk", async () => {
    const [a, b] = fakePair();
    const host = createMockRealtime({ channel: () => a });
    const viewer = createMockRealtime({ channel: () => b });
    await host.connect();
    await viewer.connect();
    const handler = vi.fn();
    viewer.subscribe(handler);
    await host.publish(msg);
    a.postMessage({ v: 9, junk: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg);
  });
});

describe("createMockRealtime jobs", () => {
  const job: JobMessage = { v: 1, type: "job", jobId: "j", month: "202610", state: "running", done: 3, total: 25, gu: "중구", ts: 1 };

  it("delivers jobs to job subscribers only, and stops after unsubscribe", async () => {
    const rt = createMockRealtime({ channel: () => null });
    await rt.connect();
    const onJob = vi.fn();
    const onState = vi.fn();
    const off = rt.subscribeJobs(onJob);
    rt.subscribe(onState);
    rt.publishJob(job);
    expect(onJob).toHaveBeenCalledWith(job);
    expect(onState).not.toHaveBeenCalled();
    await rt.publish(msg);
    expect(onJob).toHaveBeenCalledTimes(1);
    off();
    rt.publishJob(job);
    expect(onJob).toHaveBeenCalledTimes(1);
  });

  it("relays jobs to another tab", async () => {
    const [a, b] = fakePair();
    const host = createMockRealtime({ channel: () => a });
    const other = createMockRealtime({ channel: () => b });
    await host.connect();
    await other.connect();
    const onJob = vi.fn();
    other.subscribeJobs(onJob);
    host.publishJob(job);
    expect(onJob).toHaveBeenCalledWith(job);
  });
});
