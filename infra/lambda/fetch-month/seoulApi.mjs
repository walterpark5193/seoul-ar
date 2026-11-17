// 서울 열린데이터광장 부동산 실거래가(tbLnOpendataRtmsV) 클라이언트.
// 참고 구현: ~/claude-lab/capstone/seoul-realestate/server.py 의 _fetch_page / fetch_trades / filter_rows.
//
// URL: {BASE_URL}/{key}/json/{SERVICE}/{start}/{end}/{RCPT_YR}/%20/{CGG_NM}/
//   - start/end 는 1부터 세는 행 번호(한 번에 최대 1000건)
//   - 선택 인자는 순서대로 RCPT_YR(접수연도) / CGG_CD(자치구코드) / CGG_NM(자치구명). 코드 자리는 공백(%20)으로 비운다.
// 응답: {SERVICE: {list_total_count, RESULT: {CODE, MESSAGE}, row: [...]}}, 오류나 데이터 없음은 최상위 {RESULT: ...} 만 오기도 한다.
//   INFO-000 정상, INFO-200 해당 데이터 없음(빈 결과), 그 외 코드는 오류.
//
// 규칙: URL 에는 키가 들어 있으므로 예외 메시지, cause, 로그 어디에도 URL 이나 원래 예외를 붙이지 않는다.

export const SERVICE = "tbLnOpendataRtmsV";
export const BASE_URL = "http://openapi.seoul.go.kr:8088"; // 이 API 는 8088 포트 HTTP 로만 열려 있다(server.py 와 같음)
export const PAGE_SIZE = 1000; // 명세: 한 번에 최대 1000건
export const MAX_PAGES = 12; // 구 하나에 부르는 최대 페이지 수(CONTRACTS 10.3)
const TIMEOUT_MS = 30_000;
const CODE_RE = /^[A-Z]{2,10}-\d{1,4}$/;

/** 사용자에게 보여도 되는 오류. message 는 짧은 한국어 구절이고 키·URL 이 없다. */
export class SeoulApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SeoulApiError";
    this.code = code;
  }
}

export function buildPageUrl(key, start, end, year, gu) {
  const path = [encodeURIComponent(key), "json", SERVICE, String(start), String(end), year, "%20", encodeURIComponent(gu)].join("/");
  return `${BASE_URL}/${path}/`;
}

function describeCode(code) {
  if (code === "INFO-100") return "서울 열린데이터광장 인증키 오류 INFO-100";
  return `서울 열린데이터광장 오류 ${code}`;
}

/** 응답 JSON → { rows, totalCount }. INFO-200 은 빈 결과. 그 밖의 코드는 SeoulApiError. */
export function parsePage(data) {
  const body = data && typeof data === "object" && !Array.isArray(data) ? data[SERVICE] ?? data : null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SeoulApiError("서울 열린데이터광장 응답 형식이 예상과 다름", "FORMAT");
  }
  const result = body.RESULT && typeof body.RESULT === "object" ? body.RESULT : {};
  const rawCode = typeof result.CODE === "string" ? result.CODE.trim() : "";
  const code = CODE_RE.test(rawCode) ? rawCode : "UNKNOWN";
  if (code === "INFO-200") return { rows: [], totalCount: 0 };
  if (code !== "INFO-000") throw new SeoulApiError(describeCode(code), code); // API 의 MESSAGE 는 옮기지 않는다
  const rows = Array.isArray(body.row) ? body.row : [];
  const total = Number(body.list_total_count);
  return { rows, totalCount: Number.isFinite(total) ? total : null };
}

async function fetchOnce({ fetch, url, timeoutMs }) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  } catch {
    // 원래 예외(메시지에 URL 이 섞인다)는 버린다
    throw new SeoulApiError("서울 열린데이터광장 연결 실패", "NETWORK");
  }
  if (!res.ok) throw new SeoulApiError(`서울 열린데이터광장 응답 오류 HTTP ${Number(res.status) || 0}`, "HTTP");
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SeoulApiError("서울 열린데이터광장 응답 형식이 예상과 다름", "FORMAT");
  }
  return parsePage(data);
}

const RETRYABLE = new Set(["NETWORK", "HTTP", "FORMAT"]);

/** 한 페이지. 네트워크·HTTP·형식 오류는 retries 번 다시 시도한다(API 오류 코드는 다시 시도하지 않는다). */
export async function fetchPage({ fetch, key, start, end, year, gu, timeoutMs = TIMEOUT_MS, retries = 1 }) {
  const url = buildPageUrl(key, start, end, year, gu);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce({ fetch, url, timeoutMs });
    } catch (e) {
      if (attempt >= retries || !RETRYABLE.has(e.code)) throw e;
    }
  }
}

/** 계약 연월(CTRT_DAY 앞 6자리)과 자치구명이 맞는 행만. */
export function filterRows(rows, { month, gu }) {
  return rows.filter((r) => String(r.CTRT_DAY ?? "").slice(0, 6) === month && (gu === undefined || r.CGG_NM === gu));
}

/** 페이지에서 가장 오래된 계약일(YYYYMMDD). 형식이 맞는 값이 없으면 null. */
export function oldestContractDay(rows) {
  let oldest = null;
  for (const r of rows) {
    const d = String(r.CTRT_DAY ?? "");
    if (/^\d{8}$/.test(d) && (oldest === null || d < oldest)) oldest = d;
  }
  return oldest;
}

/**
 * 구 하나, 한 달치. 접수연도 RCPT_YR = month 앞 4자리, CGG_NM = gu 로 1000건씩 부른다.
 * 결과는 최근 계약부터 오므로 다음 중 하나면 멈춘다:
 *   - 한 페이지가 pageSize 미만
 *   - 페이지의 가장 오래된 CTRT_DAY 가 그 달 1일보다 앞섬
 *   - list_total_count 까지 다 받음(빈 다음 페이지를 부르지 않는다)
 *   - maxPages 에 닿음 → capped: true (그 달 앞부분이 빠졌을 수 있다)
 * beforePage() 는 페이지마다 호출 전에 부른다(작업자 마감 검사). 던지면 그대로 올라간다.
 * @returns {{ rows: object[], pages: number, capped: boolean }}
 */
export async function fetchMonthRows({ fetch, key, gu, month, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, timeoutMs, retries, beforePage }) {
  const year = month.slice(0, 4);
  const monthStart = `${month}01`;
  const found = [];
  let pages = 0;
  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize + 1;
    const end = start + pageSize - 1;
    beforePage?.();
    const { rows, totalCount } = await fetchPage({ fetch, key, start, end, year, gu, timeoutMs, retries });
    pages++;
    for (const r of filterRows(rows, { month, gu })) found.push(r);
    if (rows.length < pageSize) return { rows: found, pages, capped: false };
    const oldest = oldestContractDay(rows);
    if (oldest !== null && oldest < monthStart) return { rows: found, pages, capped: false };
    if (totalCount !== null && end >= totalCount) return { rows: found, pages, capped: false };
  }
  return { rows: found, pages, capped: true };
}
