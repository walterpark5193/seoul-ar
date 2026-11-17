import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRESENTER_KEY, createMonthFetch, defaultFetchMonth, isBusy, parseMonthInput, renderMonthFetch, statusLine,
  type FetchView,
} from "./monthFetch";
import type { DataIndex } from "../data/types";
import type { JobMessage } from "../realtime/types";

const NOW = new Date(2026, 10, 17, 12).getTime(); // 2026년 11월 17일(로컬)
const index = (months: string[]): DataIndex => ({ v: 1, generatedAt: "", source: "", months, gus: [], summary: {} });
const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const job = (over: Partial<JobMessage> = {}): JobMessage => ({
  v: 1, type: "job", jobId: "j-1", month: "202610", state: "running", done: 1, total: 25, gu: "종로구", ts: 1, ...over,
});

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

function setup(opts: { stored?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response>; refresh?: () => Promise<DataIndex> } = {}) {
  const handlers = new Set<(m: JobMessage) => void>();
  const subscribeJobs = vi.fn((h: (m: JobMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; });
  const emit = (m: JobMessage) => { for (const h of [...handlers]) h(m); };
  const storage = memoryStorage(opts.stored ? { [PRESENTER_KEY]: opts.stored } : {});
  const fetch = vi.fn(opts.fetch ?? (async (url: string) =>
    (url === "/api/fetch-month" ? res(202, { jobId: "j-1", month: "202610" }) : res(404))));
  const refreshIndex = vi.fn(opts.refresh ?? (async () => index(["202610", "202611"])));
  const toast = vi.fn();
  const views: FetchView[] = [];
  const mf = createMonthFetch({
    fetch: fetch as unknown as typeof globalThis.fetch,
    storage, subscribeJobs, refreshIndex, toast,
    onChange: (v) => views.push(v),
    now: () => Date.now(), pollMs: 4000, staleMs: 660_000,
  });
  return { mf, emit, storage, fetch, refreshIndex, toast, views, subscribeJobs, handlers };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("parseMonthInput", () => {
  it("accepts <input type=month> values and typed YYYYMM", () => {
    expect(parseMonthInput("2026-10", NOW)).toBe("202610");
    expect(parseMonthInput("202610", NOW)).toBe("202610");
    expect(parseMonthInput(" 2026-10 ", NOW)).toBe("202610");
    expect(parseMonthInput("200601", NOW)).toBe("200601");
    expect(parseMonthInput("202611", NOW)).toBe("202611");
  });

  it("rejects other shapes, impossible months and months outside 200601..this month", () => {
    for (const bad of ["", "2026/10", "26-10", "202613", "202600", "200512", "202612", "2027-01", "abcdef"]) {
      expect(parseMonthInput(bad, NOW), bad).toBeNull();
    }
  });
});

describe("defaultFetchMonth", () => {
  it("suggests the month before the earliest loaded month", () => {
    expect(defaultFetchMonth(index(["202611"]), NOW)).toBe("202610");
    expect(defaultFetchMonth(index(["202601", "202611"]), NOW)).toBe("202512");
    expect(defaultFetchMonth(index([]), NOW)).toBe("202610");
  });
});

describe("createMonthFetch", () => {
  it("asks for the passcode on first use, stores it, and posts with the header", async () => {
    const { mf, fetch, storage, views, subscribeJobs } = setup();
    expect(subscribeJobs).not.toHaveBeenCalled();
    await mf.submit("2026-10");
    expect(mf.view).toEqual({ phase: "key", month: "202610" });
    expect(fetch).not.toHaveBeenCalled();
    await mf.submitKey("pw");
    expect(storage.getItem(PRESENTER_KEY)).toBe("pw");
    expect(subscribeJobs).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/fetch-month");
    expect((init!.headers as Record<string, string>)["x-presenter-key"]).toBe("pw");
    expect(JSON.parse(String(init!.body))).toEqual({ month: "202610" });
    expect(views.some((v) => v.phase === "sending")).toBe(true);
    expect(mf.view).toMatchObject({ phase: "running", month: "202610", jobId: "j-1", done: 0 });
    expect(statusLine(mf.view)).toBe("2026년 10월 수집 시작");
  });

  it("uses the stored passcode without asking", async () => {
    const { mf, fetch } = setup({ stored: "pw" });
    await mf.submit("202610");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mf.view.phase).toBe("running");
  });

  it("shows progress, ignores other jobs, and on done reloads the index and toasts", async () => {
    const { mf, emit, refreshIndex, toast } = setup({ stored: "pw" });
    await mf.submit("202610");
    emit(job({ done: 12, gu: "강서구" }));
    expect(statusLine(mf.view)).toBe("2026년 10월 수집 중 12/25 · 강서구");
    emit(job({ jobId: "other", done: 20, gu: "송파구" }));
    expect(statusLine(mf.view)).toBe("2026년 10월 수집 중 12/25 · 강서구");
    emit(job({ done: 11, gu: "양천구" }));
    expect(mf.view).toMatchObject({ done: 12 });
    emit(job({ state: "done", done: 25, gu: undefined }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshIndex).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("2026년 10월 데이터가 준비됐습니다");
    expect(mf.view).toEqual({ phase: "idle", note: "2026년 10월 데이터가 준비됐습니다" });
    emit(job({ state: "done", done: 25 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshIndex).toHaveBeenCalledTimes(1);
  });

  it("401 clears the stored passcode and asks again", async () => {
    const { mf, storage } = setup({ stored: "old", fetch: async () => res(401) });
    await mf.submit("202610");
    expect(storage.getItem(PRESENTER_KEY)).toBeNull();
    expect(mf.view).toEqual({ phase: "key", month: "202610", error: "발표자 암호가 맞지 않습니다. 다시 입력해 주세요." });
  });

  it("explains 400, 409, a missing endpoint and network failures in plain sentences", async () => {
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => res(400), "2006년 1월부터 이번 달 사이"],
      [async () => res(409), "다른 달을 가져오는 중입니다"],
      [async () => res(404), "이 배포에서는 월 가져오기를 쓸 수 없습니다"],
      [async () => { throw new TypeError("Failed to fetch"); }, "수집 서버에 연결하지 못했습니다"],
      [async () => res(500), "수집 서버에 연결하지 못했습니다"],
    ];
    for (const [f, text] of cases) {
      const { mf } = setup({ stored: "pw", fetch: f });
      await mf.submit("202610");
      expect(mf.view.phase).toBe("idle");
      expect((mf.view as { error?: string }).error).toContain(text);
    }
  });

  it("rejects an invalid month before calling the server", async () => {
    const { mf, fetch } = setup({ stored: "pw" });
    await mf.submit("2026/10");
    expect(fetch).not.toHaveBeenCalled();
    expect((mf.view as { error?: string }).error).toContain("2006년 1월부터 이번 달 사이");
  });

  it("shows the job's own error message", async () => {
    const { mf, emit } = setup({ stored: "pw" });
    await mf.submit("202610");
    emit(job({ state: "error", message: "서울 API가 응답하지 않습니다." }));
    expect(mf.view).toEqual({ phase: "idle", error: "2026년 10월 수집 실패: 서울 API가 응답하지 않습니다." });
  });

  it("does not start a second job while one is running", async () => {
    const { mf, fetch } = setup({ stored: "pw" });
    await mf.submit("202610");
    expect(isBusy(mf.view)).toBe(true);
    await mf.submit("202609");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("polls the job status file when no events arrive", async () => {
    const { mf, fetch, refreshIndex } = setup({
      stored: "pw",
      fetch: async (url) => (url === "/api/fetch-month"
        ? res(202, { jobId: "j-1", month: "202610" })
        : res(200, job({ state: "done", done: 25 }))),
    });
    await mf.submit("202610");
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledWith("/data/jobs/j-1.json", { cache: "no-store" });
    expect(refreshIndex).toHaveBeenCalledTimes(1);
  });

  it("gives up with a message when no progress arrives for staleMs", async () => {
    const { mf } = setup({ stored: "pw" });
    await mf.submit("202610");
    await vi.advanceTimersByTimeAsync(664_000);
    expect(mf.view.phase).toBe("idle");
    expect((mf.view as { error?: string }).error).toContain("수집 상태를 받지 못했습니다");
  });

  it("tells the presenter to reload when the index cannot be re-read", async () => {
    const { mf, emit, toast } = setup({ stored: "pw", refresh: async () => { throw new Error("offline"); } });
    await mf.submit("202610");
    emit(job({ state: "done", done: 25 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(toast.mock.calls.at(-1)?.[0]).toContain("새로고침");
  });

  it("dispose stops polling, unsubscribes, and ignores late events", async () => {
    const { mf, emit, fetch, refreshIndex, handlers } = setup({ stored: "pw" });
    await mf.submit("202610");
    mf.dispose();
    expect(handlers.size).toBe(0);
    emit(job({ state: "done" }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshIndex).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancelKey returns to idle", async () => {
    const { mf } = setup();
    await mf.submit("202610");
    mf.cancelKey();
    expect(mf.view).toEqual({ phase: "idle" });
  });
});

describe("renderMonthFetch", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const opts = { value: "2026-10", max: "2026-11" };

  it("renders a month input and a 가져오기 button", () => {
    const html = renderMonthFetch({ phase: "idle" }, opts);
    expect(html).toContain('type="month"');
    expect(html).toContain('value="2026-10"');
    expect(html).toContain('max="2026-11"');
    expect(html).toContain('min="2006-01"');
    expect(text(html)).toContain("가져오기");
    expect(html).not.toMatch(/data-fetch-submit[^>]*disabled/);
  });

  it("disables the button and shows the progress line while running", () => {
    const html = renderMonthFetch({ phase: "running", month: "202610", jobId: "j", done: 12, total: 25, gu: "강서구" }, opts);
    expect(html).toMatch(/data-fetch-submit[^>]*disabled/);
    expect(text(html)).toContain("2026년 10월 수집 중 12/25 · 강서구");
  });

  it("shows an inline passcode form in the key phase", () => {
    const html = renderMonthFetch({ phase: "key", month: "202610", error: "발표자 암호가 맞지 않습니다. 다시 입력해 주세요." }, opts);
    expect(html).toContain('data-form="key"');
    expect(html).toContain('type="password"');
    expect(text(html)).toContain("발표자 암호");
    expect(text(html)).toContain("다시 입력해 주세요");
  });

  it("escapes server-provided error text", () => {
    const html = renderMonthFetch({ phase: "idle", error: "<img src=x>" }, opts);
    expect(html).not.toContain("<img");
  });
});
