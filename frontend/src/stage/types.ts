// 무대(#/stage) 공유 타입. 계약: docs/CONTRACTS-stage.md 1절. 작업자는 수정하지 않는다(변경은 계약 변경 제안으로).
import type { Metric } from "../data/types";

export type Vec3 = [number, number, number];
export type GestureName = "None" | "Closed_Fist" | "Open_Palm" | "Pointing_Up" | "Thumb_Down" | "Thumb_Up" | "Victory" | "ILoveYou";
export interface HandObs { landmarks: Vec3[]; gesture: GestureName; score: number; handedness: "Left" | "Right" | "Unknown"; }
/** t: ms(performance.now). landmarks 21개, x·y∈[0,1] 영상 좌표(거울 아님). */
export interface HandFrame { t: number; hands: HandObs[]; }
/** 화면 정규 좌표 [0,1], 왼쪽 위 원점. */
export interface Point { x: number; y: number; }
export type GestureEvent = { type: "grab" } | { type: "release" } | { type: "spread" } | { type: "victory" };
export interface GestureOutput { primary: number | null; events: GestureEvent[]; handCount: number; }

export type StageMode = "map" | "spread";
export type InputMode = "hands" | "mouse";
export type VoteMethod = "camera" | "manual";
export type VotePhase = "prompt" | "counting" | "awaitManual" | "review" | "result";
export type VoteSource = "camera" | "manual" | null;
export interface VoteState {
  round: number; candidates: [string, string, string]; index: 0 | 1 | 2; phase: VotePhase; method: VoteMethod;
  counts: [number | null, number | null, number | null]; sources: [VoteSource, VoteSource, VoteSource];
  reviewEdited: boolean; winner: string | null; allZero: boolean; endsAt: number | null;
  /** 후보별 안내 단계 길이(ms). voteStart가 준 값의 사본. 없으면 VOTE_TIMING.promptMs. */
  promptMs?: [number, number, number];
}
export interface StageState {
  mode: StageMode; hover: string | null; lifted: string | null; focus: string | null;
  input: InputMode; vote: VoteState | null; month: string; metric: Metric; round: number;
}
export type StageEvent =
  | { type: "hover"; gu: string | null }
  | { type: "grab" } | { type: "release" } | { type: "spread" } | { type: "victory" }
  /** promptMs: 후보별 안내 단계 길이(안내 클립 + 300ms, 최소 1500ms). introMs: 소개 클립 길이(첫 후보 안내에만 더함). */
  | { type: "voteStart"; candidates: [string, string, string]; now: number; promptMs?: [number, number, number]; introMs?: number }
  | { type: "voteTick"; now: number; cameraCount: number | null }
  | { type: "voteSet"; index: number; n: number; now: number }
  | { type: "voteMethod"; method: VoteMethod; now: number }
  | { type: "voteConfirm"; now: number }
  | { type: "voteCancel" }
  | { type: "setInput"; input: InputMode; now: number }
  | { type: "month"; month: string }
  | { type: "metric"; metric: Metric };
export type Effect =
  | { type: "scene.layout"; mode: StageMode }
  | { type: "scene.lift"; gu: string | null }
  | { type: "scene.focus"; gu: string | null }
  | { type: "scene.hover"; gu: string | null }
  | { type: "scene.data" }
  | { type: "narrate"; id: string; interrupt: boolean; protect: boolean }
  | { type: "narrate.stop" }                       // 재생 중(보호 클립 포함)·대기 중 해설을 모두 비운다
  | { type: "counter.reset" }
  | { type: "publish.state" }
  | { type: "publish.stage" }
  | { type: "publish.vote" };

export const VOTE_MAX = 6;
export const VOTE_TIMING = { promptMs: 1500, countMs: 5000, manualAdvanceMs: 1000, reviewMs: 3000, resultMs: 6000 } as const;
