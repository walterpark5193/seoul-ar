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

  it("works with no primary at all", async () => {
    const rt = withFallback(null, () => createMockRealtime({ channel: () => null }));
    await rt.connect();
    expect(rt.status).toBe("open");
  });
});
