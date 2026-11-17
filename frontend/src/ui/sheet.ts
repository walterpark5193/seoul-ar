// 뷰어 바텀시트. 순수 함수: 상태와 데이터를 받아 HTML 문자열을 낸다(테스트 대상).
// 이벤트 연결은 sheetDom.ts가 맡는다.
import type { DataIndex, GuData, Metric, Stat } from "../data/types";
import type { AppState } from "../state/store";
import { NO_TRADE, fmtAmt, fmtCount, fmtMonth, fmtNumber, fmtPerM2 } from "./format";
import { esc, figure } from "./html";

export interface SheetOptions {
  altView?: { href: string; label: string };
  /** AR 실기 조정값 안내(views/arTuning.ts describeArTuning). 있을 때만 머리 아래 한 줄. */
  tuningNote?: string | null;
}

interface Figure { label: string; value: string; caption?: string; }

const METRIC_LABEL: Record<Metric, string> = { price: "가격", count: "건수" };

function statValue(s: { medPerM2: number | null; n: number }, metric: Metric): number | null {
  return metric === "price" ? s.medPerM2 : s.n;
}

function topBy<T>(items: T[], pick: (t: T) => number | null): T | null {
  let best: T | null = null;
  let bestV = -Infinity;
  for (const it of items) {
    const v = pick(it);
    if (typeof v === "number" && Number.isFinite(v) && v > bestV) { best = it; bestV = v; }
  }
  return best;
}

function guFigures(stat: Stat | null): { figures: Figure[]; notes: string[] } {
  const figures: Figure[] = [
    { label: "㎡당 중앙값", value: fmtPerM2(stat?.medPerM2) },
    { label: "거래", value: stat ? fmtCount(stat.n) : NO_TRADE },
    { label: "최고가", value: fmtAmt(stat?.maxAmt) },
  ];
  const notes: string[] = [];
  if (stat && stat.cancelled > 0) notes.push(`취소된 ${fmtCount(stat.cancelled)}은 뺐습니다.`);
  if (stat?.truncated) notes.push("거래가 많아 1,000건까지만 집계했습니다.");
  return { figures, notes };
}

function overviewFigures(entries: Array<[string, Stat]>): Figure[] {
  const topPrice = topBy(entries, ([, s]) => s.medPerM2);
  const topAmt = topBy(entries, ([, s]) => s.maxAmt);
  const total = entries.length ? entries.reduce((sum, [, s]) => sum + s.n, 0) : null;
  return [
    { label: "㎡당 중앙값 1위", value: fmtPerM2(topPrice?.[1].medPerM2), caption: topPrice?.[0] },
    { label: "거래 합계", value: fmtCount(total) },
    { label: "최고가", value: fmtAmt(topAmt?.[1].maxAmt), caption: topAmt?.[0] },
  ];
}

function renderFigures(figures: Figure[]): string {
  return `<dl class="figs">${figures
    .map((f) => `<div class="fig"><dt>${esc(f.label)}</dt><dd>${figure(f.value)}${
      f.caption ? `<span class="fig-caption">${esc(f.caption)}</span>` : ""}</dd></div>`)
    .join("")}</dl>`;
}

const TOP_DONGS = 5;

/**
 * 법정동 상위 5개(CONTRACTS 8절 보강): 3D 라벨이 흔들려도 숫자는 2D에서 읽히게.
 * 가격 지표는 데이터 순서(medPerM2 내림차순, null 뒤) 그대로, 건수 지표는 n 내림차순(같으면 데이터 순서).
 * 각 줄: 순위, 이름, 현재 지표 값, 다른 지표 값(가격이면 건수, 건수이면 ㎡당 중앙값).
 */
function renderDongs(data: GuData, metric: Metric): string {
  if (data.dongs.length === 0) return "";
  const ordered = metric === "price" ? data.dongs : [...data.dongs].sort((a, b) => b.n - a.n);
  const top = ordered.slice(0, TOP_DONGS);
  const title = metric === "price" ? "㎡당 중앙값 상위 법정동" : "거래가 많은 법정동";
  const rows = top.map((d, i) => {
    const main = metric === "price" ? fmtPerM2(d.medPerM2) : fmtCount(d.n);
    const sub = metric === "price" ? fmtCount(d.n) : fmtPerM2(d.medPerM2);
    const none = main === NO_TRADE ? " dong--none" : "";
    return `<li class="dong${none}"><span class="dong-rank">${i + 1}</span> <span class="dong-name">${esc(d.name)}</span> ` +
      `<span class="dong-val">${figure(main)}</span> <span class="dong-sub">${esc(sub)}</span></li>`;
  }).join("");
  return `<section class="dongs" aria-labelledby="dongs-title"><h3 class="dongs-title" id="dongs-title">${title}</h3>` +
    `<ol class="dong-list">${rows}</ol></section>`;
}

