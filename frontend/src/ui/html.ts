// 문자열 템플릿용 이스케이프. 데이터에서 온 글자는 모두 이것을 거친다.

const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => MAP[c]!);
}

/** "2,890만원/㎡" → 큰 숫자 + 작은 단위. 숫자가 없으면(거래 없음) 단위 칸 없이 그대로. */
export function figure(text: string): string {
  const m = /^([\d,.]+)(.*)$/.exec(text);
  if (!m) return `<span class="fig-none">${esc(text)}</span>`;
  return `<span class="fig-num">${esc(m[1])}</span><span class="fig-unit">${esc(m[2])}</span>`;
}
