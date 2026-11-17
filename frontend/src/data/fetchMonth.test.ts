import { describe, expect, it, vi } from "vitest";
import { FETCH_MONTH_PATH, NARRATE_MONTH_PATH, requestFetchMonth, requestNarrateMonth } from "./fetchMonth";

const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("requestFetchMonth", () => {
  it("POSTs JSON {month} with the presenter key header to the same-origin path", async () => {
    const f = vi.fn(async () => res(202, { jobId: "j-1", month: "202610" }));
    await expect(requestFetchMonth("202610", "secret", f)).resolves.toEqual({ kind: "started", jobId: "j-1", month: "202610" });
    expect(FETCH_MONTH_PATH).toBe("/api/fetch-month");
    expect(f).toHaveBeenCalledWith("/api/fetch-month", {
      method: "POST",
      headers: { "content-type": "application/json", "x-presenter-key": "secret" },
      body: JSON.stringify({ month: "202610" }),
      cache: "no-store",
    });
  });

  it("maps 400, 401, 409 and 404 to their own outcomes", async () => {
    expect(await requestFetchMonth("209901", "k", vi.fn(async () => res(400)))).toEqual({ kind: "bad-month" });
    expect(await requestFetchMonth("202610", "k", vi.fn(async () => res(401)))).toEqual({ kind: "unauthorized" });
    expect(await requestFetchMonth("202610", "k", vi.fn(async () => res(409)))).toEqual({ kind: "busy" });
    expect(await requestFetchMonth("202610", "k", vi.fn(async () => res(404)))).toEqual({ kind: "unavailable" });
  });

  it("treats network errors, 5xx and a 202 without jobId as failures", async () => {
    expect(await requestFetchMonth("202610", "k", vi.fn(async () => { throw new TypeError("Failed to fetch"); }))).toEqual({ kind: "network" });
    expect(await requestFetchMonth("202610", "k", vi.fn(async () => res(502)))).toEqual({ kind: "failed", status: 502 });
    expect(await requestFetchMonth("202610", "k", vi.fn(async () => res(202, { month: "202610" })))).toEqual({ kind: "failed", status: 202 });
  });

  it("requestNarrateMonth posts the same way to /api/narrate-month", async () => {
    const f = vi.fn(async () => res(202, { jobId: "n-1", month: "202611" }));
    await expect(requestNarrateMonth("202611", "secret", f)).resolves.toEqual({ kind: "started", jobId: "n-1", month: "202611" });
    expect(NARRATE_MONTH_PATH).toBe("/api/narrate-month");
    expect(f).toHaveBeenCalledWith("/api/narrate-month", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", "x-presenter-key": "secret" },
      body: JSON.stringify({ month: "202611" }),
    }));
    expect(await requestNarrateMonth("202611", "k", vi.fn(async () => res(401)))).toEqual({ kind: "unauthorized" });
  });
});
