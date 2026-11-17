import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetMonth, loadGu, loadIndex, reloadIndex } from "./loader";

afterEach(() => { vi.unstubAllGlobals(); });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("loader", () => {
  it("loadIndex fetches data/index.json under the base", async () => {
    const f = vi.fn(async () => ok({ v: 1, months: ["202611"] }));
    vi.stubGlobal("fetch", f);
    await loadIndex();
    await loadIndex("/base");
    expect(f).toHaveBeenNthCalledWith(1, "/data/index.json");
    expect(f).toHaveBeenNthCalledWith(2, "/base/data/index.json");
  });

  it("loadGu encodes the gu name and caches per month and gu", async () => {
    const f = vi.fn(async () => ok({ v: 1, month: "202611", gu: "강남구" }));
    vi.stubGlobal("fetch", f);
    const a = await loadGu("202611", "강남구");
    const b = await loadGu("202611", "강남구");
    expect(a).toBe(b);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(`/data/202611/${encodeURIComponent("강남구")}.json`);
  });

  it("throws on a failed response and does not cache the failure", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce(ok({ v: 1, month: "202610", gu: "중구" }));
    vi.stubGlobal("fetch", f);
    await expect(loadGu("202610", "중구")).rejects.toThrow("404");
    await expect(loadGu("202610", "중구")).resolves.toMatchObject({ gu: "중구" });
  });

  it("reloadIndex bypasses the HTTP cache", async () => {
    const f = vi.fn(async () => ok({ v: 1, months: ["202610", "202611"] }));
    vi.stubGlobal("fetch", f);
    await expect(reloadIndex()).resolves.toMatchObject({ months: ["202610", "202611"] });
    expect(f).toHaveBeenCalledWith("/data/index.json", { cache: "no-store" });
  });

  it("forgetMonth drops cached gu data for that month only", async () => {
    const f = vi.fn(async (url: string) => ok({ v: 1, url }));
    vi.stubGlobal("fetch", f);
    await loadGu("202501", "중구");
    await loadGu("202502", "중구");
    forgetMonth("202501");
    await loadGu("202501", "중구");
    await loadGu("202502", "중구");
    expect(f).toHaveBeenCalledTimes(3);
  });
});
