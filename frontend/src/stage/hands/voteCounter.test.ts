import { describe, it, expect } from "vitest";
import { createVoteCounter } from "./voteCounter";
import type { VoteCounter } from "./voteCounter";

function hold(c: VoteCounter, from: number, ms: number, n: number, step = 33): number {
  let t = from;
  for (; t <= from + ms; t += step) c.push(t, n);
  return t;
}

describe("voteCounter", () => {
  it("stable 2 for 600ms → 2", () => {
    const c = createVoteCounter();
    hold(c, 0, 600, 2);
    expect(c.result()).toBe(2);
  });
  it("flicker never yields transient max", () => {
    const c = createVoteCounter();
    let t = 0;
    for (let i = 0; t < 5000; i++, t += 33) c.push(t, i % 2 ? 2 : 1);
    hold(c, t, 600, 1);
    expect(c.result()).toBe(1);
  });
  it("no stable segment → null", () => {
    const c = createVoteCounter();
    for (let i = 0; i < 30; i++) c.push(i * 100, i % 2 ? 3 : 4);
    expect(c.result()).toBeNull();
  });
  it("zero hands stable → 0", () => {
    const c = createVoteCounter();
    hold(c, 0, 600, 0);
    expect(c.result()).toBe(0);
  });
  it("max over segments", () => {
    const c = createVoteCounter();
    let t = hold(c, 0, 600, 1);
    t = hold(c, t, 600, 2);
    hold(c, t, 600, 1);
    expect(c.result()).toBe(2);
  });
  it("cap 6", () => {
    const c = createVoteCounter();
    hold(c, 0, 600, 8);
    expect(c.result()).toBe(6);
  });
  it("reset clears", () => {
    const c = createVoteCounter();
    hold(c, 0, 600, 2);
    c.reset();
    expect(c.result()).toBeNull();
  });
  it("exactly 500ms counts", () => {
    const c = createVoteCounter();
    c.push(0, 3);
    c.push(500, 3);
    expect(c.result()).toBe(3);
  });
  it("499ms does not count", () => {
    const c = createVoteCounter();
    c.push(0, 3);
    c.push(499, 3);
    expect(c.result()).toBeNull();
  });

  describe("short dropouts do not split a segment", () => {
    it("2 hands 400ms + one frame of 1 hand + 2 hands 400ms → 2", () => {
      const c = createVoteCounter();
      let t = hold(c, 0, 400, 2);
      c.push(t, 1);
      t += 33;
      hold(c, t, 400, 2);
      expect(c.result()).toBe(2);
    });
    it("a dropout of up to 120ms is bridged, the dropped value never counts", () => {
      const c = createVoteCounter();
      let t = hold(c, 0, 300, 2);
      for (const dt of [0, 40, 80]) c.push(t + dt, 0); // 0손 3프레임, 2손이 120ms 뒤에 돌아온다
      t += 120;
      hold(c, t, 300, 2);
      expect(c.result()).toBe(2);
    });
    it("review probe: 1 hand 600ms, then 2 hands for 4s with one frame dropped every 430ms → 2", () => {
      const c = createVoteCounter();
      let t = hold(c, 0, 600, 1);
      const end = t + 4000;
      let nextDrop = t + 430;
      for (; t <= end; t += 33) {
        if (t >= nextDrop) { c.push(t, 1); nextDrop += 430; } else c.push(t, 2);
      }
      expect(c.result()).toBe(2);
    });
    it("a change longer than 120ms still splits the segment", () => {
      const c = createVoteCounter();
      let t = hold(c, 0, 300, 2);
      t = hold(c, t, 160, 1); // 1손이 160ms 넘게 이어진다
      hold(c, t, 300, 2);
      expect(c.result()).toBeNull(); // 어느 2손 구간도 500ms가 안 된다
    });
    it("a one-frame spike above the held value is not counted", () => {
      const c = createVoteCounter();
      let t = hold(c, 0, 400, 1);
      c.push(t, 3);
      t += 33;
      hold(c, t, 400, 1);
      expect(c.result()).toBe(1);
    });
    it("a frame gap longer than 120ms around the dropout splits the segment", () => {
      const c = createVoteCounter();
      const t = hold(c, 0, 400, 2);
      c.push(t, 1);
      hold(c, t + 200, 400, 2); // 다음 프레임이 200ms 뒤에 와서 끼어든 값이 얼마나 이어졌는지 모른다
      expect(c.result()).toBeNull();
    });
  });
});
