import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastLike } from "../../realtime/mock";
import type { StageChannelMessage } from "./messages";

const { connectMock, postMock } = vi.hoisted(() => ({ connectMock: vi.fn(), postMock: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/data", () => ({
  events: { connect: (...a: unknown[]) => connectMock(...a), post: (...a: unknown[]) => postMock(...a) },
}));

import { createAppSyncStageChannel, createMockStageChannel, makeStageChannel } from "./stageChannel";

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

describe("직렬화 사본 검사", () => {
  const vote = { v: 1, type: "vote", round: 1, phase: "counting", candidates: ["중구", "강남구", "마포구"], counts: [1, 2, 3], winner: null, ts: 2 };
  it("toJSON으로 좌표를 싣는 counts는 거절", async () => {
    const ch = createMockStageChannel({ channel: () => null });
    await ch.connect();
    const counts = [1, 2, 3] as unknown as { toJSON?: () => unknown };
    counts.toJSON = () => [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]];
    await expect(ch.publish({ ...vote, counts } as unknown as StageChannelMessage)).rejects.toThrow();
  });
  it("빈 칸 배열은 순수 데이터로만 전달", async () => {
    const [a, b] = fakePair();
    const ch = createMockStageChannel({ channel: () => a });
    await ch.connect();
    const seen: unknown[] = []; b.onmessage = (ev) => seen.push(ev.data);
    // eslint-disable-next-line no-sparse-arrays
    const counts = [, 2, 3];
    await ch.publish({ ...vote, counts } as unknown as StageChannelMessage);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { counts: unknown[] }).counts).toEqual([null, 2, 3]);
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

// ---- AppSync 경로: 본체 realtime/appsync.ts(7f62e57)의 재시도·세대 가드·늦은 채널 닫기를 옮겼다 ----

const cfg = { httpEndpoint: "test-endpoint/event", realtimeEndpoint: "test-endpoint/event/realtime", region: "us-east-1", apiKey: "da2-test" };

type Observer = { next(d: unknown): void; error(e: unknown): void };

/** 가짜 Amplify EventsChannel. ack=true면 구독 ready가 풀리고, "reject"면 ready가 거절되며 observer.error가 온다. */
function fakeEventsChannel(ack: true | "reject" = true) {
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

describe("createAppSyncStageChannel", () => {
  beforeEach(() => { vi.useFakeTimers(); connectMock.mockReset(); postMock.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("첫 connect가 거절되면 3초 뒤 다시 시도해 open이 되고, 메시지가 구독자에게 간다", async () => {
    const ch = fakeEventsChannel();
    connectMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ch);
    const sc = createAppSyncStageChannel(cfg);
    const got = vi.fn(); sc.subscribe(got);
    await expect(sc.connect()).rejects.toThrow("offline");
    expect(sc.status).toBe("error");
    await vi.advanceTimersByTimeAsync(2999);
    expect(connectMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock).toHaveBeenLastCalledWith("/seoul/stage");
    expect(sc.status).toBe("open");
    ch.emit(msg);
    expect(got).toHaveBeenCalledWith(msg);
    sc.close();
  });

  it("첫 connect가 8초 시간 초과여도 재시도한다", async () => {
    const ch = fakeEventsChannel();
    connectMock.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(ch);
    const sc = createAppSyncStageChannel(cfg);
    const first = expect(sc.connect()).rejects.toThrow("8000ms");
    await vi.advanceTimersByTimeAsync(8000);
    await first;
    expect(sc.status).toBe("error");
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(sc.status).toBe("open");
    sc.close();
  });

  it("재시도 간격은 3초에서 두 배씩 늘어 30초에서 멈춘다", async () => {
    const at: number[] = [];
    connectMock.mockImplementation(() => { at.push(Date.now()); return Promise.reject(new Error("offline")); });
    const sc = createAppSyncStageChannel(cfg);
    const t0 = Date.now();
    await expect(sc.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000 + 6000 + 12000 + 24000 + 30000 + 30000);
    expect(at.map((t) => t - t0)).toEqual([0, 3000, 9000, 21000, 45000, 75000, 105000]);
    sc.close();
  });

  it("성공하면 재시도 간격이 다시 3초로 돌아간다", async () => {
    const ch1 = fakeEventsChannel();
    const ch2 = fakeEventsChannel();
    connectMock
      .mockRejectedValueOnce(new Error("a")).mockRejectedValueOnce(new Error("b"))
      .mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
    const sc = createAppSyncStageChannel(cfg);
    await expect(sc.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000 + 6000);
    expect(sc.status).toBe("open");
    ch1.fail(new Error("socket dropped"));
    await vi.advanceTimersByTimeAsync(2999);
    expect(connectMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectMock).toHaveBeenCalledTimes(4);
    expect(sc.status).toBe("open");
    sc.close();
  });

  it("시간 초과 뒤에 늦게 열린 채널은 구독하지 않고 닫는다", async () => {
    let lateResolve!: (c: unknown) => void;
    const late = fakeEventsChannel();
    connectMock.mockReturnValueOnce(new Promise((r) => { lateResolve = r; })).mockReturnValue(new Promise(() => {}));
    const sc = createAppSyncStageChannel(cfg);
    const done = expect(sc.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    lateResolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalled();
    expect(late.subscribe).not.toHaveBeenCalled();
    sc.close();
  });

  it("connect를 기다리는 중에 close()하면 늦게 열린 채널을 닫고 상태는 closed로 남는다", async () => {
    let lateResolve!: (c: unknown) => void;
    const late = fakeEventsChannel();
    connectMock.mockReturnValueOnce(new Promise((r) => { lateResolve = r; }));
    const sc = createAppSyncStageChannel(cfg);
    const pending = sc.connect();
    sc.close();
    lateResolve(late);
    await pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalled();
    expect(late.subscribe).not.toHaveBeenCalled();
    expect(sc.status).toBe("closed");
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("구독 승인 전 실패는 재시도 고리를 하나만 돌린다", async () => {
    connectMock.mockResolvedValueOnce(fakeEventsChannel("reject")).mockResolvedValue(fakeEventsChannel());
    const sc = createAppSyncStageChannel(cfg);
    await expect(sc.connect()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sc.status).toBe("error");
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(sc.status).toBe("open");
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    sc.close();
  });

  it("이미 바꾼 구독의 늦은 오류·데이터는 무시한다", async () => {
    const ch1 = fakeEventsChannel();
    const ch2 = fakeEventsChannel();
    connectMock.mockResolvedValueOnce(ch1).mockResolvedValueOnce(ch2);
    const sc = createAppSyncStageChannel(cfg);
    const got = vi.fn(); sc.subscribe(got);
    await sc.connect();
    ch1.fail(new Error("socket dropped"));
    expect(sc.status).toBe("error");
    await vi.advanceTimersByTimeAsync(3000);
    expect(sc.status).toBe("open");
    ch1.fail(new Error("stale"));
    ch1.emit(msg);
    expect(sc.status).toBe("open");
    expect(got).not.toHaveBeenCalled();
    ch2.emit(msg);
    expect(got).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    sc.close();
  });

  it("close() 뒤에는 다시 시도하지 않는다", async () => {
    connectMock.mockRejectedValue(new Error("offline"));
    const sc = createAppSyncStageChannel(cfg);
    await expect(sc.connect()).rejects.toThrow();
    sc.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(sc.status).toBe("closed");
  });

  it("connect()를 다시 부르면 걸려 있던 재시도를 지우고 바로 연결한다(고리는 하나)", async () => {
    const ch = fakeEventsChannel();
    connectMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ch);
    const sc = createAppSyncStageChannel(cfg);
    await expect(sc.connect()).rejects.toThrow();
    await sc.connect();
    expect(sc.status).toBe("open");
    await vi.advanceTimersByTimeAsync(60000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    sc.close();
  });

  it("publish는 toWire 사본만 events.post로 보낸다", async () => {
    postMock.mockResolvedValue(undefined);
    const sc = createAppSyncStageChannel(cfg);
    const vote = { v: 1, type: "vote", round: 1, phase: "result", candidates: ["중구", "강남구", "마포구"], counts: [1, 2, 3], winner: "마포구", ts: 2 } as StageChannelMessage;
    await sc.publish(vote);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [channel, body] = postMock.mock.calls[0]!;
    expect(channel).toBe("/seoul/stage");
    expect(body).toEqual(vote);
    expect(body).not.toBe(vote);
    expect((body as { counts: unknown }).counts).not.toBe((vote as { counts: unknown }).counts);
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  });

  it("publish는 좌표를 싣는 메시지(추가 키·toJSON 우회)를 보내지 않고 거절한다", async () => {
    postMock.mockResolvedValue(undefined);
    const sc = createAppSyncStageChannel(cfg);
    await expect(sc.publish({ ...msg, landmarks: [[0, 0, 0]] } as unknown as StageChannelMessage)).rejects.toThrow();
    const sneaky = { ...msg, toJSON: () => ({ ...msg, landmarks: [[0.1, 0.2, 0.3]] }) };
    await expect(sc.publish(sneaky as unknown as StageChannelMessage)).rejects.toThrow();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("AppSync가 발행을 거부하면 publish가 throw", async () => {
    postMock.mockResolvedValueOnce([{ identifier: "x", index: 0 }]).mockResolvedValueOnce(undefined);
    const sc = createAppSyncStageChannel(cfg);
    await expect(sc.publish(msg)).rejects.toThrow();
    await expect(sc.publish(msg)).resolves.toBeUndefined();
  });
});
