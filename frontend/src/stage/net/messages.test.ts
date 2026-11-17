import { describe, expect, it } from "vitest";
import type { StageState, VoteState } from "../types";
import {
  ALLOWED_KEYS, assertPublishable, isStageChannelMessage, isStageMessage, isVoteMessage,
  toStageMessage, toVoteMessage,
} from "./messages";

const stage = { v: 1, type: "stage", mode: "map", lifted: "중구", ts: 1 };
const vote = { v: 1, type: "vote", round: 1, phase: "counting", candidates: ["중구", "강남구", "마포구"], counts: [null, 2, 6], winner: null, ts: 2 };

const vs: VoteState = {
  round: 3, candidates: ["중구", "강남구", "마포구"], index: 1, phase: "result", method: "camera",
  counts: [1, 2, 3], sources: ["camera", "camera", "camera"], reviewEdited: false, winner: "마포구", allZero: false, endsAt: 99,
};
const ss = { mode: "spread", hover: "종로구", lifted: "중구", focus: null, input: "hands", vote: null, month: "202611", metric: "price", round: 3 } as StageState;

describe("isStageMessage", () => {
  it("정상 통과, lifted null 허용", () => {
    expect(isStageMessage(stage)).toBe(true);
    expect(isStageMessage({ ...stage, lifted: null })).toBe(true);
  });
  it("모르는 구, ts NaN, v 2 거절", () => {
    expect(isStageMessage({ ...stage, lifted: "없는구" })).toBe(false);
    expect(isStageMessage({ ...stage, ts: NaN })).toBe(false);
    expect(isStageMessage({ ...stage, v: 2 })).toBe(false);
    expect(isStageMessage(null)).toBe(false);
  });
});

describe("isVoteMessage", () => {
  it("정상 통과, 결과 null 허용", () => {
    expect(isVoteMessage(vote)).toBe(true);
    expect(isVoteMessage({ ...vote, counts: [null, null, null] })).toBe(true);
    expect(isStageChannelMessage(vote)).toBe(true);
  });
  it("길이 3 아님, counts 7, 1.5 거절", () => {
    expect(isVoteMessage({ ...vote, candidates: ["중구", "강남구"] })).toBe(false);
    expect(isVoteMessage({ ...vote, counts: [1, 2] })).toBe(false);
    expect(isVoteMessage({ ...vote, counts: [0, 0, 7] })).toBe(false);
    expect(isVoteMessage({ ...vote, counts: [0, 1.5, 0] })).toBe(false);
  });
});

describe("assertPublishable", () => {
  it("정상 통과", () => {
    expect(() => assertPublishable(stage)).not.toThrow();
    expect(() => assertPublishable(vote)).not.toThrow();
  });
  it("추가 키는 throw", () => {
    for (const k of ["landmarks", "frame", "x"]) {
      expect(() => assertPublishable({ ...stage, [k]: [] })).toThrow();
      expect(() => assertPublishable({ ...vote, [k]: 1 })).toThrow();
    }
  });
  it("형식 불량도 throw", () => {
    expect(() => assertPublishable({ ...stage, mode: "x" })).toThrow();
    expect(() => assertPublishable({ type: "other" })).toThrow();
  });
});

describe("toStageMessage / toVoteMessage", () => {
  it("키가 ALLOWED_KEYS와 정확히 같다", () => {
    expect(Object.keys(toStageMessage(ss, 5)).sort()).toEqual([...ALLOWED_KEYS.stage].sort());
    expect(Object.keys(toVoteMessage(vs, 5)).sort()).toEqual([...ALLOWED_KEYS.vote].sort());
  });
  it("값 변환", () => {
    expect(toStageMessage(ss, 5)).toEqual({ v: 1, type: "stage", mode: "spread", lifted: "중구", ts: 5 });
    const m = toVoteMessage(vs, 5);
    expect(m.phase).toBe("result");
    expect(toVoteMessage({ ...vs, phase: "review" }, 5).phase).toBe("counting");
    expect(isVoteMessage(m)).toBe(true);
  });
});
