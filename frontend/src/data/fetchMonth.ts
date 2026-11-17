// 발표자 "월 가져오기" 요청 (CONTRACTS 10.2). 같은 출처의 상대 경로로 보낸다(CloudFront /api/* → Lambda).
// 응답 코드를 화면이 다룰 결과로 바꾸기만 한다. 문구는 views/monthFetch.ts가 정한다.

export const FETCH_MONTH_PATH = "/api/fetch-month";

export type FetchMonthResult =
  | { kind: "started"; jobId: string; month: string }
  | { kind: "bad-month" }      // 400
  | { kind: "unauthorized" }   // 401
  | { kind: "busy" }           // 409
  | { kind: "unavailable" }    // 404: 이 배포에 수집 기능이 없다(개발 서버 등)
  | { kind: "network" }        // 요청 자체가 실패
  | { kind: "failed"; status: number };

export async function requestFetchMonth(month: string, passcode: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<FetchMonthResult> {
  let res: Response;
  try {
    res = await fetchImpl(FETCH_MONTH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-presenter-key": passcode },
      body: JSON.stringify({ month }),
      cache: "no-store",
    });
  } catch {
    return { kind: "network" };
  }
  if (res.status === 400) return { kind: "bad-month" };
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 409) return { kind: "busy" };
  if (res.status === 404) return { kind: "unavailable" };
  if (res.status !== 202) return { kind: "failed", status: res.status };
  const body = (await res.json().catch(() => null)) as { jobId?: unknown; month?: unknown } | null;
  if (!body || typeof body.jobId !== "string" || body.jobId.length === 0) return { kind: "failed", status: res.status };
  return { kind: "started", jobId: body.jobId, month: typeof body.month === "string" ? body.month : month };
}
