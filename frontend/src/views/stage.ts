// 큰 화면 3D 모드 (CONTRACTS 13): #/3d?stage=1. 같은 씬·같은 라이브 따라가기, 조작 없음.
// 이 파일은 순수 부분만: 쿼리 판정과 왼쪽 위 정보 패널(큰 제목, 큰 수치 3개, AI 해설). DOM은 orbitView가 잇는다.
import type { Narration } from "../data/narration";
import type { DataIndex, GuData } from "../data/types";
import type { AppState } from "../state/store";
import { fmtMonth } from "../ui/format";
import { esc } from "../ui/html";
import { renderAiNote, renderFigures, summarize } from "../ui/sheet";

export const STAGE_QR_HINT = "폰으로 QR을 찍어 그림을 비춰 보세요";

export function isStageQuery(query: string | undefined): boolean {
  if (!query) return false;
  return new URLSearchParams(query).get("stage") === "1";
}

/** 큰 화면에서 바뀔 때 알릴 말: "강남구, 2026년 11월" */
export function stageAnnouncement(state: Pick<AppState, "gu" | "month">): string {
  return `${state.gu ?? "서울 전체"}, ${fmtMonth(state.month)}`;
}

export function renderStage(state: AppState, data: GuData | null, index: DataIndex | null, narration: Narration | null): string {
  const { title, figures } = summarize(state, data, index);
  const down = state.conn === "error" || state.conn === "closed"
    ? `<p class="stage-conn"><span class="live-mark" aria-hidden="true">!</span>연결 끊김</p>`
    : "";
  return `<p class="stage-month">${esc(fmtMonth(state.month))} 매매 실거래</p>` +
    `<h1 class="stage-title">${esc(title)}</h1>` +
    renderFigures(figures, "stage-figs") +
    renderAiNote(state, narration, "ai-note stage-ai") +
    down;
}
