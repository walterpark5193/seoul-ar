import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRAVEL_MS, TRAVEL_INTERVALS, createTimeTravel, nextMonth, renderTimeTravel, travelLine, travelStart,
} from "./timeTravel";
import { createStore, INITIAL_STATE, type AppState } from "../state/store";
import { toMessage } from "./hostView";

const MONTHS = ["202609", "202610", "202611"];

describe("step logic", () => {
  it("nextMonth goes up one month in the sorted list and stops at the end", () => {
    expect(nextMonth(MONTHS, "202609")).toBe("202610");
    expect(nextMonth(["202611", "202609", "202610"], "202610")).toBe("202611");
    expect(nextMonth(MONTHS, "202611")).toBeNull();
    expect(nextMonth(MONTHS, "209901")).toBeNull();
  });

  it("travelStart keeps the current month, or restarts from the first when at the last", () => {
    expect(travelStart(MONTHS, "202610")).toBe("202610");
    expect(travelStart(MONTHS, "202611")).toBe("202609");
    expect(travelStart(MONTHS, "209901")).toBe("202609");
    expect(travelStart(["202611"], "202611")).toBeNull();
  });

  it("intervals are 2, 4 and 8 seconds, 4 by default", () => {
    expect(TRAVEL_INTERVALS).toEqual([2000, 4000, 8000]);
    expect(DEFAULT_TRAVEL_MS).toBe(4000);
  });
});

describe("travelLine and renderTimeTravel", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, "");

  it("shows the months with the current one emphasized and the year once", () => {
    const html = travelLine(MONTHS, "202611");
    expect(text(html)).toBe("2026년 9월 → 10월 → 11월");
    expect(html).toContain("<strong>11월</strong>");
    expect(text(travelLine(["202512", "202601"], "202512"))).toBe("2025년 12월 → 2026년 1월");
    expect(travelLine(["202512", "202601"], "202512")).toContain("<strong>2025년 12월</strong>");
  });

  it("is empty with fewer than two months", () => {
    expect(renderTimeTravel({ playing: false, intervalMs: 4000 }, ["202611"], "202611")).toBe("");
  });

  it("renders play/pause, the interval choice and the line", () => {
    const idle = renderTimeTravel({ playing: false, intervalMs: 4000 }, MONTHS, "202609");
    expect(text(idle)).toContain("시간 여행");
    expect(idle).toMatch(/data-action="travel-toggle"[^>]*aria-pressed="false"[^>]*>재생</);
    expect(idle).toMatch(/<option value="4000" selected>4초<\/option>/);
    expect(idle).toContain('<option value="2000">2초</option>');
    expect(idle).toContain('<option value="8000">8초</option>');
    const playing = renderTimeTravel({ playing: true, intervalMs: 2000 }, MONTHS, "202610");
    expect(playing).toMatch(/aria-pressed="true"[^>]*>일시정지</);
    expect(playing).toMatch(/<option value="2000" selected>/);
  });
});

describe("createTimeTravel publishes the normal state sequence", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Host wiring in miniature: setMonth dispatches local, the store subscription publishes like hostView does. */
  function host(month: string) {
    const store = createStore({ ...INITIAL_STATE, month, gu: "강남구", metric: "count", follow: false });
    const published: ReturnType<typeof toMessage>[] = [];
    store.subscribe((s: AppState, prev: AppState) => {
      if (s.month !== prev.month || s.gu !== prev.gu || s.metric !== prev.metric) published.push(toMessage(s, Date.now()));
    });
    const views: Array<{ playing: boolean; intervalMs: number }> = [];
    const travel = createTimeTravel({
      months: () => MONTHS,
      month: () => store.getState().month,
      setMonth: (m) => store.dispatch({ type: "local", month: m }),
      onChange: (v) => views.push(v),
    });
    return { store, published, travel, views };
  }

  it("steps up every interval with gu and metric unchanged, and stops at the last month", async () => {
    const { published, travel } = host("202609");
    travel.play();
    expect(travel.view.playing).toBe(true);
    expect(published).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(published.map((m) => m.month)).toEqual(["202610"]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(published.map((m) => m.month)).toEqual(["202610", "202611"]);
    expect(published.every((m) => m.gu === "강남구" && m.metric === "count" && m.type === "state")).toBe(true);
    expect(travel.view.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(published).toHaveLength(2);
  });

  it("from the last month it jumps to the first, then continues", async () => {
    const { published, travel } = host("202611");
    travel.play();
    expect(published.map((m) => m.month)).toEqual(["202609"]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(published.map((m) => m.month)).toEqual(["202609", "202610"]);
  });

  it("honours the chosen interval, including a change while playing", async () => {
    const { published, travel } = host("202609");
    travel.setIntervalMs(2000);
    travel.play();
    await vi.advanceTimersByTimeAsync(2000);
    expect(published).toHaveLength(1);
    travel.setIntervalMs(8000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(published).toHaveLength(2);
    travel.setIntervalMs(1234);
    expect(travel.view.intervalMs).toBe(8000);
  });

  it("pause and stop halt it; dispose clears the timer", async () => {
    const { published, travel } = host("202609");
    travel.play();
    travel.toggle();
    expect(travel.view.playing).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(published).toHaveLength(0);
    travel.play();
    travel.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(published).toHaveLength(0);
    travel.play();
    travel.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(published).toHaveLength(0);
  });

  it("does nothing with fewer than two months: the month stays unchanged", async () => {
    const setMonth = vi.fn();
    const travel = createTimeTravel({ months: () => ["202611"], month: () => "202611", setMonth, onChange: vi.fn() });
    travel.play();
    await vi.advanceTimersByTimeAsync(20000);
    expect(travel.view.playing).toBe(false);
    expect(setMonth).not.toHaveBeenCalled();
  });
});
