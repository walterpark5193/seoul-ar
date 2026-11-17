import { describe, expect, it, vi } from "vitest";
import type { BroadcastLike } from "../../realtime/mock";
import type { StageChannelMessage } from "./messages";
import { createMockStageChannel, makeStageChannel } from "./stageChannel";

const msg: StageChannelMessage = { v: 1, type: "stage", mode: "map", lifted: "중구", ts: 1 };

function fakePair(): [BroadcastLike, BroadcastLike] {
  const make = (): BroadcastLike & { peer?: BroadcastLike } => ({
    onmessage: null,
    postMessage(data: unknown) { this.peer?.onmessage?.({ data }); },
    close() { this.peer = undefined; },
  });
  const a = make(); const b = make();
  a.peer = b; b.peer = a;
  return [a, b];
}

describe("createMockStageChannel", () => {
  it("connect 후 open, subscribe로 publish 전달", async () => {
    const ch = createMockStageChannel({ channel: () => null });
    const st = vi.fn(); ch.onStatus(st);
    await ch.connect();
    expect(ch.status).toBe("open");
    expect(st).toHaveBeenCalledWith("open");
    const got = vi.fn(); const off = ch.subscribe(got);
    await ch.publish(msg);
    expect(got).toHaveBeenCalledWith(msg);
    off();
    await ch.publish(msg);
    expect(got).toHaveBeenCalledTimes(1);
    ch.close();
    expect(ch.status).toBe("closed");
  });

  it("손상 메시지는 무시", async () => {
    const [a, b] = fakePair();
    const ch = createMockStageChannel({ channel: () => a });
    await ch.connect();
    const got = vi.fn(); ch.subscribe(got);
    b.postMessage({ v: 1, type: "stage", mode: "map", lifted: "없는구", ts: 1 });
    b.postMessage({ type: "stage", landmarks: [] });
    expect(got).not.toHaveBeenCalled();
  });

  it("탭 간 전달", async () => {
    const [a, b] = fakePair();
    const c1 = createMockStageChannel({ channel: () => a });
    const c2 = createMockStageChannel({ channel: () => b });
    await c1.connect(); await c2.connect();
    const got = vi.fn(); c2.subscribe(got);
    await c1.publish(msg);
    expect(got).toHaveBeenCalledWith(msg);
  });

  it("잘못된 메시지 publish는 reject", async () => {
    const ch = createMockStageChannel({ channel: () => null });
    await ch.connect();
    const got = vi.fn(); ch.subscribe(got);
    await expect(ch.publish({ ...msg, landmarks: [[0, 0, 0]] } as unknown as StageChannelMessage)).rejects.toThrow();
    expect(got).not.toHaveBeenCalled();
  });
});

describe("makeStageChannel", () => {
  it("events null이면 mock", async () => {
    const ch = makeStageChannel(null);
    expect(ch.status).toBe("idle");
    await ch.connect();
    expect(ch.status).toBe("open");
    ch.close();
  });
});
