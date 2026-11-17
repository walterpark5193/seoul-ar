// 발표자 "월 가져오기"(CONTRACTS 10.2)와 "해설 생성"(12.2) 요청. 같은 출처의 상대 경로로 보낸다(CloudFront /api/* → Lambda).
// 응답 코드를 화면이 다룰 결과로 바꾸기만 한다. 문구는 views/monthFetch.ts가 정한다.

import { sha256Hex } from "./sha256";

export const FETCH_MONTH_PATH = "/api/fetch-month";

export type FetchMonthResult =
  | { kind: "started"; jobId: string; month: string }
  | { kind: "bad-month" }      // 400
  | { kind: "unauthorized" }   // 401
  | { kind: "busy" }           // 409
  | { kind: "unavailable" }    // 404: 이 배포에 수집 기능이 없다(개발 서버 등)
  | { kind: "network" }        // 요청 자체가 실패, 또는 2xx인데 JSON·jobId가 아님(SPA 폴백 HTML)
  | { kind: "failed"; status: number };

export const NARRATE_MONTH_PATH = "/api/narrate-month";

export function requestFetchMonth(month: string, passcode: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<FetchMonthResult> {
  return requestJob(FETCH_MONTH_PATH, month, passcode, fetchImpl);
}

/** AI 해설 생성(CONTRACTS 12.2 b). 응답 규칙은 월 수집과 같다. */
export function requestNarrateMonth(month: string, passcode: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<FetchMonthResult> {
  return requestJob(NARRATE_MONTH_PATH, month, passcode, fetchImpl);
}

async function requestJob(path: string, month: string, passcode: string, fetchImpl: typeof fetch): Promise<FetchMonthResult> {
  const payload = JSON.stringify({ month }); // 해시와 전송에 같은 문자열을 쓴다
  const headers: Record<string, string> = { "content-type": "application/json", "x-presenter-key": passcode };
  // CloudFront OAC(SigV4)가 지키는 Lambda URL은 POST 본문의 SHA-256(정확히 보내는 문자열)을 요구한다.
  // 없으면 Lambda가 403 → CloudFront가 index.html 200으로 바꿔 아래 JSON 검사에서 네트워크 오류가 된다.
  try {
    headers["x-amz-content-sha256"] = await sha256Hex(payload);
  } catch (err) {
    console.warn("[host] 본문 해시를 만들지 못함(보안 컨텍스트가 아닌 주소?)", err);
  }
  let res: Response;
  try {
    res = await fetchImpl(path, { method: "POST", headers, body: payload, cache: "no-store" });
  } catch {
    return { kind: "network" };
  }
  if (res.status === 400) return { kind: "bad-month" };
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 409) return { kind: "busy" };
  if (res.status === 404) return { kind: "unavailable" };
  if (!res.ok) return { kind: "failed", status: res.status };
  // CloudFront의 403/404 → index.html(200) 오류 응답은 /api/*에도 걸린다. Function URL 설정이 틀리면
  // 200 HTML이 오므로, JSON이 아니거나 jobId가 없는 2xx는 수집 서버에 닿지 못한 것(네트워크 오류)으로 본다.
  const body = (await res.json().catch(() => null)) as { jobId?: unknown; month?: unknown } | null;
  if (!body || typeof body !== "object" || typeof body.jobId !== "string" || body.jobId.length === 0) return { kind: "network" };
  return { kind: "started", jobId: body.jobId, month: typeof body.month === "string" ? body.month : month };
}
