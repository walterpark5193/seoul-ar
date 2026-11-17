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
});
