// 연도 작업(Task 13) 도우미: 접수연도 한 해를 구마다 한 번 받아 계약 연월로 나눈다.
import { guKey } from "./job.mjs";

export const MIN_YEAR = "2006";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const kst = (nowMs) => new Date(nowMs + KST_OFFSET_MS);

/** YYYY, 2006 이상, 한국 시간 올해 이하. */
export function validateYear(year, nowMs) {
  if (typeof year !== "string" || !/^\d{4}$/.test(year)) return { ok: false, message: "year 는 YYYY 형식(예: 2024)이어야 합니다." };
  const current = String(kst(nowMs).getUTCFullYear());
  if (year < MIN_YEAR) return { ok: false, message: "2006년부터 가져올 수 있습니다." };
  if (year > current) return { ok: false, message: `올해(${current}년)까지만 가져올 수 있습니다.` };
  return { ok: true };
}

/** 그 해에 있어야 할 달: 지난해는 12개월, 올해는 한국 시간 이번 달까지. */
export function expectedMonths(year, nowMs) {
  const d = kst(nowMs);
  const last = Number(year) === d.getUTCFullYear() ? d.getUTCMonth() + 1 : 12;
  return Array.from({ length: last }, (_, i) => `${year}${String(i + 1).padStart(2, "0")}`);
}

/**
 * 행을 계약 연월(CTRT_DAY 앞 6자리)로 나눈다. 그 해가 아닌 행(1월에 신고된 전년 12월 계약 등)과
 * allowedMonths 밖의 달(올해의 다음 달 이후, 형식 오류)은 버린다.
 * @returns {Map<string, object[]>}
 */
export function bucketByMonth(rows, year, allowedMonths) {
  const allowed = new Set(allowedMonths);
  const buckets = new Map();
  for (const r of rows) {
    const month = String(r.CTRT_DAY ?? "").slice(0, 6);
    if (!month.startsWith(year) || !allowed.has(month)) continue;
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(r);
  }
  return buckets;
}

/** resume: 그 구의 기대한 달 파일(data/{YYYYMM}/{gu}.json)이 모두 있으면 완료. */
export function isGuComplete(existingKeys, gu, months) {
  return months.every((m) => existingKeys.has(guKey(m, gu)));
}

/** 연도 작업 JobMessage 의 month 필드: "YYYY00"(YYYYMM 모양을 지키며 "한 해 전체"를 뜻한다). */
export const yearJobMonth = (year) => `${year}00`;
