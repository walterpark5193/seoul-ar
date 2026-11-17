// 상단 줄·안내·시작 화면·자막 HTML. 순수 함수. 계약: CONTRACTS-stage 8절.
import { esc } from "../../ui/html";
import type { ConnStatus } from "../../realtime/types";
import type { HandSourceError } from "../hands/recognizer";
import type { StageState } from "../types";

const METRIC_LABEL = { price: "㎡당 가격", count: "거래 건수" } as const;

function conn(c: ConnStatus): { text: string; cls: string } {
  if (c === "open") return { text: "실시간 연결", cls: "is-live" };
  if (c === "connecting") return { text: "연결 중", cls: "is-wait" };
  return { text: "오프라인 모드", cls: "is-off" };
}

export function renderTopBar(s: StageState, o: { conn: ConnStatus; publishFailed: boolean; monthLabel: string }): string {
  const c = conn(o.conn);
  const fail = o.publishFailed ? `<span class="stage-conn is-failed">발행 실패</span>` : "";
  return `<header class="stage-top${o.publishFailed ? " has-failure" : ""}">` +
    `<h1 class="stage-title">서울이 선다 · 무대</h1>` +
    `<p class="stage-metric">${esc(o.monthLabel)} · ${METRIC_LABEL[s.metric]}</p>` +
    `<p class="stage-status">${fail}<span class="stage-conn ${c.cls}">${c.text}</span></p></header>`;
}

export function renderHints(s: StageState): string {
  const text = s.input === "hands"
    ? "주먹: 들어올리기 · 빈 곳 주먹 끌기: 돌리기 · 두 주먹: 돌리기·확대 · 두 손 펴기: 가격순 펼치기 · 브이: 전체 보기 · V: 투표 · M: 음소거"
    : "누르고 있기: 들어올리기 · 빈 곳 끌기: 돌리기 · 휠: 확대 · 스페이스: 가격순 펼치기 · Esc: 전체 보기 · V: 투표 · G: 손 모드";
  return `<p class="stage-hints">${text}</p>`;
}

const REASON_NOTE: Record<HandSourceError, string> = {
  "model-missing": "동작 인식 모델이 없어 마우스로 진행합니다",
  "no-camera": "카메라를 찾지 못했어요. 마우스로 진행할 수 있어요",
  denied: "카메라 권한이 거부되었어요. 마우스로 진행할 수 있어요",
  "wasm-failed": "동작 인식을 시작하지 못했어요. 마우스로 진행할 수 있어요",
  unsupported: "이 브라우저는 동작 인식을 지원하지 않아요. 마우스로 진행할 수 있어요",
};

export function renderStart(o: { modelReady: boolean; reason: HandSourceError | null }): string {
  const reason = o.reason ?? (o.modelReady ? null : "model-missing");
  const note = reason ? `<p class="start-note">${esc(REASON_NOTE[reason])}</p>` : "";
  return `<section class="stage-start"><h2 class="start-title">서울이 선다</h2>` +
    `<button type="button" class="start-main" data-start="hands">무대 시작</button>` +
    `<button type="button" class="start-sub" data-start="mouse">마우스로 시작</button>${note}</section>`;
}

export function renderCaption(text: string | null): string {
  return `<div class="stage-caption" aria-live="polite">${text ? `<p>${esc(text)}</p>` : ""}</div>`;
}
