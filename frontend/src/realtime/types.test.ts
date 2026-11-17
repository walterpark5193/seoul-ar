import { describe, expect, it } from "vitest";
import { isJobMessage, isStateMessage } from "./types";

const good = { v: 1, type: "state", month: "202611", gu: "강남구", metric: "price", ts: 1731830400000 };

describe("isStateMessage", () => {
  it("accepts a well-formed message, with gu or null", () => {
    expect(isStateMessage(good)).toBe(true);
    expect(isStateMessage({ ...good, gu: null, metric: "count" })).toBe(true);
  });

  it("isStateMessage rejects malformed", () => {
    expect(isStateMessage(null)).toBe(false);
    expect(isStateMessage("state")).toBe(false);
    expect(isStateMessage([])).toBe(false);
    for (const key of Object.keys(good)) {
      const copy: Record<string, unknown> = { ...good };
      delete copy[key];
      expect(isStateMessage(copy), `missing ${key}`).toBe(false);
    }
  });

  it("rejects another version or type", () => {
    expect(isStateMessage({ ...good, v: 2 })).toBe(false);
    expect(isStateMessage({ ...good, v: "1" })).toBe(false);
    expect(isStateMessage({ ...good, type: "hello" })).toBe(false);
  });

  it("rejects a numeric gu and bad field values", () => {
    expect(isStateMessage({ ...good, gu: 11680 })).toBe(false);
    expect(isStateMessage({ ...good, gu: "" })).toBe(false);
    expect(isStateMessage({ ...good, metric: "area" })).toBe(false);
    expect(isStateMessage({ ...good, month: "2026-11" })).toBe(false);
    expect(isStateMessage({ ...good, ts: Number.NaN })).toBe(false);
    expect(isStateMessage({ ...good, ts: "1" })).toBe(false);
  });
});

describe("isJobMessage", () => {
  const job = { v: 1, type: "job", jobId: "j-1", month: "202610", state: "running", done: 12, total: 25, gu: "강서구", ts: 1 };

  it("accepts running, done and error messages", () => {
    expect(isJobMessage(job)).toBe(true);
    expect(isJobMessage({ ...job, state: "done", done: 25, gu: undefined })).toBe(true);
    const { gu: _gu, ...noGu } = job;
    expect(isJobMessage({ ...noGu, state: "error", message: "서울 API가 응답하지 않습니다." })).toBe(true);
  });

  it("rejects malformed job messages", () => {
    expect(isJobMessage(null)).toBe(false);
    expect(isJobMessage({ ...job, type: "state" })).toBe(false);
    expect(isJobMessage({ ...job, v: 2 })).toBe(false);
    expect(isJobMessage({ ...job, jobId: "" })).toBe(false);
    expect(isJobMessage({ ...job, month: "2026-10" })).toBe(false);
    expect(isJobMessage({ ...job, state: "paused" })).toBe(false);
    expect(isJobMessage({ ...job, done: -1 })).toBe(false);
    expect(isJobMessage({ ...job, total: Number.NaN })).toBe(false);
    expect(isJobMessage({ ...job, gu: 11500 })).toBe(false);
    expect(isJobMessage({ ...job, message: 5 })).toBe(false);
    expect(isJobMessage({ ...job, ts: "1" })).toBe(false);
    for (const key of ["v", "type", "jobId", "month", "state", "done", "total", "ts"]) {
      const copy: Record<string, unknown> = { ...job };
      delete copy[key];
      expect(isJobMessage(copy), `missing ${key}`).toBe(false);
    }
  });

  it("accepts the optional kind fetch or narration and rejects other kinds", () => {
    expect(isJobMessage({ ...job, kind: "fetch" })).toBe(true);
    expect(isJobMessage({ ...job, kind: "narration" })).toBe(true);
    // 운영자가 돌리는 연 단위 미리 수집: month는 "YYYY00"
    expect(isJobMessage({ ...job, kind: "fetch-year", month: "202600" })).toBe(true);
    expect(isJobMessage({ ...job, kind: "fetch-years" })).toBe(false);
    expect(isJobMessage({ ...job, kind: "poem" })).toBe(false);
    expect(isJobMessage({ ...job, kind: 1 })).toBe(false);
  });

  it("a state message is not a job message and vice versa", () => {
    expect(isJobMessage(good)).toBe(false);
    expect(isStateMessage(job)).toBe(false);
  });
});
