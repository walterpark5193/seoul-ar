import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetMonth, forgetNarrations, loadGu, loadIndex, loadNarration, reloadIndex } from "./loader";

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

  describe("loadNarration", () => {
    const narration = { v: 1, month: "203001", generatedAt: "", model: "m", items: { "서울 전체": "문장." } };
    const html = { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response;

    it("reads data/{month}/narration.json and caches it", async () => {
      const f = vi.fn(async () => ok(narration));
      vi.stubGlobal("fetch", f);
      await expect(loadNarration("203001")).resolves.toEqual(narration);
      await loadNarration("203001");
      expect(f).toHaveBeenCalledTimes(1);
      expect(f).toHaveBeenCalledWith("/data/203001/narration.json");
    });

    it("is null on 404, on the SPA fallback page, on a bad shape and on network errors", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
      await expect(loadNarration("203002")).resolves.toBeNull();
      vi.stubGlobal("fetch", vi.fn(async () => html));
      await expect(loadNarration("203003")).resolves.toBeNull();
      vi.stubGlobal("fetch", vi.fn(async () => ok({ v: 1, month: "203004" })));
      await expect(loadNarration("203004")).resolves.toBeNull();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
      await expect(loadNarration("203005")).resolves.toBeNull();
    });

    it("forgetNarrations invalidates the cache (index reload)", async () => {
      const f = vi.fn(async () => ok({ ...narration, month: "203006" }));
      vi.stubGlobal("fetch", f);
      await loadNarration("203006");
      forgetNarrations();
      await loadNarration("203006");
      expect(f).toHaveBeenCalledTimes(2);
    });

    it("remembers a missing narration only briefly, so a later generated one shows up", async () => {
      vi.useFakeTimers();
      try {
        const f = vi.fn()
          .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
          .mockResolvedValueOnce(ok({ ...narration, month: "203007" }));
        vi.stubGlobal("fetch", f);
        await expect(loadNarration("203007")).resolves.toBeNull();
        await expect(loadNarration("203007")).resolves.toBeNull();
        expect(f).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60_000);
        await expect(loadNarration("203007")).resolves.toMatchObject({ month: "203007" });
        expect(f).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
