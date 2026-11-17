// 숫자 포맷. 입력 금액은 모두 만원 정수. 값이 없으면 "거래 없음".

export const NO_TRADE = "거래 없음";

const valid = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** 정수부에 천 단위 쉼표. 로캘에 기대지 않는다. */
function group(intText: string): string {
  return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtNumber(x: number | null | undefined): string {
  return valid(x) ? group(String(Math.round(x))) : NO_TRADE;
}

/** 2890 → "2,890만원" */
export function fmtManwon(x: number | null | undefined): string {
  return valid(x) ? `${fmtNumber(x)}만원` : NO_TRADE;
}

/** 2890 → "2,890만원/㎡" */
export function fmtPerM2(x: number | null | undefined): string {
  return valid(x) ? `${fmtManwon(x)}/㎡` : NO_TRADE;
}

/** 526000 → "52.6억", 180000 → "18억", 8500 → "8,500만" */
export function fmtAmt(x: number | null | undefined): string {
  if (!valid(x)) return NO_TRADE;
  if (Math.abs(x) < 10000) return `${fmtNumber(x)}만`;
  const [int, dec] = (Math.round(x / 1000) / 10).toFixed(1).split(".");
  return `${group(int!)}${dec && dec !== "0" ? `.${dec}` : ""}억`;
}

/** 34 → "34건" */
export function fmtCount(n: number | null | undefined): string {
  return valid(n) ? `${fmtNumber(n)}건` : NO_TRADE;
}

/** "202611" → "2026년 11월" */
export function fmtMonth(yyyymm: string): string {
  const m = /^(\d{4})(\d{2})$/.exec(yyyymm);
  return m ? `${m[1]}년 ${Number(m[2])}월` : yyyymm;
}
