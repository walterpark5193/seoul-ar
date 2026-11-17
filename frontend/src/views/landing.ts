// #/ 랜딩: 제목이 25개 구의 실제 ㎡당 중앙값으로 그린 스카이라인 위에 선다.
import type { DataIndex } from "../data/types";
import { fmtMonth, fmtPerM2 } from "../ui/format";
import { esc } from "../ui/html";
import type { MountView } from "./types";

const MIN_H = 0.14;

function renderSkyline(index: DataIndex, order: string[]): string {
  const month = index.months.at(-1) ?? "";
  const summary = index.summary[month] ?? {};
  const names = order.filter((g) => index.gus.includes(g));
  const gus = names.length === index.gus.length ? names : index.gus;
  const values = gus.map((g) => summary[g]?.medPerM2 ?? null);
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return "";
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo;

  const bars = gus.map((g, i) => {
    const v = values[i];
    const label = `${g} ${fmtPerM2(v ?? null)}`;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return `<span class="bar bar--none" title="${esc(label)}"></span>`;
    }
    const t = span > 0 ? (v - lo) / span : 0.5;
    const h = (MIN_H + (1 - MIN_H) * t).toFixed(3);
    return `<span class="bar" style="--h:${h}" title="${esc(label)}"></span>`;
  }).join("");

  const topIdx = values.indexOf(hi);
  const top = gus[topIdx] ?? "";
  const aria = `${fmtMonth(month)} 구별 ㎡당 중앙값. 가장 높은 곳은 ${top} ${fmtPerM2(hi)}`;
  return `<figure class="skyline" role="img" aria-label="${esc(aria)}">` +
    `<div class="skyline-bars">${bars}</div>` +
    `<figcaption class="skyline-cap">${esc(fmtMonth(month))}, 서울 25개 구의 ㎡당 중앙값. 높을수록 비쌉니다.</figcaption>` +
    `</figure>`;
}

/** order: 스카이라인의 구 순서(main은 서쪽→동쪽을 넘긴다). 없으면 index.gus 순서. */
export function renderLanding(index: DataIndex | null, order: string[] = []): string {
  const skyline = index ? renderSkyline(index, order) : "";
  return `<main class="landing">` +
    `<a class="landing-host" href="#/host">발표자</a>` +
    `<div class="landing-hero">` +
    `<h1 class="landing-title"><span>서울이</span> <span>선다</span></h1>` +
    `<p class="landing-lede">발표 화면의 그림을 폰으로 비추면, 그 위에 서울 25개 구가 실거래가만큼 솟아오릅니다.</p>` +
    `</div>` +
    (skyline || `<div class="skyline skyline--empty" aria-hidden="true"></div>`) +
    `<nav class="landing-actions" aria-label="보는 방법">` +
    `<a class="btn btn-primary" href="#/ar">카메라로 보기</a>` +
    `<a class="btn btn-secondary" href="#/3d">3D로 보기</a>` +
    `</nav>` +
    `<p class="landing-source">자료: ${esc(index?.source ?? "서울 열린데이터광장 부동산 실거래가")}</p>` +
    `</main>`;
}

export function createLandingView(order: string[]): MountView {
  return (root, ctx) => {
    root.innerHTML = renderLanding(ctx.index, order);
    return () => { root.innerHTML = ""; };
  };
}