function renderLegend(scope: string, metric: Metric, values: Array<number | null>): string {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return "";
  const lo = fmtNumber(Math.min(...nums));
  const hi = fmtNumber(Math.max(...nums));
  const what = metric === "price" ? "㎡당 중앙값(만원)" : "거래(건)";
  return `<p class="legend" aria-label="${esc(`${scope} ${what} 색: 최저 ${lo}, 최고 ${hi}. 따뜻한 색일수록 높습니다`)}">` +
    `<span class="legend-what">${esc(`${scope} ${what}`)}</span>` +
    `<span class="legend-lo">${esc(lo)}</span><span class="legend-ramp" aria-hidden="true"></span><span class="legend-hi">${esc(hi)}</span></p>`;
}

function renderLive(state: AppState): string {
  if (!state.follow) {
    return `<div class="live live--off"><span class="live-text">직접 보는 중</span>` +
      `<button type="button" class="btn-follow" data-action="follow">라이브로 돌아가기</button></div>`;
  }
  if (state.conn === "open") {
    return `<p class="live live--on" title="발표자 화면을 따라갑니다"><span class="live-dot" aria-hidden="true"></span>` +
      `<span class="live-text">라이브</span><span class="vh">: 발표자 화면을 따라가는 중</span></p>`;
  }
  if (state.conn === "error" || state.conn === "closed") {
    return `<p class="live live--down"><span class="live-mark" aria-hidden="true">!</span><span class="live-text">연결 끊김</span></p>`;
  }
  return `<p class="live live--wait"><span class="live-text">연결 중</span></p>`;
}

function renderControls(state: AppState, index: DataIndex | null, opts: SheetOptions): string {
  const seg = (["price", "count"] as const)
    .map((m) => `<button type="button" data-action="metric" data-value="${m}" aria-pressed="${state.metric === m}">${METRIC_LABEL[m]}</button>`)
    .join("");
  const guOptions = [`<option value=""${state.gu === null ? " selected" : ""}>서울 전체</option>`]
    .concat((index?.gus ?? []).map((g) => `<option value="${esc(g)}"${g === state.gu ? " selected" : ""}>${esc(g)}</option>`))
    .join("");
  const months = index?.months ?? [];
  const monthOptions = (months.includes(state.month) || !state.month ? months : [...months, state.month])
    .map((m) => `<option value="${esc(m)}"${m === state.month ? " selected" : ""}>${esc(fmtMonth(m))}</option>`)
    .join("");
  const alt = opts.altView ? `<a class="alt-view" href="${esc(opts.altView.href)}">${esc(opts.altView.label)}</a>` : "";
  return `<div class="sheet-row">` +
    `<div class="seg" role="group" aria-label="막대와 색의 기준">${seg}</div>${alt}</div>` +
    `<div class="sheet-row sheet-pick">` +
    `<label class="pick"><span class="pick-label">자치구</span><select data-action="gu">${guOptions}</select></label>` +
    `<label class="pick"><span class="pick-label">월</span><select data-action="month">${monthOptions}</select></label>` +
    `</div>`;
}

export function renderSheet(state: AppState, data: GuData | null, index: DataIndex | null, opts: SheetOptions = {}): string {
  const monthSummary = index?.summary[state.month] ?? {};
  let title: string;
  let figures: Figure[];
  let notes: string[] = [];
  let legend: string;
  let dongs = "";

  if (state.gu) {
    const fresh = data && data.month === state.month && data.gu === state.gu ? data : null;
    const stat = fresh?.total ?? monthSummary[state.gu] ?? null;
    title = state.gu;
    ({ figures, notes } = guFigures(stat));
    if (stat && stat.n === 0) notes.unshift(`${fmtMonth(state.month)}에는 신고된 매매 거래가 없습니다.`);
    legend = fresh ? renderLegend("동별", state.metric, fresh.dongs.map((d) => statValue(d, state.metric))) : "";
    dongs = fresh ? renderDongs(fresh, state.metric) : "";
  } else {
    const entries = (index?.gus ?? Object.keys(monthSummary))
      .map((g): [string, Stat | undefined] => [g, monthSummary[g]])
      .filter((e): e is [string, Stat] => e[1] !== undefined);
    title = "서울 전체";
    figures = overviewFigures(entries);
    if (entries.length === 0) notes = [`${fmtMonth(state.month)} 자료가 없습니다.`];
    legend = renderLegend("구별", state.metric, entries.map(([, s]) => statValue(s, state.metric)));
  }

  return `<section class="sheet" aria-label="고른 지역의 실거래 요약">` +
    `<header class="sheet-head"><div class="sheet-where"><h2 class="sheet-title">${esc(title)}</h2>` +
    `<p class="sheet-month">${esc(fmtMonth(state.month))} 매매 실거래</p></div>${renderLive(state)}</header>` +
    (opts.tuningNote ? `<p class="sheet-tuning">${esc(opts.tuningNote)}</p>` : "") +
    renderFigures(figures) +
    dongs +
    (notes.length ? `<p class="sheet-note">${notes.map(esc).join(" ")}</p>` : "") +
    legend +
    renderControls(state, index, opts) +
    `</section>`;
}
