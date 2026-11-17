import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SERVICE, BASE_URL, PAGE_SIZE, MAX_PAGES, SeoulApiError,
  buildPageUrl, parsePage, fetchPage, filterRows, newestContractDay, fetchMonthRows, fetchYearRows, YEAR_MAX_PAGES,
} from "./seoulApi.mjs";
import { fakeSeoulFetch, jsonResponse, row, FAKE_KEY } from "./fakes.mjs";

/** n 개 행, 계약일을 from 부터 하루씩(같은 달 안에서) 거꾸로 */
function rowsOn(day, n, over = {}) {
  return Array.from({ length: n }, () => row({ CTRT_DAY: day, ...over }));
}

describe("URL 구성 (server.py _fetch_page 와 같은 경로)", () => {
  test("상수", () => {
    assert.equal(SERVICE, "tbLnOpendataRtmsV");
    assert.equal(BASE_URL, "http://openapi.seoul.go.kr:8088");
    assert.equal(PAGE_SIZE, 1000);
    assert.equal(MAX_PAGES, 30);
  });

  test("/{key}/json/{SERVICE}/{start}/{end}/{RCPT_YR}/%20/{CGG_NM}/ — 키와 구 이름은 퍼센트 인코딩, 자치구코드 자리는 %20", () => {
    assert.equal(
      buildPageUrl("ab/c+d", 1001, 2000, "2026", "강남구"),
      "http://openapi.seoul.go.kr:8088/ab%2Fc%2Bd/json/tbLnOpendataRtmsV/1001/2000/2026/%20/%EA%B0%95%EB%82%A8%EA%B5%AC/",
    );
  });
});

describe("parsePage", () => {
  test("INFO-000 은 row 와 list_total_count", () => {
    const out = parsePage({ [SERVICE]: { list_total_count: 3, RESULT: { CODE: "INFO-000", MESSAGE: "정상" }, row: [row(), row(), row()] } });
    assert.equal(out.rows.length, 3);
    assert.equal(out.totalCount, 3);
  });

  test("INFO-000 인데 row 가 없으면 빈 배열", () => {
    assert.deepEqual(parsePage({ [SERVICE]: { RESULT: { CODE: "INFO-000" } } }).rows, []);
  });

  test("INFO-200 (최상위 RESULT) 은 빈 결과", () => {
    const out = parsePage({ RESULT: { CODE: "INFO-200", MESSAGE: "해당하는 데이터가 없습니다." } });
    assert.deepEqual(out.rows, []);
  });

  test("INFO-200 (서비스 아래 RESULT) 도 빈 결과", () => {
    assert.deepEqual(parsePage({ [SERVICE]: { RESULT: { CODE: "INFO-200" } } }).rows, []);
  });

  test("그 외 코드는 SeoulApiError(code), 메시지에 API 가 준 MESSAGE 를 넣지 않는다", () => {
    assert.throws(
      () => parsePage({ RESULT: { CODE: "INFO-100", MESSAGE: `인증키 ${FAKE_KEY} 가 유효하지 않습니다` } }),
      (e) => e instanceof SeoulApiError && e.code === "INFO-100" && !e.message.includes(FAKE_KEY),
    );
    assert.throws(() => parsePage({ RESULT: { CODE: "ERROR-500" } }), (e) => e.code === "ERROR-500");
  });

  test("이상한 코드 문자열은 UNKNOWN 으로 바꾼다", () => {
    assert.throws(() => parsePage({ RESULT: { CODE: `<${FAKE_KEY}>` } }), (e) => e.code === "UNKNOWN" && !e.message.includes(FAKE_KEY));
  });

  test("객체가 아니면 형식 오류", () => {
    assert.throws(() => parsePage("nope"), SeoulApiError);
    assert.throws(() => parsePage(null), SeoulApiError);
  });
});

