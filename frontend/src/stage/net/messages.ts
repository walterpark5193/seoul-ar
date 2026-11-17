// 무대 채널 메시지 계약 (CONTRACTS-stage 4.1, 13.6). 손 좌표·영상 프레임이 채널로 새지 않도록 허용 키만 통과시킨다.
import { GU_ORDER } from "../../data/gu";
import type { StageMode, StageState, VoteState } from "../types";

export const STAGE_CHANNEL = "/seoul/stage";

/** yaw·zoom은 선택(CONTRACTS-stage 13.6). 없으면 큰 화면은 (0, 1)로 본다. */
export interface StageMessage { v: 1; type: "stage"; mode: StageMode; lifted: string | null; ts: number; yaw?: number; zoom?: number; }
export interface VoteMessage {
  v: 1; type: "vote"; round: number; phase: "counting" | "result";
  candidates: string[]; counts: (number | null)[]; winner: string | null; ts: number;
}
export type StageChannelMessage = StageMessage | VoteMessage;

export const ALLOWED_KEYS: { readonly stage: readonly string[]; readonly vote: readonly string[] } = Object.freeze({
  stage: Object.freeze(["v", "type", "mode", "lifted", "ts", "yaw", "zoom"]),
  vote: Object.freeze(["v", "type", "round", "phase", "candidates", "counts", "winner", "ts"]),
});

const GUS: readonly string[] = GU_ORDER;
const isGu = (x: unknown): x is string => typeof x === "string" && GUS.includes(x);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isFinite_ = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const isYaw = (x: unknown): boolean => isFinite_(x) && x > -Math.PI && x <= Math.PI;
const isZoom = (x: unknown): boolean => isFinite_(x) && x >= ZOOM_MIN && x <= ZOOM_MAX;
const isTs = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);

export function isStageMessage(x: unknown): x is StageMessage {
  if (!isRecord(x)) return false;
  return (
    x.v === 1 && x.type === "stage" &&
    (x.mode === "map" || x.mode === "spread") &&
    (x.lifted === null || isGu(x.lifted)) &&
    (x.yaw === undefined || isYaw(x.yaw)) &&
    (x.zoom === undefined || isZoom(x.zoom)) &&
    isTs(x.ts)
  );
}

export function isVoteMessage(x: unknown): x is VoteMessage {
  if (!isRecord(x)) return false;
  return (
    x.v === 1 && x.type === "vote" &&
    typeof x.round === "number" && Number.isInteger(x.round) &&
    (x.phase === "counting" || x.phase === "result") &&
    Array.isArray(x.candidates) && x.candidates.length === 3 && x.candidates.every(isGu) &&
    Array.isArray(x.counts) && x.counts.length === 3 &&
    x.counts.every((c) => c === null || (typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= 6)) &&
    (x.winner === null || isGu(x.winner)) &&
    isTs(x.ts)
  );
}

export function isStageChannelMessage(x: unknown): x is StageChannelMessage {
  return isStageMessage(x) || isVoteMessage(x);
}

export function assertPublishable(x: unknown): asserts x is StageChannelMessage {
  if (!isRecord(x)) throw new Error("무대 메시지가 객체가 아닙니다");
  const allowed = x.type === "stage" ? ALLOWED_KEYS.stage : x.type === "vote" ? ALLOWED_KEYS.vote : null;
  if (!allowed) throw new Error("알 수 없는 무대 메시지 종류입니다");
  const extra = Object.keys(x).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`허용되지 않은 키: ${extra.join(", ")}`);
  if (!isStageChannelMessage(x)) throw new Error("무대 메시지 형식이 올바르지 않습니다");
}

export function toStageMessage(s: StageState, ts: number, view?: { yaw: number; zoom: number }): StageMessage {
  const m: StageMessage = { v: 1, type: "stage", mode: s.mode, lifted: s.lifted, ts };
  if (view) { m.yaw = view.yaw; m.zoom = view.zoom; }
  return m;
}

export function toVoteMessage(v: VoteState, ts: number): VoteMessage {
  return {
    v: 1, type: "vote", round: v.round,
    phase: v.phase === "result" ? "result" : "counting",
    candidates: [...v.candidates], counts: [...v.counts], winner: v.winner, ts,
  };
}

/** 실제로 전선에 실릴 JSON 사본을 만들어 그 사본을 검사해 돌려준다. toJSON·빈 칸 배열 같은 우회를 막는다. */
export function toWire(x: unknown): StageChannelMessage {
  const json = JSON.stringify(x);
  if (json === undefined) throw new Error("무대 메시지를 직렬화할 수 없습니다");
  const wire: unknown = JSON.parse(json);
  assertPublishable(wire);
  return wire;
}
