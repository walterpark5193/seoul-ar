import { describe, expect, it } from "vitest";
import { renderVotePanel } from "./votePanel";
import type { VoteState } from "../types";

function vote(p: Partial<VoteState> = {}): VoteState {
  return {
    round: 1, candidates: ["강남구", "마포구", "노원구"], index: 0, phase: "counting", method: "camera",
    counts: [null, null, null], sources: [null, null, null], reviewEdited: false, winner: null, allZero: false, endsAt: 4000, ...p,
  };
}
const ui = { reviewRow: 0, now: 1000 };

describe("renderVotePanel", () => {
  it("prompt/counting: 구 이름 문구와 남은 초", () => {
    const h = renderVotePanel(vote(), ui);
    expect(h).toContain("강남구 보고 싶은 분, 손 들어 주세요");
    expect(h).toContain("3초");
    expect(renderVotePanel(vote({ phase: "prompt" }), ui)).toContain("강남구 보고 싶은 분, 손 들어 주세요");
  });
  it("buttons 0..6 per row, 선택값 aria-pressed", () => {
    const h = renderVotePanel(vote({ phase: "review", counts: [2, 1, 0], sources: ["camera", "manual", "camera"] }), ui);
    for (let r = 0; r < 3; r++) for (let n = 0; n <= 6; n++) expect(h).toContain(`data-vote-set="${r}:${n}"`);
    expect(h.match(/data-vote-set="\d:\d"/g)).toHaveLength(21);
    expect(h).toMatch(/data-vote-set="0:2"[^>]*aria-pressed="true"/);
    expect(h).toMatch(/data-vote-set="1:1"[^>]*aria-pressed="true"/);
    expect(h).toMatch(/data-vote-set="0:3"[^>]*aria-pressed="false"/);
    expect(h.match(/aria-pressed="true"/g)!.length).toBe(3 + 1);
  });
  it("future rows disabled before review", () => {
    const h = renderVotePanel(vote({ phase: "counting", index: 1 }), ui);
    expect(h).toMatch(/data-vote-set="2:3"[^>]*disabled/);
    expect(h).not.toMatch(/data-vote-set="0:3"[^>]*disabled/);
    expect(h).not.toMatch(/data-vote-set="1:3"[^>]*disabled/);
    expect(h).toContain("(대기)");
  });
  it("review all rows enabled", () => {
    const h = renderVotePanel(vote({ phase: "review", index: 2, counts: [2, 1, 0] }), ui);
    expect(h).not.toMatch(/data-vote-set="\d:\d"[^>]*disabled/);
    const h2 = renderVotePanel(vote({ phase: "review", index: 0, counts: [2, 1, 0] }), ui);
    expect(h2).not.toMatch(/data-vote-set="\d:\d"[^>]*disabled/);
  });
  it("source labels 카메라/직접 and counts", () => {
    const h = renderVotePanel(vote({ phase: "review", counts: [2, 1, 0], sources: ["camera", "manual", "camera"] }), ui);
    expect(h).toContain("2손");
    expect(h).toContain("카메라");
    expect(h).toContain("직접");
  });
  it("awaitManual message and ? count", () => {
    const h = renderVotePanel(vote({ phase: "awaitManual", index: 1, method: "manual", counts: [2, null, null], sources: ["camera", null, null], endsAt: null }), ui);
    expect(h).toContain("손이 인식되지 않았어요 · 개수를 골라 주세요");
    expect(h).toContain("마포구 보고 싶은 분, 손 들어 주세요");
    expect(h).toContain(">?<");
  });
  it("confirm button only in review", () => {
    const rv = renderVotePanel(vote({ phase: "review", counts: [2, 1, 0], endsAt: 3500 }), ui);
    expect(rv).toContain("data-vote-confirm");
    expect(rv).toContain("확정 Enter");
    expect(rv).toContain("집계 확인 · 고칠 곳이 있으면 개수를 누르세요");
    expect(rv).toContain("3초");
    for (const phase of ["prompt", "counting", "awaitManual", "result"] as const)
      expect(renderVotePanel(vote({ phase, winner: "강남구" }), ui)).not.toContain("data-vote-confirm");
  });
  it("result: winner 선정", () => {
    expect(renderVotePanel(vote({ phase: "result", counts: [2, 1, 0], winner: "강남구" }), ui)).toContain("강남구 선정");
  });
  it("method toggle pressed state", () => {
    const c = renderVotePanel(vote({ method: "camera" }), ui);
    expect(c).toMatch(/data-vote-method="camera"[^>]*aria-pressed="true"/);
    expect(c).toMatch(/data-vote-method="manual"[^>]*aria-pressed="false"/);
    const m = renderVotePanel(vote({ method: "manual" }), ui);
    expect(m).toMatch(/data-vote-method="manual"[^>]*aria-pressed="true"/);
  });
  it("후보 이름 이스케이프", () => {
    const h = renderVotePanel(vote({ candidates: ["<b>x", "마포구", "노원구"] }), ui);
    expect(h).not.toContain("<b>x");
    expect(h).toContain("&lt;b&gt;x");
  });
});
