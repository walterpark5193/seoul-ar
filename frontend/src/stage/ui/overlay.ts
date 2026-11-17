// 미리보기·골격·커서·진단. 계약: docs/CONTRACTS-stage.md 8절. 순수 모듈(DOM 없음).
import type { HandFrame, InputMode, Point } from "../types";

export type PreviewMode = "video" | "skeleton" | "hidden";

const NEXT: Record<PreviewMode, PreviewMode> = { video: "skeleton", skeleton: "hidden", hidden: "video" };
export function nextPreviewMode(m: PreviewMode): PreviewMode { return NEXT[m]; }

/** MediaPipe 손 21점 연결(손바닥 + 다섯 손가락). */
export const HAND_CONNECTIONS: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export interface Ctx2DLike {
  clearRect(...a: number[]): void; beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  stroke(): void; arc(x: number, y: number, r: number, a: number, b: number): void; fill(): void;
  strokeStyle: unknown; fillStyle: unknown; lineWidth: number;
}

export function drawSkeleton(ctx: Ctx2DLike, frame: HandFrame, w: number, h: number, mirror: boolean): void {
  ctx.clearRect(0, 0, w, h);
  const px = (x: number) => (mirror ? w - x * w : x * w);
  ctx.strokeStyle = "#38bdf8";
  ctx.fillStyle = "#fbbf24";
  ctx.lineWidth = 2;
  for (const hand of frame.hands) {
    const lm = hand.landmarks;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(px(lm[a][0]), lm[a][1] * h);
      ctx.lineTo(px(lm[b][0]), lm[b][1] * h);
      ctx.stroke();
    }
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(px(p[0]), p[1] * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function cursorClass(o: { visible: boolean; fist: boolean; hovering: boolean }): string {
  return "stage-cursor" + (o.visible ? "" : " is-hidden") + (o.fist ? " is-fist" : "") + (o.hovering ? " is-hover" : "");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderDiag(d: { fps: number; hands: number; gesture: string; score: number; cursor: Point | null; loadMs: number | null; delegate: string | null; input: InputMode }): string {
  const cursor = d.cursor ? `${d.cursor.x.toFixed(2)}, ${d.cursor.y.toFixed(2)}` : "—";
  const rows: [string, string][] = [
    ["프레임", `${d.fps.toFixed(0)} fps`],
    ["손", `${d.hands}개`],
    ["제스처", `${d.gesture} (${d.score.toFixed(2)})`],
    ["커서", cursor],
    ["모델 로드", d.loadMs == null ? "—" : `${Math.round(d.loadMs)} ms`],
    ["연산", d.delegate ?? "—"],
    ["입력", d.input === "hands" ? "손" : "마우스"],
  ];
  return `<dl class="stage-diag">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}
