// 투표 패널 HTML. 순수 함수. DOM 연결은 stageView. 계약: CONTRACTS-stage 8절.
import { esc } from "../../ui/html";
import { VOTE_MAX } from "../types";
import type { VoteState } from "../types";

const SOURCE_LABEL = { camera: "카메라", manual: "직접" } as const;

function secondsLeft(v: VoteState, now: number): string {
  if (v.endsAt === null) return "";
  return `${Math.max(0, Math.ceil((v.endsAt - now) / 1000))}초`;
}

function head(v: VoteState, now: number): string {
  const gu = esc(v.candidates[v.index]);
  const secs = secondsLeft(v, now);
  const timer = secs ? `<span class="vote-timer">${secs}</span>` : "";
  switch (v.phase) {
    case "prompt":
    case "counting":
      return `<p class="vote-head">${gu} 보고 싶은 분, 손 들어 주세요</p>${timer}`;
    case "awaitManual":
      return `<p class="vote-head">${gu} 보고 싶은 분, 손 들어 주세요</p><p class="vote-warn">손이 인식되지 않았어요 · 개수를 골라 주세요</p>`;
    case "review":
      return `<p class="vote-head">집계 확인 · 고칠 곳이 있으면 개수를 누르세요</p>${timer}<button type="button" class="vote-confirm" data-vote-confirm>확정 Enter</button>`;
    case "result":
      return `<p class="vote-head">${v.winner ? `${esc(v.winner)} 선정` : "집계된 표가 없어요"}</p>`;
  }
}

function row(v: VoteState, i: number, reviewRow: number): string {
  const n = v.counts[i]!;
  const src = v.sources[i];
  const future = i > v.index && v.phase !== "review" && v.phase !== "result";
  const locked = future || v.phase === "result";
  const isNow = i === v.index && v.phase !== "review" && v.phase !== "result";
  const waiting = n === null && i === v.index && v.phase === "awaitManual";
  const countText = n !== null ? `${n}손` : waiting ? "?" : "—";
  const srcText = n !== null && src ? SOURCE_LABEL[src] : future ? "(대기)" : "";
  const pct = n === null ? 0 : Math.round((Math.min(n, VOTE_MAX) / VOTE_MAX) * 100);
  const cls = ["vote-row", isNow ? "is-now" : "", v.phase === "review" && i === reviewRow ? "is-review" : "", future ? "is-future" : ""].filter(Boolean).join(" ");
  const btns = Array.from({ length: VOTE_MAX + 1 }, (_, k) =>
    `<button type="button" class="vote-n" data-vote-set="${i}:${k}" aria-pressed="${n === k}"${locked ? " disabled" : ""}>${k}</button>`).join("");
  return `<div class="${cls}"><span class="vote-gu">${esc(v.candidates[i])}</span>` +
    `<span class="vote-bar" aria-hidden="true"><span class="vote-fill" style="width:${pct}%"></span></span>` +
    `<span class="vote-count">${countText}</span><span class="vote-src">${srcText}</span>` +
    `<span class="vote-btns">${btns}</span></div>`;
}

export function renderVotePanel(v: VoteState, ui: { reviewRow: number; now: number }): string {
  const rows = [0, 1, 2].map((i) => row(v, i, ui.reviewRow)).join("");
  const m = (id: "camera" | "manual", label: string) =>
    `<button type="button" class="vote-method" data-vote-method="${id}" aria-pressed="${v.method === id}">${label}</button>`;
  return `<section class="vote-panel" aria-label="투표" data-phase="${v.phase}">` +
    `<div class="vote-top">${head(v, ui.now)}</div>${rows}` +
    `<div class="vote-foot"><span class="vote-foot-label">입력</span>${m("camera", "카메라")}${m("manual", "직접 선택")}<span class="vote-key">N</span></div></section>`;
}
