// YYYYMM 달 계산(로컬 시각 기준). 서버가 최종 판정하고(CONTRACTS 10.2), 화면은 미리 걸러 친절하게 알린다.

export const MIN_MONTH = "200601";

export function currentMonth(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(yyyymm: string, delta: number): string {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6)) - 1 + delta;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}${String(mm + 1).padStart(2, "0")}`;
}

/** MIN_MONTH 이상, 이번 달 이하 */
export function inFetchRange(yyyymm: string, now: number): boolean {
  return yyyymm >= MIN_MONTH && yyyymm <= currentMonth(now);
}