describe("filterRows / newestContractDay", () => {
  test("CTRT_DAY 앞 6자리가 month 이고 CGG_NM 이 gu 인 행만", () => {
    const rows = [
      row({ CTRT_DAY: "20261031" }),
      row({ CTRT_DAY: "20261001" }),
      row({ CTRT_DAY: "20260930" }),
      row({ CTRT_DAY: "20261101" }),
      row({ CTRT_DAY: "20261015", CGG_NM: "서초구" }),
      row({ CTRT_DAY: "" }),
      row({ CTRT_DAY: undefined }),
    ];
    const out = filterRows(rows, { month: "202610", gu: "강남구" });
    assert.deepEqual(out.map((r) => r.CTRT_DAY), ["20261031", "20261001"]);
  });

  test("가장 최근 계약일, 형식이 맞는 것만 본다", () => {
    assert.equal(newestContractDay([row({ CTRT_DAY: "20260912" }), row({ CTRT_DAY: "20261003" }), row({ CTRT_DAY: "x" })]), "20261003");
    assert.equal(newestContractDay([row({ CTRT_DAY: "" })]), null);
    assert.equal(newestContractDay([]), null);
  });
});

describe("fetchPage: 키와 URL 을 오류에 넣지 않는다", () => {
  const args = (fetch) => ({ fetch, key: FAKE_KEY, start: 1, end: 1000, year: "2026", gu: "강남구", retries: 0, sleep: async () => {} });
  const clean = (e) => {
    const text = `${e.message}\n${e.stack}\n${String(e.cause ?? "")}`;
    assert.ok(!text.includes(FAKE_KEY), "키 없음");
    assert.ok(!text.includes("openapi.seoul.go.kr"), "호스트 없음");
    assert.ok(!/https?:\/\//.test(e.message), "URL 없음");
    assert.equal(e.cause, undefined);
    return true;
  };

  test("네트워크 예외(메시지에 URL 포함)를 감싸 원인을 버린다", async () => {
    const fetch = async (url) => { throw new TypeError(`fetch failed: ${url}`); };
    await assert.rejects(fetchPage(args(fetch)), (e) => e instanceof SeoulApiError && e.code === "NETWORK" && clean(e));
  });

  test("HTTP 오류", async () => {
    const fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(fetchPage(args(fetch)), (e) => e.code === "HTTP" && e.message.includes("503") && clean(e));
  });

  test("JSON 이 아닌 응답(본문에 키가 섞여 있어도)", async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token in ${FAKE_KEY}`); } });
    await assert.rejects(fetchPage(args(fetch)), (e) => e.code === "FORMAT" && clean(e));
  });

  test("API 오류 코드(MESSAGE 에 키가 섞여 있어도)", async () => {
    const fetch = async () => jsonResponse({ RESULT: { CODE: "ERROR-290", MESSAGE: `key=${FAKE_KEY}` } });
    await assert.rejects(fetchPage(args(fetch)), (e) => e.code === "ERROR-290" && clean(e));
  });

  test("네트워크·429·5xx·형식 오류는 1~2초 쉬고 한 번 다시 시도한다", async () => {
    const ok = fakeSeoulFetch({ 강남구: [row()] });
    const firstFails = [
      () => Promise.reject(new Error("socket hang up")),
      () => ({ ok: false, status: 429, json: async () => ({}) }),
      () => ({ ok: false, status: 503, json: async () => ({}) }),
      () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } }),
    ];
    for (const first of firstFails) {
      let n = 0;
      const sleeps = [];
      const fetch = async (url, init) => (++n === 1 ? first() : ok(url, init));
      const out = await fetchPage({ ...args(fetch), retries: 1, sleep: async (ms) => { sleeps.push({ ms, n }); } });
      assert.equal(n, 2);
      assert.equal(out.rows.length, 1);
      assert.equal(sleeps.length, 1);
      assert.ok(sleeps[0].ms >= 1000 && sleeps[0].ms <= 2000, String(sleeps[0].ms));
      assert.equal(sleeps[0].n, 1, "첫 시도 뒤, 재시도 전에 쉰다");
    }
  });

  test("4xx(429 제외)는 다시 시도하지 않는다", async () => {
    let n = 0;
    const fetch = async () => { n++; return { ok: false, status: 404, json: async () => ({}) }; };
    await assert.rejects(fetchPage({ ...args(fetch), retries: 1 }), (e) => e.code === "HTTP");
    assert.equal(n, 1);
  });

  test("API 오류 코드는 다시 시도하지 않는다", async () => {
    let n = 0;
    const fetch = async () => { n++; return jsonResponse({ RESULT: { CODE: "INFO-100" } }); };
    await assert.rejects(fetchPage({ ...args(fetch), retries: 1 }));
    assert.equal(n, 1);
  });

  test("요청에 타임아웃 signal 을 건다", async () => {
    const fetch = fakeSeoulFetch({});
    await fetchPage(args(fetch));
    assert.ok(fetch.calls[0].init?.signal, "AbortSignal");
  });
});

describe("fetchMonthRows: 페이지 멈춤 규칙", () => {
  const base = { key: FAKE_KEY, gu: "강남구", month: "202610", retries: 0, sleep: async () => {} };

  test("RCPT_YR = month 앞 4자리, CGG_NM = gu 로 부른다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: rowsOn("20261010", 3) });
    await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls[0].year, "2026");
    assert.equal(fetch.calls[0].gu, "강남구");
    assert.equal(fetch.calls[0].cggCd, "%20");
    assert.equal(fetch.calls[0].key, FAKE_KEY);
    assert.equal(fetch.calls[0].start, 1);
    assert.equal(fetch.calls[0].end, 1000);
  });

  test("한 페이지가 1000건 미만이면 한 번만 부른다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: [...rowsOn("20261105", 2), ...rowsOn("20261020", 5), ...rowsOn("20260915", 3)] });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 1);
    assert.equal(out.rows.length, 5);
    assert.equal(out.capped, false);
  });

  test("페이지의 가장 최근 CTRT_DAY 가 그 달 1일보다 앞서면(그 페이지 전부가 지난달 이전) 멈춘다", async () => {
    // 1쪽: 11월 500 + 10월 500, 2쪽: 10월 600 + 9월 400 (아직 10월이 있으니 계속), 3쪽: 8월 1000 → 멈춤, 4쪽은 부르지 않음
    const data = [...rowsOn("20261103", 500), ...rowsOn("20261012", 500), ...rowsOn("20261002", 600), ...rowsOn("20260920", 400), ...rowsOn("20260801", 1000), ...rowsOn("20260701", 1000)];
    const fetch = fakeSeoulFetch({ 강남구: data });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.deepEqual(fetch.calls.map((c) => c.start), [1, 1001, 2001]);
    assert.equal(out.rows.length, 1100);
    assert.equal(out.pages, 3);
    assert.equal(out.capped, false);
  });

  test("접수일 순처럼 계약일이 섞여 와도 그 달 행을 끝까지 모은다(가장 오래된 날로 멈추면 1쪽에서 끊긴다)", async () => {
    const mixed = (n) => Array.from({ length: n }, (_, i) => row({ CTRT_DAY: i % 2 === 0 ? "20261015" : "20260915" }));
    const data = [...mixed(1000), ...mixed(1000), ...rowsOn("20261020", 300)];
    const fetch = fakeSeoulFetch({ 강남구: data });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 3);
    assert.equal(out.rows.length, 500 + 500 + 300);
  });

  test("가장 오래된 계약일이 바로 1일이면 멈추지 않는다(그 달 안)", async () => {
    const data = [...rowsOn("20261001", 1000), ...rowsOn("20261001", 10)];
    const fetch = fakeSeoulFetch({ 강남구: data });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 2);
    assert.equal(out.rows.length, 1010);
  });

  test("최대 30페이지에서 멈추고 capped 를 알린다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: rowsOn("20261015", 31000) });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 30);
    assert.equal(fetch.calls.at(-1).start, 29001);
    assert.equal(out.rows.length, 30000);
    assert.equal(out.capped, true);
  });

  test("딱 30페이지로 끝나면(list_total_count) capped 가 아니다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: rowsOn("20261015", 30000) });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 30);
    assert.equal(out.capped, false);
  });

  test("list_total_count 에 닿으면 빈 다음 페이지를 부르지 않는다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: rowsOn("20261015", 2000) });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 2);
    assert.equal(out.rows.length, 2000);
    assert.equal(out.capped, false);
  });

  test("INFO-200 이면 빈 결과", async () => {
    const fetch = fakeSeoulFetch({});
    const out = await fetchMonthRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(out.rows, []);
    assert.equal(out.capped, false);
  });

  test("다른 달 행은 버린다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: [...rowsOn("20261102", 4), ...rowsOn("20261030", 2), ...rowsOn("20260929", 1)] });
    const out = await fetchMonthRows({ ...base, fetch });
    assert.ok(out.rows.every((r) => r.CTRT_DAY.startsWith("202610")));
    assert.equal(out.rows.length, 2);
  });

  test("페이지 오류는 그대로 올린다(키 없이)", async () => {
    const fetch = async () => jsonResponse({ RESULT: { CODE: "ERROR-336", MESSAGE: FAKE_KEY } });
    await assert.rejects(fetchMonthRows({ ...base, fetch }), (e) => e instanceof SeoulApiError && !e.message.includes(FAKE_KEY));
  });
});

describe("fetchMonthRows: beforePage (작업자 마감 검사)", () => {
  test("페이지마다 먼저 부르고, 던지면 그 자리에서 멈춘다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: rowsOn("20261015", 5000) });
    let n = 0;
    const beforePage = () => { if (++n === 3) throw new Error("마감"); };
    await assert.rejects(fetchMonthRows({ key: FAKE_KEY, gu: "강남구", month: "202610", retries: 0, sleep: async () => {}, fetch, beforePage }), /마감/);
    assert.equal(fetch.calls.length, 2);
  });
});

describe("fetchYearRows: 접수연도 전체 (연도 작업)", () => {
  const base = { key: FAKE_KEY, gu: "강남구", year: "2024", retries: 0, sleep: async () => {} };
  const days = (day, n, over = {}) => Array.from({ length: n }, () => row({ CTRT_DAY: day, ...over }));

  test("RCPT_YR = year, 가장 최근 계약일로 멈추지 않는다(전년 계약만 있는 페이지도 넘긴다)", async () => {
    const data = [...days("20241210", 1000), ...days("20231215", 1000), ...days("20240105", 400)];
    const fetch = fakeSeoulFetch({ 강남구: data });
    const out = await fetchYearRows({ ...base, fetch });
    assert.equal(fetch.calls.length, 3);
    assert.ok(fetch.calls.every((c) => c.year === "2024" && c.gu === "강남구"));
    assert.equal(out.rows.length, 2400, "다른 해 행도 돌려준다(달 나누기는 호출하는 쪽)");
    assert.equal(out.capped, false);
    assert.equal(out.pages, 3);
  });

  test("다른 구 행은 버린다", async () => {
    const fetch = fakeSeoulFetch({ 강남구: [row({ CTRT_DAY: "20240101" }), row({ CTRT_DAY: "20240102", CGG_NM: "서초구" })] });
    assert.equal((await fetchYearRows({ ...base, fetch })).rows.length, 1);
  });

  test("list_total_count 에서 멈추고, 상한은 60페이지(capped)", async () => {
    const exact = fakeSeoulFetch({ 강남구: days("20240301", 3000) });
    assert.equal((await fetchYearRows({ ...base, fetch: exact })).pages, 3);
    assert.equal(exact.calls.length, 3);
    assert.equal(YEAR_MAX_PAGES, 60);
    const huge = fakeSeoulFetch({ 강남구: days("20240301", 61000) });
    const out = await fetchYearRows({ ...base, fetch: huge });
    assert.equal(huge.calls.length, 60);
    assert.equal(out.capped, true);
    assert.equal(out.rows.length, 60000);
  });

  test("INFO-200 은 빈 결과, beforePage 를 페이지마다 부른다", async () => {
    let n = 0;
    const out = await fetchYearRows({ ...base, fetch: fakeSeoulFetch({}), beforePage: () => { n++; } });
    assert.deepEqual(out.rows, []);
    assert.equal(n, 1);
  });
});
