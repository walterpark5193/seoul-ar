import { describe, expect, it, vi } from "vitest";
import { createIndexSource } from "./indexSource";
import type { DataIndex } from "./types";

const idx = (months: string[]): DataIndex => ({ v: 1, generatedAt: "", source: "", months, gus: [], summary: {} });

describe("createIndexSource", () => {
  it("refresh replaces current and notifies subscribers", async () => {
    const next = idx(["202610", "202611"]);
    const src = createIndexSource(idx(["202611"]), async () => next);
    const seen = vi.fn();
    src.subscribe(seen);
    await expect(src.refresh()).resolves.toBe(next);
    expect(src.current).toBe(next);
    expect(seen).toHaveBeenCalledWith(next);
  });

  it("shares one request between concurrent refreshes", async () => {
    const reload = vi.fn(async () => idx(["202611"]));
    const src = createIndexSource(idx(["202611"]), reload);
    await Promise.all([src.refresh(), src.refresh()]);
    expect(reload).toHaveBeenCalledTimes(1);
    await src.refresh();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("keeps the current index when a refresh fails", async () => {
    const first = idx(["202611"]);
    const src = createIndexSource(first, async () => { throw new Error("offline"); });
    const seen = vi.fn();
    src.subscribe(seen);
    await expect(src.refresh()).rejects.toThrow("offline");
    expect(src.current).toBe(first);
    expect(seen).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", async () => {
    const src = createIndexSource(idx([]), async () => idx(["202611"]));
    const seen = vi.fn();
    src.subscribe(seen)();
    await src.refresh();
    expect(seen).not.toHaveBeenCalled();
  });
});
