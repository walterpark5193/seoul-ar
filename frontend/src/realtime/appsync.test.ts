import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateMessage } from "./types";

const { connectMock, postMock } = vi.hoisted(() => ({ connectMock: vi.fn(), postMock: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/data", () => ({
  events: { connect: (...a: unknown[]) => connectMock(...a), post: (...a: unknown[]) => postMock(...a) },
}));

import { createAppSyncRealtime } from "./appsync";

const cfg = { httpEndpoint: "https://x.appsync-api.us-east-1.amazonaws.com/event", realtimeEndpoint: "wss://x/event/realtime", region: "us-east-1", apiKey: "da2-test" };
const msg: StateMessage = { v: 1, type: "state", month: "202611", gu: "강남구", metric: "price", ts: 1 };

type Observer = { next(d: unknown): void; error(e: unknown): void };

/** A fake Amplify EventsChannel. ack=true: subscription ready resolves; "reject": ready rejects and observer.error fires (pre-ack failure). */
function fakeChannel(ack: true | "reject" = true) {
  let observer: Observer | null = null;
  const ch = {
    close: vi.fn(),
    publish: vi.fn(),
    subscribe: vi.fn((obs: Observer) => {
      observer = obs;
      const err = new Error("subscribe rejected");
      const ready = ack === true ? Promise.resolve({ subscriptionId: "s" }) : Promise.reject(err);
      ready.catch(() => {});
      if (ack === "reject") queueMicrotask(() => obs.error(err));
      return { unsubscribe: vi.fn(), ready };
    }),
    emit(event: unknown) { observer?.next({ id: "s", type: "data", event }); },
    fail(e: unknown) { observer?.error(e); },
  };
  return ch;
}

beforeEach(() => { vi.useFakeTimers(); connectMock.mockReset(); postMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("createAppSyncRealtime", () => {
  it("first connect timeout schedules a retry whose messages reach subscribers", async () => {
    const ch = fakeChannel();
    connectMock.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(ch);
    const rt = createAppSyncRealtime(cfg);
    const handler = vi.fn();
    rt.subscribe(handler);
    const first = rt.connect();
    const firstDone = expect(first).rejects.toThrow("8000ms");
    await vi.advanceTimersByTimeAsync(8000);
    await firstDone;
    expect(rt.status).toBe("error");
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(rt.status).toBe("open");
    ch.emit(msg);
    expect(handler).toHaveBeenCalledWith(msg);
    rt.close();
  });

  it("closes a channel that arrives after the connect timeout", async () => {
    let lateResolve!: (c: unknown) => void;
    const late = fakeChannel();
    connectMock.mockReturnValueOnce(new Promise((r) => { lateResolve = r; })).mockReturnValue(new Promise(() => {}));
    const rt = createAppSyncRealtime(cfg);
    const done = expect(rt.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    lateResolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalled();
    expect(late.subscribe).not.toHaveBeenCalled();
    rt.close();
  });

  it("a pre-ack failure runs one retry loop, not two", async () => {
    connectMock.mockResolvedValueOnce(fakeChannel("reject")).mockResolvedValue(fakeChannel());
    const rt = createAppSyncRealtime(cfg);
    await expect(rt.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.status).toBe("error");
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(rt.status).toBe("open");
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    rt.close();
  });

  it("ignores errors from a subscription it already replaced", async () => {
    const ch1 = fakeChannel();
    const ch2 = fakeChannel();
    connectMock.mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
    const rt = createAppSyncRealtime(cfg);
    await rt.connect();
    ch1.fail(new Error("socket dropped"));
    expect(rt.status).toBe("error");
    await vi.advanceTimersByTimeAsync(3000);
    expect(rt.status).toBe("open");
    ch1.fail(new Error("stale"));
    expect(rt.status).toBe("open");
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    rt.close();
  });

  it("stops retrying after close", async () => {
    connectMock.mockRejectedValue(new Error("offline"));
    const rt = createAppSyncRealtime(cfg);
    await expect(rt.connect()).rejects.toThrow();
    rt.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(rt.status).toBe("closed");
  });

  it("publish throws when AppSync reports failed events", async () => {
    postMock.mockResolvedValueOnce([{ identifier: "x", index: 0 }]).mockResolvedValueOnce(undefined);
    const rt = createAppSyncRealtime(cfg);
    await expect(rt.publish(msg)).rejects.toThrow();
    await expect(rt.publish(msg)).resolves.toBeUndefined();
    expect(postMock).toHaveBeenCalledWith("/seoul/state", msg);
  });

  describe("jobs channel", () => {
    const job = { v: 1, type: "job", jobId: "j-1", month: "202610", state: "running", done: 12, total: 25, gu: "강서구", ts: 2 };

    it("connects /seoul/jobs lazily on the first subscribeJobs and delivers job messages only to job handlers", async () => {
      const stateCh = fakeChannel();
      const jobsCh = fakeChannel();
      connectMock.mockImplementation(async (path: string) => (path === "/seoul/jobs" ? jobsCh : stateCh));
      const rt = createAppSyncRealtime(cfg);
      const onState = vi.fn();
      rt.subscribe(onState);
      await rt.connect();
      expect(connectMock.mock.calls.map((c) => c[0])).toEqual(["/seoul/state"]);
      const onJob = vi.fn();
      const onJob2 = vi.fn();
      rt.subscribeJobs(onJob);
      rt.subscribeJobs(onJob2);
      await vi.advanceTimersByTimeAsync(0);
      expect(connectMock.mock.calls.map((c) => c[0])).toEqual(["/seoul/state", "/seoul/jobs"]);
      jobsCh.emit(job);
      jobsCh.emit(JSON.stringify({ ...job, done: 13 }));
      jobsCh.emit({ junk: true });
      expect(onJob).toHaveBeenCalledTimes(2);
      expect(onJob2).toHaveBeenCalledTimes(2);
      expect(onState).not.toHaveBeenCalled();
      stateCh.emit(job);
      expect(onState).not.toHaveBeenCalled();
      rt.close();
    });

    it("retries the jobs channel on its own without touching the state status", async () => {
      const stateCh = fakeChannel();
      const jobsCh = fakeChannel();
      let jobsAttempts = 0;
      connectMock.mockImplementation(async (path: string) => {
        if (path !== "/seoul/jobs") return stateCh;
        jobsAttempts++;
        if (jobsAttempts === 1) throw new Error("jobs refused");
        return jobsCh;
      });
      const rt = createAppSyncRealtime(cfg);
      await rt.connect();
      const onJob = vi.fn();
      expect(() => rt.subscribeJobs(onJob)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(rt.status).toBe("open");
      await vi.advanceTimersByTimeAsync(3000);
      expect(jobsAttempts).toBe(2);
      jobsCh.emit(job);
      expect(onJob).toHaveBeenCalledTimes(1);
      expect(rt.status).toBe("open");
      rt.close();
      await vi.advanceTimersByTimeAsync(60000);
      expect(jobsAttempts).toBe(2);
    });

    it("unsubscribing a job handler stops delivery", async () => {
      const jobsCh = fakeChannel();
      connectMock.mockResolvedValue(jobsCh);
      const rt = createAppSyncRealtime(cfg);
      const onJob = vi.fn();
      const off = rt.subscribeJobs(onJob);
      await vi.advanceTimersByTimeAsync(0);
      off();
      jobsCh.emit(job);
      expect(onJob).not.toHaveBeenCalled();
      rt.close();
    });
  });
});
