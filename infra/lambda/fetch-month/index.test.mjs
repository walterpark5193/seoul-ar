import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { validateMonth, currentMonthKst, passcodeMatches, createHandler, MIN_MONTH } from "./index.mjs";
import { LOCK_KEY, INDEX_KEY, isLockFresh } from "./job.mjs";
import { aggregateRows, buildIndex } from "./aggregate.mjs";
import { fakeDeps, fakeStore, fakeSeoulFetch, fakeConverse, bulkReply, httpEvent, row, jsonResponse, FAKE_KEY, AUTH_SECRET, GU_ORDER } from "./fakes.mjs";

const NOW = Date.UTC(2026, 10, 17, 3, 0, 0); // 2026-11-17 12:00 KST
const PASS = "open-sesame-2026"; // 12자 이상(발표자 암호 최소 길이)

describe("validateMonth", () => {
  test("YYYYMM 형식", () => {
    for (const bad of ["2026-10", "20261", "2026100", "abcdef", "", 202610, null, undefined, " 202610"]) {
      const v = validateMonth(bad, NOW);
      assert.equal(v.ok, false, String(bad));
      assert.match(v.message, /YYYYMM/);
    }
  });

  test("월은 01~12", () => {
    assert.equal(validateMonth("202600", NOW).ok, false);
    assert.equal(validateMonth("202613", NOW).ok, false);
    assert.equal(validateMonth("202601", NOW).ok, true);
    assert.equal(validateMonth("202512", NOW).ok, true);
  });

  test("하한 200601", () => {
    assert.equal(MIN_MONTH, "200601");
    assert.equal(validateMonth("200601", NOW).ok, true);
    const v = validateMonth("200512", NOW);
    assert.equal(v.ok, false);
    assert.match(v.message, /2006년 1월/);
  });

  test("상한은 주입된 now 의 이번 달(한국 시간)", () => {
    assert.equal(validateMonth("202611", NOW).ok, true);
    const v = validateMonth("202612", NOW);
    assert.equal(v.ok, false);
    assert.match(v.message, /2026년 11월/);
    // UTC 로는 11월 30일 15:30 이지만 한국은 12월 1일 00:30
    const kstDec = Date.UTC(2026, 10, 30, 15, 30);
    assert.equal(currentMonthKst(kstDec), "202612");
    assert.equal(validateMonth("202612", kstDec).ok, true);
    assert.equal(currentMonthKst(Date.UTC(2026, 10, 30, 14, 59)), "202611");
  });
});

describe("passcodeMatches", () => {
  test("같으면 true, 다르면 false, 길이가 달라도 예외 없이 false", () => {
    assert.equal(passcodeMatches("open-sesame", "open-sesame"), true);
    assert.equal(passcodeMatches("open-sesamE", "open-sesame"), false);
    assert.equal(passcodeMatches("x", "a-much-longer-passcode"), false);
    assert.equal(passcodeMatches("발표자암호", "발표자암호"), true);
  });

  test("없거나 빈 값은 false", () => {
    assert.equal(passcodeMatches(undefined, "p"), false);
    assert.equal(passcodeMatches("", ""), false);
    assert.equal(passcodeMatches("p", ""), false);
    assert.equal(passcodeMatches(["p"], "p"), false);
  });

  test("sha256 다이제스트를 timingSafeEqual 로 비교한다(소스 확인)", () => {
    const src = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function passcodeMatches"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /createHash\("sha256"\)/);
    assert.match(body, /timingSafeEqual\(/);
    assert.doesNotMatch(body, /===\s*expected|expected\s*===/);
  });
});

function post(body, headers = { "x-presenter-key": PASS }) {
  return httpEvent({ headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

function parse(res) {
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

describe("HTTP: POST /api/fetch-month", () => {
  test("202: 잠금, 작업 기록(running 0/25), 작업자 Event 호출, {jobId, month}", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const res = parse(await createHandler(f.deps)(post({ month: "202610" })));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { jobId: "job-0001-aaaa", month: "202610" });
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-store");
    const lock = f.deps.store.json(LOCK_KEY);
    assert.equal(lock.jobId, "job-0001-aaaa");
    assert.equal(isLockFresh(lock, NOW), true);
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), {
      v: 1, type: "job", jobId: "job-0001-aaaa", month: "202610", state: "running", done: 0, total: 25, ts: NOW,
    });
    assert.deepEqual(f.invokes, [{ functionName: "SeoulArStack-FetchMonthWorker", payload: { jobId: "job-0001-aaaa", month: "202610" } }]);
  });

  test("Function URL 직접 경로(/fetch-month)도 같은 검사", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const ev = httpEvent({ path: "/fetch-month", headers: {}, body: JSON.stringify({ month: "202610" }) });
    assert.equal((await createHandler(f.deps)(ev)).statusCode, 401);
  });

  test("base64 본문", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const ev = httpEvent({ headers: { "x-presenter-key": PASS }, body: Buffer.from(JSON.stringify({ month: "202610" })).toString("base64"), isBase64Encoded: true });
    assert.equal((await createHandler(f.deps)(ev)).statusCode, 202);
  });

  test("401: 헤더 없음, 불일치. 월이 틀려도 암호가 먼저", async () => {
    for (const headers of [{}, { "x-presenter-key": "wrong" }, { "x-presenter-key": "" }]) {
      const f = fakeDeps({ nowMs: NOW });
      const res = parse(await createHandler(f.deps)(post({ month: "abc" }, headers)));
      assert.equal(res.status, 401);
      assert.equal(res.body.error, "unauthorized");
      assert.match(res.body.message, /암호/);
      assert.equal(f.invokes.length, 0);
      // 사이트 버킷에는 아무것도 쓰지 않는다(시도 셈은 비공개 인증 상태 버킷에)
      assert.deepEqual(f.deps.store.puts, []);
    }
  });

  test("400: 월 형식, 범위, 깨진 JSON", async () => {
    for (const body of [{ month: "2026-10" }, { month: "202612" }, { month: "200512" }, {}, "{nope", "[]"]) {
      const f = fakeDeps({ nowMs: NOW });
      const res = parse(await createHandler(f.deps)(post(body)));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(res.body.message.length > 0);
      assert.equal(f.invokes.length, 0);
    }
  });

  test("409: 10분 안의 잠금이 있으면", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "busy-1", month: "202609", ts: NOW - 3 * 60_000 } });
    const f = fakeDeps({ nowMs: NOW, store });
    const res = parse(await createHandler(f.deps)(post({ month: "202610" })));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "busy");
    assert.match(res.body.message, /2026년 9월/);
    assert.equal(res.body.jobId, "busy-1");
    assert.equal(f.invokes.length, 0);
    assert.equal(store.json(LOCK_KEY).jobId, "busy-1");
  });

  test("stale 잠금(10분 넘음)은 무시하고 진행", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "dead-1", month: "202609", ts: NOW - 11 * 60_000 } });
    const f = fakeDeps({ nowMs: NOW, store });
    assert.equal((await createHandler(f.deps)(post({ month: "202610" }))).statusCode, 202);
    assert.equal(store.json(LOCK_KEY).jobId, "job-0001-aaaa");
  });

  test("405 / 404", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    assert.equal((await h(httpEvent({ method: "GET", headers: { "x-presenter-key": PASS } }))).statusCode, 405);
    assert.equal((await h(httpEvent({ path: "/api/other", headers: { "x-presenter-key": PASS } }))).statusCode, 404);
  });

  test("500: 암호 파라미터를 못 읽으면(메시지에 파라미터 이름 없음)", async () => {
    const f = fakeDeps({ nowMs: NOW, getParameter: async () => { throw new Error("AccessDeniedException /seoul-ar/presenter-passcode"); } });
    const res = parse(await createHandler(f.deps)(post({ month: "202610" })));
    assert.equal(res.status, 500);
    assert.ok(!res.body.message.includes("/seoul-ar"));
  });

  test("500: 작업자 호출 실패 시 잠금을 풀고 작업 기록을 error 로", async () => {
    const f = fakeDeps({ nowMs: NOW, invoke: async () => { throw new Error("TooManyRequestsException"); } });
    const res = parse(await createHandler(f.deps)(post({ month: "202610" })));
    assert.equal(res.status, 500);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa.json").state, "error");
  });

  test("x-presenter-key 헤더 이름은 대소문자를 가리지 않는다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    assert.equal((await createHandler(f.deps)(post({ month: "202610" }, { "X-Presenter-Key": PASS }))).statusCode, 202);
  });
});

// 서울 API 가짜 데이터: 강남구·서초구만 거래가 있고 나머지는 INFO-200.
function seoulData() {
  return {
    강남구: [
      row({ CTRT_DAY: "20261103", THING_AMT: "300000", ARCH_AREA: 100 }), // 다른 달(11월): 버림
      row({ CTRT_DAY: "20261020", STDG_NM: "대치동", THING_AMT: "200000", ARCH_AREA: 80 }),
      row({ CTRT_DAY: "20261011", STDG_NM: "논현동", THING_AMT: "50000", ARCH_AREA: 50, BLDG_USG: "연립다세대" }),
      row({ CTRT_DAY: "20261005", STDG_NM: "대치동", THING_AMT: "90000", ARCH_AREA: 30, RTRCN_DAY: "20261009" }),
      row({ CTRT_DAY: "20260928", THING_AMT: "1", ARCH_AREA: 1 }), // 다른 달(9월): 버림
    ],
    서초구: [row({ CGG_NM: "서초구", CTRT_DAY: "20261001", STDG_NM: "반포동", THING_AMT: "400000", ARCH_AREA: 100 })],
  };
}

const existingIndex = () => buildIndex(
  [GU_ORDER.map((gu) => aggregateRows([], { month: "202611", gu, generatedAt: "2026-11-17T07:00:00.000Z" }))],
  { months: ["202611"], generatedAt: "2026-11-17T07:00:00.000Z" },
);

function workerSetup(over = {}) {
  const store = over.store ?? fakeStore({ [INDEX_KEY]: existingIndex() });
  const f = fakeDeps({ nowMs: NOW, store, fetch: over.fetch ?? fakeSeoulFetch(seoulData()), ...over });
  return f;
}

async function startedJob(f, month = "202610") {
  // HTTP 경로로 잠금을 잡은 뒤 작업자를 돌린다(실제 흐름과 같게)
  const h = createHandler(f.deps);
  const res = await h(post({ month }));
  assert.equal(res.statusCode, 202);
  await h(f.invokes[0].payload);
  return h;
}

describe("작업자: {jobId, month} Event", () => {
  test("진행 발행: 구마다 running(done 1..25, GU_ORDER), 마지막 done 25/25", async () => {
    const f = workerSetup();
    await startedJob(f);
    assert.equal(f.published.length, 26);
    f.published.slice(0, 25).forEach((m, i) => {
      assert.deepEqual(
        { v: m.v, type: m.type, jobId: m.jobId, month: m.month, state: m.state, done: m.done, total: m.total, gu: m.gu },
        { v: 1, type: "job", jobId: "job-0001-aaaa", month: "202610", state: "running", done: i + 1, total: 25, gu: GU_ORDER[i] },
      );
      assert.equal(typeof m.ts, "number");
    });
    const last = f.published[25];
    assert.equal(last.state, "done");
    assert.equal(last.done, 25);
    assert.equal(last.total, 25);
    assert.equal("message" in last, false);
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), last);
  });

  test("구 파일 25개: aggregateRows 와 같은 결과, no-cache, 금지 필드 없음", async () => {
    const f = workerSetup();
    await startedJob(f);
    const store = f.deps.store;
    const guPuts = store.puts.filter((p) => p.key.startsWith("data/202610/"));
    assert.equal(guPuts.length, 25);
    for (const gu of GU_ORDER) {
      const p = guPuts.find((x) => x.key === `data/202610/${gu}.json`);
      assert.ok(p, gu);
      assert.equal(p.opts.cacheControl, "no-cache");
      assert.equal(p.opts.contentType, "application/json; charset=utf-8");
      assert.ok(p.text.endsWith("}\n"));
      for (const banned of ["MNO", "SNO", "BLDG_NM", "비밀아파트테스트", "CTRT_DAY", "THING_AMT"]) {
        assert.ok(!p.text.includes(banned), `${gu}: ${banned}`);
      }
    }
    const gangnam = store.json("data/202610/강남구.json");
    const expected = aggregateRows(seoulData().강남구.filter((r) => r.CTRT_DAY.startsWith("202610")), {
      month: "202610", gu: "강남구", generatedAt: new Date(NOW).toISOString(),
    });
    assert.deepEqual(gangnam, expected);
    assert.equal(gangnam.total.n, 2);
    assert.equal(gangnam.total.cancelled, 1);
    assert.equal(store.json("data/202610/종로구.json").total.n, 0);
  });

  test("index: 기존 202611 유지, 202610 추가·정렬, generatedAt 갱신, 구 파일 다음에 쓴다", async () => {
    const f = workerSetup();
    await startedJob(f);
    const store = f.deps.store;
    const idx = store.json(INDEX_KEY);
    assert.deepEqual(idx.months, ["202610", "202611"]);
    assert.equal(idx.generatedAt, new Date(NOW).toISOString());
    assert.deepEqual(idx.summary["202611"], existingIndex().summary["202611"]);
    assert.equal(idx.summary["202610"]["강남구"].n, 2);
    assert.equal(idx.summary["202610"]["서초구"].medPerM2, 4000);
    const keys = store.puts.map((p) => p.key);
    const lastGu = Math.max(...keys.map((k, i) => (k.startsWith("data/202610/") ? i : -1)));
    assert.ok(keys.indexOf(INDEX_KEY) > lastGu, "index 는 구 파일 뒤");
    const indexPut = store.puts.find((p) => p.key === INDEX_KEY);
    assert.equal(indexPut.opts.cacheControl, "no-cache");
    for (const banned of ["MNO", "SNO", "BLDG_NM"]) assert.ok(!indexPut.text.includes(banned));
  });

  test("CloudFront 무효화 /data/* 를 한 번", async () => {
    const f = workerSetup();
    await startedJob(f);
    assert.deepEqual(f.invalidations, [{ distributionId: "EDISTTEST", paths: ["/data/*"], callerReference: "job-0001-aaaa" }]);
  });

  test("끝나면 잠금을 해제한다", async () => {
    const f = workerSetup();
    await startedJob(f);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("서울 API 는 SSM 키로 부른다", async () => {
    const f = workerSetup();
    await startedJob(f);
    assert.ok(f.deps.fetch.calls.length >= 25);
    assert.ok(f.deps.fetch.calls.every((c) => c.key === FAKE_KEY && c.year === "2026"));
  });

  test("동시 4개로 돌려도 done 은 1..25 순서대로, 구는 25개 모두", async () => {
    const f = workerSetup({ concurrency: 4 });
    await startedJob(f);
    const running = f.published.filter((m) => m.state === "running");
    assert.deepEqual(running.map((m) => m.done), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.deepEqual([...new Set(running.map((m) => m.gu))].sort(), [...GU_ORDER].sort());
    assert.equal(f.published.at(-1).state, "done");
  });

  test("한 구가 실패하면 error(사용자 문장, 구 이름), index 안 씀, 잠금 해제", async () => {
    const fetch = fakeSeoulFetch(seoulData(), {
      onCall: (p) => (p.gu === "용산구" ? jsonResponse({ RESULT: { CODE: "ERROR-500", MESSAGE: `서버 오류 ${FAKE_KEY}` } }) : null),
    });
    const f = workerSetup({ fetch });
    await startedJob(f);
    const last = f.published.at(-1);
    assert.equal(last.state, "error");
    assert.equal(last.done, 2); // 종로구, 중구 다음 용산구에서 실패
    assert.equal(last.total, 25);
    assert.match(last.message, /용산구/);
    assert.match(last.message, /ERROR-500/);
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), last);
    assert.equal(f.deps.store.puts.some((p) => p.key === INDEX_KEY), false);
    assert.equal(f.deps.store.puts.some((p) => p.key.startsWith("data/202610/")), false);
    assert.equal(f.invalidations.length, 0);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("어떤 실패에서도 발행·기록·로그·응답에 키나 URL 이 없다", async () => {
    const failures = [
      (url) => { throw new TypeError(`fetch failed: ${url}`); },
      () => ({ ok: false, status: 502, json: async () => ({}) }),
      () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`bad ${FAKE_KEY}`); } }),
      () => jsonResponse({ RESULT: { CODE: "INFO-100", MESSAGE: `인증키 ${FAKE_KEY} 오류` } }),
    ];
    for (const fail of failures) {
      const f = workerSetup({ fetch: async (url) => fail(url) });
      await startedJob(f);
      const last = f.published.at(-1);
      assert.equal(last.state, "error");
      const everything = JSON.stringify([f.published, f.logs, [...f.deps.store.objects.values()].map((o) => o.text)]);
      assert.ok(!everything.includes(FAKE_KEY), "키 없음");
      assert.ok(!everything.includes("openapi.seoul.go.kr"), "서울 API 호스트 없음");
      assert.ok(!/https?:\/\/openapi/.test(everything), "URL 없음");
      assert.ok(last.message.length > 0 && !/[A-Za-z]+Error/.test(last.message), "사용자용 문장");
    }
  });

  test("SSM 키를 못 읽으면 error, 잠금 해제", async () => {
    const f = workerSetup({ getParameter: async (name) => { if (name === "/seoul-ar/seoul-api-key") throw new Error("ParameterNotFound"); return PASS; } });
    await startedJob(f);
    const last = f.published.at(-1);
    assert.equal(last.state, "error");
    assert.match(last.message, /키/);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("구 파일 저장 실패는 error, 잠금 해제", async () => {
    const f = workerSetup();
    f.deps.store.failPut = (key) => (key.startsWith("data/202610/") ? new Error("SlowDown") : null);
    await startedJob(f);
    assert.equal(f.published.at(-1).state, "error");
    assert.match(f.published.at(-1).message, /저장/);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("깨진 기존 index 는 덮어쓰지 않고 error", async () => {
    const store = fakeStore({ [INDEX_KEY]: "{broken" });
    const f = workerSetup({ store });
    await startedJob(f);
    assert.equal(f.published.at(-1).state, "error");
    assert.equal(store.objects.get(INDEX_KEY).text, "{broken");
  });

  test("index 가 없으면 그 달만으로 만든다", async () => {
    const f = workerSetup({ store: fakeStore() });
    await startedJob(f);
    assert.deepEqual(f.deps.store.json(INDEX_KEY).months, ["202610"]);
    assert.equal(f.published.at(-1).state, "done");
  });

  test("무효화 실패는 경고만, 작업은 done", async () => {
    const f = workerSetup({ invalidate: async () => { throw new Error("TooManyInvalidationsInProgress"); } });
    await startedJob(f);
    assert.equal(f.published.at(-1).state, "done");
    assert.ok(f.logs.some((l) => l.level === "warn"));
  });

  test("발행이 실패해도 작업은 끝나고 작업 기록은 남는다", async () => {
    const f = workerSetup({ publish: async () => { throw new Error("AppSync 발행 실패 (HTTP 500)"); } });
    await startedJob(f);
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa.json").state, "done");
    assert.ok(f.deps.store.json(INDEX_KEY).months.includes("202610"));
  });

  test("잘못된 작업 입력: jobId 형식 오류는 아무것도 쓰지 않는다", async () => {
    const f = workerSetup();
    await createHandler(f.deps)({ jobId: "../../index", month: "202610" });
    assert.equal(f.deps.store.puts.length, 0);
    assert.equal(f.published.length, 0);
  });

  test("잘못된 작업 입력: 월 오류는 error 발행 + 잠금 해제", async () => {
    const f = workerSetup();
    const h = createHandler(f.deps);
    await h(post({ month: "202610" }));
    await h({ jobId: "job-0001-aaaa", month: "999999" });
    assert.equal(f.published.at(-1).state, "error");
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });
});

describe("작업자 마감: Lambda 제한 시간 전에 멈추고 error 를 알린다", () => {
  test("남은 시간 - 90초를 넘기면 error(제한 시간), index 안 씀, 잠금 해제", async () => {
    const f = workerSetup();
    const h = createHandler(f.deps);
    assert.equal((await h(post({ month: "202610" }))).statusCode, 202);
    const slow = f.deps.fetch;
    f.deps.fetch = async (url, init) => { f.setNow(f.deps.now() + 3000); return slow(url, init); };
    const context = { getRemainingTimeInMillis: () => 100_000 }; // 마감 = 지금 + 10초
    await h(f.invokes[0].payload, context);
    const last = f.published.at(-1);
    assert.equal(last.state, "error");
    assert.match(last.message, /제한 시간/);
    assert.ok(slow.calls.length < 25, `서울 API 호출 ${slow.calls.length}번에서 멈춤`);
    assert.equal(f.deps.store.puts.some((p) => p.key === INDEX_KEY), false);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("context 가 없으면 마감 없이 끝까지", async () => {
    const f = workerSetup();
    await startedJob(f);
    assert.equal(f.published.at(-1).state, "done");
  });
});

describe("{action: \"rebuild-index\"}: 배포 뒤 S3 내용으로 index 를 다시 만든다", () => {
  function rebuildStore(extra = {}) {
    const init = { [INDEX_KEY]: existingIndex() }; // 저장소 스냅샷(202611)
    for (const gu of GU_ORDER) init[`data/202611/${gu}.json`] = aggregateRows([], { month: "202611", gu, generatedAt: "x" });
    init["data/202610/강남구.json"] = aggregateRows([row()], { month: "202610", gu: "강남구", generatedAt: "x" }); // Lambda 가 가져온 달
    return fakeStore({ ...init, ...extra });
  }

  test("index 를 no-cache 로 쓰고 /data/index.json 무효화, 잠금은 잡았다가 해제, 발행 없음", async () => {
    const store = rebuildStore();
    const f = fakeDeps({ nowMs: NOW, store, randomId: () => "uuid-1" });
    const out = await createHandler(f.deps)({ action: "rebuild-index" });
    assert.deepEqual(out, { ok: true, months: ["202610", "202611"] });
    const idx = store.json(INDEX_KEY);
    assert.deepEqual(idx.months, ["202610", "202611"]);
    assert.equal(idx.summary["202610"]["강남구"].n, 1);
    assert.equal(idx.generatedAt, new Date(NOW).toISOString());
    const put = store.puts.find((p) => p.key === INDEX_KEY);
    assert.equal(put.opts.cacheControl, "no-cache");
    assert.ok(put.text.endsWith("}\n"));
    assert.deepEqual(f.invalidations, [{ distributionId: "EDISTTEST", paths: ["/data/index.json"], callerReference: "rebuild-uuid-1" }]);
    const lockPuts = store.puts.filter((p) => p.key === LOCK_KEY).map((p) => JSON.parse(p.text));
    assert.equal(lockPuts[0].jobId, "rebuild-uuid-1");
    assert.equal(store.json(LOCK_KEY).released, true);
    assert.equal(f.published.length, 0);
  });

  test("수집 작업이 잠금을 잡고 있어도 다시 만들고 경고만, 남의 잠금은 건드리지 않는다", async () => {
    const store = rebuildStore({ [LOCK_KEY]: { v: 1, jobId: "busy-1", month: "202609", ts: NOW - 60_000 } });
    const f = fakeDeps({ nowMs: NOW, store });
    const out = await createHandler(f.deps)({ action: "rebuild-index" });
    assert.equal(out.ok, true);
    assert.equal(store.json(LOCK_KEY).jobId, "busy-1");
    assert.equal(store.json(LOCK_KEY).released, undefined);
    assert.ok(f.logs.some((l) => l.level === "warn"));
  });

  test("구 파일이 없으면 index 를 덮어쓰지 않는다", async () => {
    const store = fakeStore({ [INDEX_KEY]: existingIndex() });
    const before = store.objects.get(INDEX_KEY).text;
    const f = fakeDeps({ nowMs: NOW, store });
    const out = await createHandler(f.deps)({ action: "rebuild-index" });
    assert.equal(out.ok, false);
    assert.equal(store.objects.get(INDEX_KEY).text, before);
  });

  test("S3 목록 오류는 던지지 않고 ok:false + error 로그 (배포를 깨지 않게), 잠금 해제", async () => {
    const store = rebuildStore();
    store.failList = () => new Error("AccessDenied");
    const f = fakeDeps({ nowMs: NOW, store });
    const out = await createHandler(f.deps)({ action: "rebuild-index" });
    assert.equal(out.ok, false);
    assert.ok(f.logs.some((l) => l.level === "error"));
    assert.equal(store.json(LOCK_KEY).released, true);
  });

  test("무효화 실패는 경고만", async () => {
    const f = fakeDeps({ nowMs: NOW, store: rebuildStore(), invalidate: async () => { throw new Error("Throttling"); } });
    assert.equal((await createHandler(f.deps)({ action: "rebuild-index" })).ok, true);
  });
});

// ---- Task 11: AI 한 줄 해설 ----
const NARR_ENV = { BEDROCK_MODEL_ID: "anthropic.claude-haiku-5-5" };

function storeWith202611() {
  const init = { [INDEX_KEY]: existingIndex() };
  for (const gu of GU_ORDER) {
    init[`data/202611/${gu}.json`] = aggregateRows(gu === "강남구" ? [row({ CTRT_DAY: "20261105", THING_AMT: "300000", ARCH_AREA: 100 })] : [], { month: "202611", gu, generatedAt: "x" });
  }
  return fakeStore(init);
}

function narratePost(month, headers = { "x-presenter-key": PASS }) {
  return httpEvent({ path: "/api/narrate-month", headers, body: JSON.stringify({ month }) });
}

describe("HTTP: POST /api/narrate-month", () => {
  test("202: 잠금, 작업 기록(kind narration, running 0/26), 작업자 {action: narrate}", async () => {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV });
    const res = parse(await createHandler(f.deps)(narratePost("202611")));
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { jobId: "job-0001-aaaa", month: "202611" });
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), {
      v: 1, type: "job", kind: "narration", jobId: "job-0001-aaaa", month: "202611", state: "running", done: 0, total: 26, ts: NOW,
    });
    assert.deepEqual(f.invokes, [{ functionName: "SeoulArStack-FetchMonthWorker", payload: { action: "narrate", jobId: "job-0001-aaaa", month: "202611" } }]);
    assert.equal(f.deps.store.json(LOCK_KEY).jobId, "job-0001-aaaa");
  });

  test("401 암호, 400 월 형식, 400 아직 가져오지 않은 달, 409 잠금", async () => {
    const h = (f) => createHandler(f.deps);
    let f = fakeDeps({ nowMs: NOW, store: storeWith202611() });
    assert.equal((await h(f)(narratePost("202611", {}))).statusCode, 401);
    f = fakeDeps({ nowMs: NOW, store: storeWith202611() });
    assert.equal((await h(f)(narratePost("2026-11"))).statusCode, 400);
    f = fakeDeps({ nowMs: NOW, store: storeWith202611() });
    const missing = parse(await h(f)(narratePost("202610")));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "no_data");
    assert.match(missing.body.message, /가져오지 않은 달/);
    assert.equal(f.invokes.length, 0);
    const store = storeWith202611();
    store.objects.set(LOCK_KEY, { text: JSON.stringify({ v: 1, jobId: "busy-1", month: "202609", ts: NOW }), etag: '"l"', opts: {} });
    f = fakeDeps({ nowMs: NOW, store });
    assert.equal((await h(f)(narratePost("202611"))).statusCode, 409);
  });
});

describe("작업자 {action: narrate}", () => {
  async function narrateJob(over = {}) {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV, ...over });
    const h = createHandler(f.deps);
    assert.equal((await h(narratePost("202611"))).statusCode, 202);
    await h(f.invokes[0].payload);
    return f;
  }

  test("index 와 구 파일로 해설: narration.json(no-cache), 무효화, kind narration 진행, 잠금 해제", async () => {
    const f = await narrateJob();
    const put = f.deps.store.puts.find((p) => p.key === "data/202611/narration.json");
    assert.ok(put, "narration.json");
    assert.equal(put.opts.cacheControl, "no-cache");
    const n = JSON.parse(put.text);
    assert.equal(n.v, 1);
    assert.equal(n.month, "202611");
    assert.equal(n.model, "anthropic.claude-haiku-5-5");
    assert.equal(n.generatedAt, new Date(NOW).toISOString());
    assert.equal(Object.keys(n.items).length, 26);
    assert.equal(Object.keys(n.source).length, 26);
    assert.ok(Object.values(n.source).every((x) => x === "model"));
    assert.ok(f.deps.converse.calls[0].prompt.includes("강남구"));
    assert.deepEqual(f.invalidations, [{ distributionId: "EDISTTEST", paths: ["/data/202611/narration.json"], callerReference: "job-0001-aaaa" }]);
    assert.ok(f.published.length >= 2);
    for (const m of f.published) {
      assert.equal(m.kind, "narration");
      assert.equal(m.type, "job");
      assert.equal(m.v, 1);
      assert.equal(m.total, 26);
      assert.equal(typeof m.ts, "number");
    }
    assert.equal(f.published.at(-1).state, "done");
    assert.equal(f.published.at(-1).done, 26);
    assert.equal("message" in f.published.at(-1), false);
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), f.published.at(-1));
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
    // 수집은 하지 않는다
    assert.equal(f.deps.fetch.calls.length, 0);
    assert.equal(f.deps.store.puts.some((p) => p.key === INDEX_KEY), false);
  });

  test("걸린 항목은 틀 문장으로 채우고(생략 없음) done 메시지와 작업 기록에 이유 집계", async () => {
    const converse = fakeConverse((c) => (c.single === null ? bulkReply({ 중구: undefined }) : "JSON 도 문장도 아닌\n두 줄"));
    const f = await narrateJob({ converse });
    const last = f.published.at(-1);
    assert.equal(last.state, "done");
    assert.equal(last.message, "모델 문장이 검사를 통과하지 못해 1곳은 데이터로 만든 문장으로 채웠습니다(여러 줄 1): 중구.");
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), last);
    const n = JSON.parse(f.deps.store.puts.find((p) => p.key === "data/202611/narration.json").text);
    assert.equal(Object.keys(n.items).length, 26);
    assert.equal(n.source["중구"], "template");
    assert.match(n.items["중구"], /^중구 11월/);
  });

  test("모델 권한 없음 → error(kind narration, Bedrock 안내), 파일 안 씀, 잠금 해제", async () => {
    const converse = fakeConverse(() => { throw Object.assign(new Error("You don't have access to the model with the specified model ID."), { name: "AccessDeniedException" }); });
    const f = await narrateJob({ converse });
    const last = f.published.at(-1);
    assert.equal(last.state, "error");
    assert.equal(last.kind, "narration");
    assert.match(last.message, /Bedrock/);
    assert.ok(!/AccessDenied|model ID/.test(last.message));
    assert.equal(f.deps.store.puts.some((p) => p.key.endsWith("narration.json")), false);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("BEDROCK_MODEL_ID 가 없으면 error (설정 안내)", async () => {
    const f = await narrateJob({ env: {} });
    assert.equal(f.published.at(-1).state, "error");
    assert.match(f.published.at(-1).message, /설정/);
  });

  test("index 에 없는 달은 error", async () => {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV });
    await createHandler(f.deps)({ action: "narrate", jobId: "job-0002-bbbb", month: "202610" });
    assert.equal(f.published.at(-1).state, "error");
    assert.equal(f.published.at(-1).kind, "narration");
  });
});

describe("수집 끝 자동 해설", () => {
  test("BEDROCK_MODEL_ID 가 있으면 수집 done 뒤 {jobId}-narration 로 해설을 만든다 (수집 기록은 done 그대로)", async () => {
    const f = workerSetup({ env: NARR_ENV });
    await startedJob(f);
    const fetchMsgs = f.published.filter((m) => m.jobId === "job-0001-aaaa");
    const narrMsgs = f.published.filter((m) => m.jobId === "job-0001-aaaa-narration");
    assert.equal(fetchMsgs.length, 26);
    assert.equal(fetchMsgs.at(-1).state, "done");
    assert.ok(fetchMsgs.every((m) => m.kind === undefined));
    assert.ok(f.published.indexOf(fetchMsgs.at(-1)) < f.published.indexOf(narrMsgs[0]), "수집 done 이 먼저");
    assert.ok(narrMsgs.every((m) => m.kind === "narration" && m.month === "202610"));
    assert.equal(narrMsgs.at(-1).state, "done");
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa.json").state, "done");
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa-narration.json").state, "done");
    const n = f.deps.store.json("data/202610/narration.json");
    assert.equal(Object.keys(n.items).length, 26);
    // 해설 입력은 이번에 집계한 값
    assert.ok(f.deps.converse.calls[0].prompt.includes("대치동"));
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("자동 해설 실패는 수집 결과를 바꾸지 않는다", async () => {
    const converse = fakeConverse(() => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); });
    const f = workerSetup({ env: NARR_ENV, converse });
    await startedJob(f);
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa.json").state, "done");
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa-narration.json").state, "error");
    assert.ok(f.deps.store.json(INDEX_KEY).months.includes("202610"));
  });

  test("BEDROCK_MODEL_ID 가 없으면 자동 해설을 건너뛴다", async () => {
    const f = workerSetup();
    await startedJob(f);
    assert.equal(f.deps.converse.calls.length, 0);
    assert.ok(f.published.every((m) => m.kind === undefined));
  });
});

// ---- 9a fix round 1 ----
describe("fix: truncated = 페이지 상한에 닿음 (거짓 경고 없음, 실제 잘림은 표시)", () => {
  const many = (day, n) => Array.from({ length: n }, () => row({ CTRT_DAY: day, THING_AMT: "100000", ARCH_AREA: 50 }));

  test("그 달 1,500건을 끝까지 받으면 truncated false (파일과 index 모두), done 에 message 없음", async () => {
    const fetch = fakeSeoulFetch({ ...seoulData(), 강남구: many("20261015", 1500) });
    const f = workerSetup({ fetch });
    await startedJob(f);
    const g = f.deps.store.json("data/202610/강남구.json");
    assert.equal(g.total.n, 1500);
    assert.equal(g.total.truncated, false);
    assert.equal(f.deps.store.json(INDEX_KEY).summary["202610"]["강남구"].truncated, false);
    assert.equal("message" in f.published.at(-1), false);
  });

  test("30페이지 상한에 닿으면 truncated true (파일과 index), done message 에 그 구들 (GU_ORDER 순)", async () => {
    const fetch = fakeSeoulFetch({ ...seoulData(), 송파구: many("20261015", 31000), 강남구: many("20261015", 31000) });
    const f = workerSetup({ fetch, concurrency: 4 });
    await startedJob(f);
    for (const gu of ["강남구", "송파구"]) {
      assert.equal(f.deps.store.json(`data/202610/${gu}.json`).total.truncated, true, gu);
      assert.equal(f.deps.store.json(INDEX_KEY).summary["202610"][gu].truncated, true, gu);
    }
    assert.equal(f.deps.store.json("data/202610/서초구.json").total.truncated, false);
    const last = f.published.at(-1);
    assert.equal(last.state, "done");
    assert.match(last.message, /일부 구는 거래가 많아 끝까지 받지 못했습니다: 강남구, 송파구/);
    assert.deepEqual(f.deps.store.json("data/jobs/job-0001-aaaa.json"), last);
  });
});

describe("fix: 11·12월 안내", () => {
  for (const month of ["202611", "202512"]) {
    test(`${month}: done message 에 다음 해 신고 안내`, async () => {
      const store = fakeStore({ [INDEX_KEY]: existingIndex() });
      const f = workerSetup({ store, fetch: fakeSeoulFetch({}) });
      await startedJob(f, month);
      const last = f.published.at(-1);
      assert.equal(last.state, "done");
      assert.match(last.message, /11·12월은 다음 해에 신고된 거래가 빠질 수 있습니다/);
    });
  }

  test("10월은 안내 없음, 상한 + 11월이면 두 문장 모두", async () => {
    const store = fakeStore({ [INDEX_KEY]: existingIndex() });
    const fetch = fakeSeoulFetch({ 강남구: Array.from({ length: 31000 }, () => row({ CTRT_DAY: "20261115" })) });
    const f = workerSetup({ store, fetch });
    await startedJob(f, "202611");
    const msg = f.published.at(-1).message;
    assert.match(msg, /강남구/);
    assert.match(msg, /11·12월/);
  });
});

describe("fix: 마지막 done/error 를 보내기 전에 잠금을 푼다", () => {
  function lockWatcher(f) {
    const seen = [];
    f.deps.publish = async (m) => {
      f.published.push(m);
      if (m.state !== "running") seen.push({ state: m.state, kind: m.kind, released: f.deps.store.json(LOCK_KEY)?.released === true });
    };
    return seen;
  }

  test("수집 done", async () => {
    const f = workerSetup();
    const seen = lockWatcher(f);
    await startedJob(f);
    assert.deepEqual(seen, [{ state: "done", kind: undefined, released: true }]);
  });

  test("수집 error", async () => {
    const f = workerSetup({ fetch: async () => jsonResponse({ RESULT: { CODE: "ERROR-500" } }) });
    const seen = lockWatcher(f);
    await startedJob(f);
    assert.deepEqual(seen, [{ state: "error", kind: undefined, released: true }]);
  });

  test("해설 작업 done, 자동 해설은 잠금 없이(수집 잠금은 이미 풀림)", async () => {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV });
    const seen = lockWatcher(f);
    const h = createHandler(f.deps);
    await h(narratePost("202611"));
    await h(f.invokes[0].payload);
    assert.deepEqual(seen, [{ state: "done", kind: "narration", released: true }]);
    const g = workerSetup({ env: NARR_ENV });
    const seen2 = lockWatcher(g);
    await startedJob(g);
    assert.deepEqual(seen2, [{ state: "done", kind: undefined, released: true }, { state: "done", kind: "narration", released: true }]);
  });
});

describe("fix: 한 구가 실패하면 다른 구도 다음 페이지를 부르지 않는다", () => {
  test("동시 2개: 중구 실패 뒤 종로구는 더 페이지를 넘기지 않는다", async () => {
    const big = Array.from({ length: 5000 }, () => row({ CGG_NM: "종로구", CTRT_DAY: "20261015" }));
    const base = fakeSeoulFetch({ 종로구: big });
    const fetch = async (url, init) => {
      const gu = decodeURIComponent(new URL(url).pathname.split("/")[8]);
      if (gu === "중구") return jsonResponse({ RESULT: { CODE: "ERROR-500" } });
      await new Promise((r) => setTimeout(r, 5));
      return base(url, init);
    };
    const f = workerSetup({ fetch, concurrency: 2 });
    await startedJob(f);
    assert.equal(f.published.at(-1).state, "error");
    assert.match(f.published.at(-1).message, /중구/);
    assert.ok(base.calls.length <= 2, `종로구 페이지 ${base.calls.length}번`);
  });
});

describe("fix: index 재구성 실패는 'index 재구성 실패' error 로그", () => {
  test("구 파일 없음, S3 오류 모두", async () => {
    const empty = fakeDeps({ nowMs: NOW, store: fakeStore({ [INDEX_KEY]: existingIndex() }) });
    await createHandler(empty.deps)({ action: "rebuild-index" });
    assert.ok(empty.logs.some((l) => l.level === "error" && l.msg.startsWith("index 재구성 실패")), JSON.stringify(empty.logs));
    const store = fakeStore({ [INDEX_KEY]: existingIndex() });
    store.failList = () => new Error("AccessDenied");
    const broken = fakeDeps({ nowMs: NOW, store });
    await createHandler(broken.deps)({ action: "rebuild-index" });
    assert.ok(broken.logs.some((l) => l.level === "error" && l.msg.startsWith("index 재구성 실패")));
  });
});

describe("fix: 발표자 암호는 60초 메모리 캐시", () => {
  test("60초 안에는 SSM 을 다시 읽지 않고, 지나면 다시 읽는다", async () => {
    const reads = [];
    const f = fakeDeps({ nowMs: NOW, getParameter: async (name) => { reads.push(name); return PASS; } });
    const h = createHandler(f.deps);
    await h(post({ month: "abc" }));
    f.setNow(NOW + 30_000);
    await h(post({ month: "abc" }));
    assert.equal(reads.filter((n) => n === "/seoul-ar/presenter-passcode").length, 1);
    f.setNow(NOW + 61_000);
    await h(post({ month: "abc" }));
    assert.equal(reads.filter((n) => n === "/seoul-ar/presenter-passcode").length, 2);
  });

  test("읽기 실패는 캐시하지 않는다", async () => {
    let n = 0;
    const f = fakeDeps({ nowMs: NOW, getParameter: async () => { n++; if (n === 1) throw new Error("Throttling"); return PASS; } });
    const h = createHandler(f.deps);
    assert.equal((await h(post({ month: "202610" }))).statusCode, 500);
    assert.equal((await h(post({ month: "202610" }))).statusCode, 202);
  });
});

describe("fix: IP 별 암호 실패 잠금 (10분에 10번 → 10분 429)", () => {
  const VIEWER = { "cloudfront-viewer-address": "198.51.100.10:46532" };
  const wrong = (extra = {}) => post({ month: "202610" }, { ...VIEWER, "x-presenter-key": "wrong", ...extra });
  const right = (extra = {}) => post({ month: "202610" }, { ...VIEWER, "x-presenter-key": PASS, ...extra });

  test("10번 틀리면 다음 요청은 맞는 암호여도 429, 10분 뒤 풀린다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    for (let i = 0; i < 10; i++) assert.equal((await h(wrong())).statusCode, 401, `시도 ${i + 1}`);
    const locked = parse(await h(right()));
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, "locked");
    assert.equal(locked.body.message, "암호를 너무 많이 틀렸습니다. 약 10분 뒤 다시 시도해 주세요.");
    assert.equal(locked.body.retryAfterSeconds, 600);
    f.setNow(NOW + 5.5 * 60_000);
    const later = parse(await h(right()));
    assert.equal(later.status, 429);
    assert.equal(later.body.retryAfterSeconds, 270);
    assert.equal(later.headers["retry-after"], "270");
    assert.equal(later.body.message, "암호를 너무 많이 틀렸습니다. 약 5분 뒤 다시 시도해 주세요.");
    assert.equal(locked.headers["retry-after"], "600");
    assert.equal(f.invokes.length, 0);
    f.setNow(NOW + 10 * 60_000 + 1);
    assert.equal((await h(right())).statusCode, 202);
  });

  test("기록은 비공개 인증 버킷의 attempts/<HMAC-SHA256(ip, 서버 쪽 임의 비밀)>.json. 암호에서 아무것도 만들지 않는다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    await createHandler(f.deps)(wrong());
    assert.deepEqual(f.deps.store.puts, [], "사이트 버킷(공개 경로)에는 쓰지 않는다");
    const put = f.deps.authStore.puts[0];
    const expected = createHmac("sha256", AUTH_SECRET).update("198.51.100.10", "utf8").digest("hex");
    assert.equal(put.key, `attempts/${expected}.json`);
    const fromPasscode = createHmac("sha256", createHash("sha256").update(PASS, "utf8").digest()).update("198.51.100.10", "utf8").digest("hex");
    assert.notEqual(expected, fromPasscode, "암호에서 유도한 키가 아니다");
    assert.notEqual(expected, createHash("sha256").update("198.51.100.10").digest("hex"));
    assert.deepEqual(f.secretReads, ["arn:aws:secretsmanager:us-east-1:111111111111:secret:seoul-ar-auth-hmac-AbCdEf"]);
    assert.equal(put.opts.cacheControl, "no-store");
    assert.ok(!put.text.includes("198.51.100.10") && !put.key.includes("198.51.100.10"));
    assert.equal(put.opts.ifNoneMatch, "*", "첫 기록은 IfNoneMatch");
  });

  test("동시에 들어온 시도도 잃지 않는다: 기록된 횟수 + 기록 못 해 거절한 횟수 = 시도 수 (ETag 조건부 쓰기)", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    const res = await Promise.all(Array.from({ length: 12 }, () => h(wrong())));
    assert.ok(res.every((r) => r.statusCode === 401 || r.statusCode === 429 || r.statusCode === 503));
    const rec = JSON.parse([...f.deps.authStore.objects.entries()].find(([k]) => k.startsWith("attempts/"))[1].text);
    const unrecorded = f.logs.filter((l) => l.msg.startsWith("암호 시도를 기록하지 못해 거절")).length;
    assert.equal(rec.count + unrecorded, 12, JSON.stringify({ count: rec.count, unrecorded }));
    assert.ok(f.deps.authStore.puts.slice(1).every((p) => p.opts.ifMatch), "갱신은 IfMatch");
  });

  test("IPv6 는 /64 로 센다: 같은 /64 의 다른 주소가 한 셈, 다른 /64 는 따로", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    const v6 = (addr, key) => post({ month: "202610" }, { "cloudfront-viewer-address": `${addr}:443`, "x-presenter-key": key });
    for (let i = 0; i < 10; i++) await h(v6(i % 2 ? "2001:db8:1:2::10" : "2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd", "wrong"));
    assert.equal((await h(v6("2001:db8:1:2:ffff::1", PASS))).statusCode, 429);
    assert.equal((await h(v6("2001:db8:1:3::1", PASS))).statusCode, 202);
  });

  test("성공하면 초기화: 9번 틀리고 1번 맞히고 9번 더 틀려도 잠기지 않는다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    for (let i = 0; i < 9; i++) await h(wrong());
    assert.equal((await h(right())).statusCode, 202);
    f.deps.store.objects.delete(LOCK_KEY); // 다음 202 를 위해 작업 잠금만 비운다
    for (let i = 0; i < 9; i++) assert.equal((await h(wrong())).statusCode, 401);
    assert.notEqual((await h(right())).statusCode, 429);
  });

  test("10분 창이 지나면 셈을 새로 한다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    for (let i = 0; i < 9; i++) await h(wrong());
    f.setNow(NOW + 11 * 60_000);
    for (let i = 0; i < 9; i++) await h(wrong());
    assert.notEqual((await h(right())).statusCode, 429);
  });

  test("다른 IP 는 영향 없음, 헤더가 없으면 sourceIp 로 센다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    for (let i = 0; i < 10; i++) await h(wrong());
    assert.equal((await h(right({ "cloudfront-viewer-address": "203.0.113.99:1234" }))).statusCode, 202);
    const g = fakeDeps({ nowMs: NOW });
    const hg = createHandler(g.deps);
    const bare = (key) => httpEvent({ headers: { "x-presenter-key": key }, body: JSON.stringify({ month: "202610" }), sourceIp: "192.0.2.5" });
    for (let i = 0; i < 10; i++) await hg(bare("wrong"));
    assert.equal((await hg(bare(PASS))).statusCode, 429);
  });

  test("400 은 실패로 세지 않는다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    for (let i = 0; i < 12; i++) assert.equal((await h(post({ month: "bad" }, { ...VIEWER, "x-presenter-key": PASS }))).statusCode, 400);
    assert.equal((await h(right())).statusCode, 202);
  });

  test("기록이 없으면 S3 가 403 을 줘도(ListBucket 없음) 기록 없음으로 본다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const realGet = f.deps.authStore.get.bind(f.deps.authStore);
    f.deps.authStore.get = async (key) => {
      if (!f.deps.authStore.objects.has(key)) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      return realGet(key);
    };
    const h = createHandler(f.deps);
    for (let i = 0; i < 10; i++) await h(wrong());
    assert.equal((await h(right())).statusCode, 429);
  });

  test("시도를 기록하지 못하면 암호를 비교하지 않고 503 auth_unavailable (fail-closed, 틀린 암호로 보이지 않게)", async () => {
    const f = fakeDeps({ nowMs: NOW });
    f.deps.authStore.failPut = () => new Error("SlowDown");
    const h = createHandler(f.deps);
    const res = parse(await h(right()));
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "auth_unavailable");
    assert.equal(res.body.message, "잠금 상태를 확인할 수 없어 요청을 받지 않았습니다. 잠시 후 다시 시도해 주세요.");
    assert.equal(f.invokes.length, 0);
    assert.ok(f.logs.some((l) => l.level === "warn" && l.msg.startsWith("암호 시도를 기록하지 못해 거절")));
  });
});


// ---- 11a fix round 1 + hardening ----
describe("11a fix: 해설 작업에서 읽지 못한 구 파일은 그 키를 뺀다", () => {
  test("깨진 중구 파일 → narration 에 중구(와 서울 전체) 없음, 프롬프트에도 없음, done 메시지에 이름", async () => {
    const store = storeWith202611();
    store.objects.set("data/202611/중구.json", { text: "{broken", etag: '"b"', opts: {} });
    const f = fakeDeps({ nowMs: NOW, store, env: NARR_ENV });
    const h = createHandler(f.deps);
    await h(narratePost("202611"));
    await h(f.invokes[0].payload);
    const n = f.deps.store.json("data/202611/narration.json");
    assert.equal("중구" in n.items, false);
    assert.equal("서울 전체" in n.items, false);
    assert.equal(Object.keys(n.items).length, 24);
    assert.ok(!f.deps.converse.calls[0].prompt.includes('"중구"'));
    assert.match(f.published.at(-1).message, /중구/);
  });
});

describe("11a fix: 자동 해설은 {jobId}-narration 잠금을 잡는다", () => {
  test("해설 중에는 잠금이 kind narration 으로 잡혀 있고, 그동안 narrate-month 는 409 '해설을 만드는 중'", async () => {
    let during = null;
    let lockDuring = null;
    const f = workerSetup({ env: NARR_ENV });
    f.deps.converse = fakeConverse(async () => {
      lockDuring = f.deps.store.json(LOCK_KEY);
      during = parse(await createHandler(f.deps)(narratePost("202610")));
      return bulkReply();
    });
    await startedJob(f);
    assert.equal(lockDuring.jobId, "job-0001-aaaa-narration");
    assert.equal(lockDuring.kind, "narration");
    assert.equal(during.status, 409);
    assert.match(during.body.message, /2026년 10월 해설을 만드는 중입니다/);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
    assert.equal(f.deps.store.json("data/jobs/job-0001-aaaa-narration.json").state, "done");
  });

  test("다른 작업이 잠금을 잡고 있으면 자동 해설을 건너뛴다(info 로그, Bedrock 호출 없음)", async () => {
    const f = workerSetup({ env: NARR_ENV });
    const realPublish = f.deps.publish;
    f.deps.publish = async (m) => {
      await realPublish(m);
      if (m.state === "done" && m.kind === undefined) {
        f.deps.store.objects.set(LOCK_KEY, { text: JSON.stringify({ v: 1, jobId: "other-job-1", month: "202609", ts: NOW }), etag: '"o"', opts: {} });
      }
    };
    await startedJob(f);
    assert.equal(f.deps.converse.calls.length, 0);
    assert.ok(f.logs.some((l) => l.level === "info" && /자동 해설을 건너/.test(l.msg)));
    assert.equal(f.deps.store.json(LOCK_KEY).jobId, "other-job-1");
  });
});

describe("11a fix: 409 문구", () => {
  test("잠금 주인이 해설 작업이면 '{월} 해설을 만드는 중입니다'", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "n-1-narration", month: "202611", kind: "narration", ts: NOW - 1000 } });
    const f = fakeDeps({ nowMs: NOW, store });
    const res = parse(await createHandler(f.deps)(post({ month: "202610" })));
    assert.equal(res.status, 409);
    assert.match(res.body.message, /^2026년 11월 해설을 만드는 중입니다/);
  });
});

// ---- security round: 서버 쪽 임의 비밀 + 비공개 인증 상태 버킷 ----
describe("security: HMAC 비밀은 서버 쪽 임의 값, 컨테이너마다 한 번 읽는다", () => {
  const wrongFrom = () => post({ month: "202610" }, { "cloudfront-viewer-address": "198.51.100.10:46532", "x-presenter-key": "wrong" });

  test("여러 요청에도 한 번만 읽는다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    await h(post({ month: "abc" }));
    f.setNow(NOW + 3_600_000);
    await h(post({ month: "abc" }));
    assert.equal(f.secretReads.length, 1);
  });

  test("비밀을 못 읽으면 캐시하지 않고 비교 없이 503 auth_unavailable, 다음 요청에서 다시 읽는다", async () => {
    let n = 0;
    const f = fakeDeps({ nowMs: NOW, getAuthSecret: async () => { n++; if (n === 1) throw new Error("ResourceNotFoundException"); return AUTH_SECRET; } });
    const h = createHandler(f.deps);
    const first = parse(await h(post({ month: "202610" })));
    assert.equal(first.status, 503);
    assert.equal(first.body.error, "auth_unavailable");
    assert.equal(f.invokes.length, 0);
    assert.ok(f.logs.some((l) => l.level === "warn" && l.msg.startsWith("암호 시도를 기록하지 못해 거절")));
    assert.ok(!JSON.stringify(f.logs).includes(AUTH_SECRET));
    assert.equal((await h(post({ month: "202610" }))).statusCode, 202);
    assert.equal(f.secretReads.length, 2);
  });

  test("암호를 바꿔도 셈의 키는 그대로다(키는 암호와 무관)", async () => {
    let pass = PASS;
    const f = fakeDeps({ nowMs: NOW, getParameter: async (name) => (name === "/seoul-ar/presenter-passcode" ? pass : FAKE_KEY) });
    const h = createHandler(f.deps);
    await h(wrongFrom());
    pass = "a-completely-different-passcode";
    f.setNow(NOW + 61_000); // 암호 캐시가 지난 뒤
    await h(wrongFrom());
    const keys = new Set(f.deps.authStore.puts.map((p) => p.key));
    assert.equal(keys.size, 1);
    assert.equal(JSON.parse(f.deps.authStore.objects.get([...keys][0]).text).count, 2);
  });

  test("잠긴 접속은 발표자 암호(SSM)를 읽기 전에 429", async () => {
    const reads = [];
    const f = fakeDeps({ nowMs: NOW, getParameter: async (name) => { reads.push(name); return PASS; } });
    const h = createHandler(f.deps);
    for (let i = 0; i < 10; i++) await h(wrongFrom());
    const before = reads.length;
    f.setNow(NOW + 120_000); // 암호 캐시가 지난 뒤에도
    assert.equal((await h(wrongFrom())).statusCode, 429);
    assert.equal(reads.length, before);
  });

  test("사이트 버킷 어디에도 _auth 나 시도 기록을 쓰지 않는다", async () => {
    const f = fakeDeps({ nowMs: NOW });
    const h = createHandler(f.deps);
    for (let i = 0; i < 3; i++) await h(wrongFrom());
    await h(post({ month: "202610" }));
    assert.ok(f.deps.store.puts.every((p) => !p.key.includes("_auth") && !p.key.startsWith("attempts/")), JSON.stringify(f.deps.store.puts.map((p) => p.key)));
    assert.ok(f.deps.authStore.puts.length >= 3);
  });
});

// ---- final fix wave: 응답 모양과 암호 최소 길이 ----
describe("final: 저장된 발표자 암호가 12자보다 짧으면 503 passcode_too_short", () => {
  test("11자 암호: 맞혀도 503, error 로그, 작업 없음, 시도로 세지 않는다(잠기지 않음)", async () => {
    const short = "elevenchars"; // 11자
    const f = fakeDeps({ nowMs: NOW, params: { "/seoul-ar/presenter-passcode": short } });
    const h = createHandler(f.deps);
    for (let i = 0; i < 12; i++) {
      const res = parse(await h(post({ month: "202610" }, { "x-presenter-key": short })));
      assert.equal(res.status, 503, `요청 ${i + 1}`);
      assert.equal(res.body.error, "passcode_too_short");
      assert.equal(res.body.message, "발표자 암호는 12자 이상이어야 합니다. SSM 값을 바꿔 주세요.");
    }
    assert.equal(f.invokes.length, 0);
    assert.ok(f.logs.some((l) => l.level === "error" && /12자/.test(l.msg)));
    assert.ok(!JSON.stringify(f.logs).includes(short), "암호 값은 로그에 없다");
  });

  test("12자 암호는 받는다 (코드 포인트로 센다)", async () => {
    for (const pass of ["twelve-chars", "발표자암호발표자암호발표"]) {
      assert.equal([...pass].length, 12);
      const f = fakeDeps({ nowMs: NOW, params: { "/seoul-ar/presenter-passcode": pass } });
      assert.equal((await createHandler(f.deps)(post({ month: "202610" }, { "x-presenter-key": pass }))).statusCode, 202, pass);
    }
  });
});

describe("final: 2xx 가 아닌 응답은 모두 { error, message(한국어 한 문장) }", () => {
  test("404·405·400·401·409·429·500·503", async () => {
    const shapes = [];
    const check = (res, status) => {
      const r = parse(res);
      assert.equal(r.status, status);
      assert.equal(typeof r.body.error, "string");
      assert.ok(r.body.error.length > 0);
      assert.match(r.body.message, /[가-힣]/);
      assert.match(r.body.message, /[.다요]$/);
      shapes.push(`${status}:${r.body.error}`);
    };
    let f = fakeDeps({ nowMs: NOW });
    let h = createHandler(f.deps);
    check(await h(httpEvent({ path: "/api/unknown", headers: { "x-presenter-key": PASS } })), 404);
    check(await h(httpEvent({ method: "GET", headers: { "x-presenter-key": PASS } })), 405);
    check(await h(post("{nope")), 400);
    check(await h(post({ month: "2026-10" })), 400);
    check(await h(post({ month: "202610" }, { "x-presenter-key": "wrong" })), 401);
    const busy = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "b-1", month: "202609", ts: NOW } });
    f = fakeDeps({ nowMs: NOW, store: busy });
    check(await createHandler(f.deps)(post({ month: "202610" })), 409);
    f = fakeDeps({ nowMs: NOW });
    h = createHandler(f.deps);
    for (let i = 0; i < 10; i++) await h(post({ month: "202610" }, { "x-presenter-key": "wrong" }));
    check(await h(post({ month: "202610" })), 429);
    f = fakeDeps({ nowMs: NOW, getParameter: async () => { throw new Error("Throttling"); } });
    check(await createHandler(f.deps)(post({ month: "202610" })), 500);
    f = fakeDeps({ nowMs: NOW });
    f.deps.authStore.failPut = () => new Error("SlowDown");
    check(await createHandler(f.deps)(post({ month: "202610" })), 503);
    assert.deepEqual(shapes, ["404:not_found", "405:method_not_allowed", "400:bad_request", "400:bad_month", "401:unauthorized", "409:busy", "429:locked", "500:config", "503:auth_unavailable"]);
  });

  test("409 는 잠금 주인 종류별 문구: 수집 '{월} 데이터를 가져오는 중입니다', 해설 '{월} 해설을 만드는 중입니다'", async () => {
    for (const [kind, re] of [[undefined, /^2026년 9월 데이터를 가져오는 중입니다/], ["narration", /^2026년 9월 해설을 만드는 중입니다/]]) {
      const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "h-1", month: "202609", ...(kind ? { kind } : {}), ts: NOW } });
      const f = fakeDeps({ nowMs: NOW, store });
      const r = parse(await createHandler(f.deps)(post({ month: "202610" })));
      assert.equal(r.body.error, "busy");
      assert.match(r.body.message, re);
    }
  });
});

describe("final micro: 자동 해설은 잠금을 잡자마자 running 0/26 을 알린다", () => {
  test("첫 해설 이벤트와 작업 기록은 Bedrock 호출 전에 running 0/26", async () => {
    const f = workerSetup({ env: NARR_ENV });
    let seenAtCall = null;
    f.deps.converse = fakeConverse(() => {
      seenAtCall = {
        events: f.published.filter((m) => m.kind === "narration").map((m) => ({ state: m.state, done: m.done, total: m.total })),
        record: f.deps.store.json("data/jobs/job-0001-aaaa-narration.json"),
      };
      return bulkReply();
    });
    await startedJob(f);
    assert.deepEqual(seenAtCall.events, [{ state: "running", done: 0, total: 26 }]);
    assert.equal(seenAtCall.record.state, "running");
    assert.equal(seenAtCall.record.done, 0);
    assert.equal(seenAtCall.record.total, 26);
    assert.equal(seenAtCall.record.kind, "narration");
    const narr = f.published.filter((m) => m.kind === "narration");
    assert.deepEqual({ state: narr[0].state, done: narr[0].done, jobId: narr[0].jobId }, { state: "running", done: 0, jobId: "job-0001-aaaa-narration" });
    assert.equal(narr.at(-1).state, "done");
  });
});

// ---- Task 13: 접수연도 한 해를 한 번에 (action fetch-year) ----
function yearData() {
  return {
    강남구: [
      row({ CTRT_DAY: "20241215", THING_AMT: "300000", ARCH_AREA: 100 }),
      row({ CTRT_DAY: "20240310", STDG_NM: "논현동", THING_AMT: "90000", ARCH_AREA: 30 }),
      row({ CTRT_DAY: "20240120", THING_AMT: "200000", ARCH_AREA: 80 }),
      row({ CTRT_DAY: "20240105", THING_AMT: "100000", ARCH_AREA: 50, RTRCN_DAY: "20240110" }),
      row({ CTRT_DAY: "20231228", THING_AMT: "1", ARCH_AREA: 1 }), // 전년 12월 계약, 1월 신고: 버림
    ],
    서초구: [
      row({ CGG_NM: "서초구", CTRT_DAY: "20241105", STDG_NM: "반포동", THING_AMT: "400000", ARCH_AREA: 100 }),
      row({ CGG_NM: "서초구", CTRT_DAY: "20240115", STDG_NM: "반포동", THING_AMT: "200000", ARCH_AREA: 100 }),
    ],
  };
}

function yearSetup(over = {}) {
  const store = over.store ?? fakeStore({ [INDEX_KEY]: existingIndex() });
  return fakeDeps({ nowMs: NOW, store, fetch: over.fetch ?? fakeSeoulFetch(yearData()), ...over });
}

const yearEvent = (over = {}) => ({ action: "fetch-year", year: "2024", jobId: "year-2024-test1", ...over });

describe("fetch-year: 검증과 잠금", () => {
  test("연도 형식·범위가 틀리면 아무것도 하지 않는다", async () => {
    for (const year of ["2027", "2005", "24", "abcd", undefined]) {
      const f = yearSetup();
      const out = await createHandler(f.deps)(yearEvent({ year }));
      assert.equal(out.ok, false, String(year));
      assert.equal(out.error, "bad_year");
      assert.equal(f.deps.fetch.calls.length, 0);
      assert.equal(f.deps.store.puts.length, 0);
      assert.equal(f.published.length, 0);
    }
  });

  test("jobId 형식이 틀리면 거절, 없으면 year-YYYY-<ts> 로 만든다", async () => {
    let f = yearSetup();
    assert.equal((await createHandler(f.deps)(yearEvent({ jobId: "../x" }))).ok, false);
    f = yearSetup();
    const out = await createHandler(f.deps)(yearEvent({ jobId: undefined }));
    assert.equal(out.jobId, `year-2024-${NOW}`);
    assert.equal(f.published[0].jobId, `year-2024-${NOW}`);
  });

  test("다른 작업이 잠금을 잡고 있으면 시작하지 않는다(busy)", async () => {
    const store = fakeStore({ [INDEX_KEY]: existingIndex(), [LOCK_KEY]: { v: 1, jobId: "busy-1", month: "202610", ts: NOW } });
    const f = yearSetup({ store });
    const out = await createHandler(f.deps)(yearEvent());
    assert.equal(out.ok, false);
    assert.equal(out.error, "busy");
    assert.equal(f.deps.fetch.calls.length, 0);
  });

  test("연도 작업이 잠금을 잡고 있으면 API 409 는 '2024년 한 해 데이터를 가져오는 중입니다'", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "year-2024-x", month: "202400", kind: "fetch-year", ts: NOW } });
    const f = fakeDeps({ nowMs: NOW, store });
    const r = parse(await createHandler(f.deps)(post({ month: "202610" })));
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^2024년 한 해 데이터를 가져오는 중입니다/);
  });
});

describe("fetch-year: 구마다 한 번, 계약 연월로 나눠 쓰기", () => {
  test("구마다 접수연도 전체를 한 번만 부르고(RCPT_YR=2024), 보인 달마다 25개 파일", async () => {
    const f = yearSetup();
    const out = await createHandler(f.deps)(yearEvent());
    assert.equal(out.ok, true);
    const calls = f.deps.fetch.calls;
    assert.equal(calls.length, 25, "구마다 한 페이지(행이 적다)");
    assert.ok(calls.every((c) => c.year === "2024"));
    assert.deepEqual(out.months, ["202401", "202403", "202411", "202412"]);
    for (const m of out.months) {
      const files = [...f.deps.store.objects.keys()].filter((k) => k.startsWith(`data/${m}/`));
      assert.equal(files.length, 25, m);
    }
    assert.equal([...f.deps.store.objects.keys()].some((k) => k.startsWith("data/202402/")), false, "아무 구에도 없는 달은 만들지 않는다");
    assert.equal([...f.deps.store.objects.keys()].some((k) => k.startsWith("data/2023")), false, "전년 계약은 버린다");
    const gn01 = f.deps.store.json("data/202401/강남구.json");
    assert.deepEqual(gn01, aggregateRows(yearData().강남구.filter((r) => r.CTRT_DAY.startsWith("202401")), { month: "202401", gu: "강남구", generatedAt: new Date(NOW).toISOString() }));
    assert.equal(gn01.total.n, 1);
    assert.equal(gn01.total.cancelled, 1);
    const empty = f.deps.store.json("data/202401/종로구.json");
    assert.deepEqual(empty, aggregateRows([], { month: "202401", gu: "종로구", generatedAt: new Date(NOW).toISOString() }));
    const put = f.deps.store.puts.find((p) => p.key === "data/202412/서초구.json");
    assert.equal(put.opts.cacheControl, "no-cache");
    for (const p of f.deps.store.puts.filter((x) => x.key.startsWith("data/2024"))) {
      for (const banned of ["MNO", "SNO", "BLDG_NM", "비밀아파트테스트"]) assert.ok(!p.text.includes(banned), `${p.key} ${banned}`);
    }
  });

  test("index: 그 해 달을 모두 추가·정렬, 기존 202611 유지, /data/* 무효화", async () => {
    const f = yearSetup();
    await createHandler(f.deps)(yearEvent());
    const idx = f.deps.store.json(INDEX_KEY);
    assert.deepEqual(idx.months, ["202401", "202403", "202411", "202412", "202611"]);
    assert.deepEqual(idx.summary["202611"], existingIndex().summary["202611"]);
    assert.equal(idx.summary["202401"]["서초구"].n, 1);
    assert.equal(idx.summary["202401"]["종로구"].n, 0);
    assert.deepEqual(f.invalidations, [{ distributionId: "EDISTTEST", paths: ["/data/*"], callerReference: "year-2024-test1" }]);
  });

  test("12달 모두 있으면 index 에 12달", async () => {
    const all = Array.from({ length: 12 }, (_, i) => row({ CTRT_DAY: `2024${String(i + 1).padStart(2, "0")}10` }));
    const f = yearSetup({ fetch: fakeSeoulFetch({ 강남구: all }) });
    const out = await createHandler(f.deps)(yearEvent());
    assert.equal(out.months.length, 12);
    const idx = f.deps.store.json(INDEX_KEY);
    assert.deepEqual(idx.months, [...expectedYearMonths("2024"), "202611"]);
    for (const m of expectedYearMonths("2024")) assert.equal(Object.keys(idx.summary[m]).length, 25);
  });

  test("올해(2026)는 한국 시간 이번 달(11월)까지만", async () => {
    const f = yearSetup({ fetch: fakeSeoulFetch({ 강남구: [row({ CTRT_DAY: "20261110" }), row({ CTRT_DAY: "20261201" })] }) });
    const out = await createHandler(f.deps)(yearEvent({ year: "2026", jobId: "year-2026-t" }));
    assert.deepEqual(out.months, ["202611"]);
  });
});

function expectedYearMonths(y) {
  return Array.from({ length: 12 }, (_, i) => `${y}${String(i + 1).padStart(2, "0")}`);
}

describe("fetch-year: 진행 이벤트", () => {
  test("kind fetch-year, month YYYY00, running 0/25 → done 1..25 (구 이름) → done, 기록 = 마지막", async () => {
    const f = yearSetup();
    await createHandler(f.deps)(yearEvent());
    const msgs = f.published;
    assert.ok(msgs.every((m) => m.kind === "fetch-year" && m.month === "202400" && m.total === 25 && m.v === 1 && m.type === "job" && typeof m.ts === "number"));
    assert.deepEqual({ state: msgs[0].state, done: msgs[0].done }, { state: "running", done: 0 });
    const running = msgs.slice(1, -1);
    assert.deepEqual(running.map((m) => m.done), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.deepEqual(running.map((m) => m.gu), GU_ORDER);
    assert.equal(msgs.at(-1).state, "done");
    assert.equal(msgs.at(-1).done, 25);
    assert.deepEqual(f.deps.store.json("data/jobs/year-2024-test1.json"), msgs.at(-1));
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
    assert.equal(f.deps.store.json(LOCK_KEY).kind, "fetch-year");
  });

  test("done message: 11·12월이 있으면 다음 해 신고 안내", async () => {
    const f = yearSetup();
    await createHandler(f.deps)(yearEvent());
    assert.match(f.published.at(-1).message, /11·12월은 다음 해에 신고된 거래가 빠질 수 있습니다/);
  });

  test("서울 API 페이지 수를 로그에 남긴다", async () => {
    const f = yearSetup();
    const out = await createHandler(f.deps)(yearEvent());
    assert.equal(out.pages, 25);
    assert.ok(f.logs.some((l) => l.level === "info" && l.fields?.pages === 25 && /페이지/.test(l.msg)));
  });
});

describe("fetch-year: resume", () => {
  function completeGu(store, gu, n) {
    for (const m of expectedYearMonths("2024")) {
      const data = aggregateRows(Array.from({ length: n }, () => row({ CGG_NM: gu, CTRT_DAY: `${m}10` })), { month: m, gu, generatedAt: "old" });
      store.objects.set(`data/${m}/${gu}.json`, { text: JSON.stringify(data), etag: `"${m}${gu}"`, opts: {} });
    }
  }

  test("기대한 12달 파일이 모두 있는 구는 서울 API 를 부르지 않고 done 으로 센다, index 는 그 파일로", async () => {
    const store = fakeStore({ [INDEX_KEY]: existingIndex() });
    completeGu(store, "종로구", 5);
    const f = yearSetup({ store });
    const out = await createHandler(f.deps)(yearEvent({ resume: true }));
    assert.deepEqual(out.skipped, ["종로구"]);
    assert.equal(f.deps.fetch.calls.filter((c) => c.gu === "종로구").length, 0);
    assert.equal(f.deps.fetch.calls.length, 24);
    assert.equal(f.published.filter((m) => m.state === "running" && m.gu === "종로구").length, 1);
    assert.equal(f.published.at(-1).state, "done");
    // 건너뛴 구가 12달을 갖고 있으므로 12달 모두 index 에, 그 구 값은 기존 파일에서
    const idx = f.deps.store.json(INDEX_KEY);
    assert.deepEqual(idx.months, [...expectedYearMonths("2024"), "202611"]);
    assert.equal(idx.summary["202405"]["종로구"].n, 5);
    assert.equal(f.deps.store.json("data/202405/종로구.json").generatedAt, "old", "건너뛴 구 파일은 다시 쓰지 않는다");
    assert.equal(f.deps.store.json("data/202405/강남구.json").total.n, 0, "다른 구는 빈 파일로 채운다");
  });

  test("한 달이라도 빠진 구는 다시 받는다, resume 이 아니면 모두 다시 받는다", async () => {
    const store = fakeStore({ [INDEX_KEY]: existingIndex() });
    completeGu(store, "종로구", 5);
    store.objects.delete("data/202407/종로구.json");
    let f = yearSetup({ store });
    await createHandler(f.deps)(yearEvent({ resume: true }));
    assert.equal(f.deps.fetch.calls.filter((c) => c.gu === "종로구").length, 1);
    const store2 = fakeStore({ [INDEX_KEY]: existingIndex() });
    completeGu(store2, "종로구", 5);
    f = yearSetup({ store: store2 });
    await createHandler(f.deps)(yearEvent({ resume: false }));
    assert.equal(f.deps.fetch.calls.filter((c) => c.gu === "종로구").length, 1);
  });
});

describe("fetch-year: 상한과 할당량", () => {
  test("60페이지 상한에 닿은 구는 그 구의 모든 달 truncated, done message 에 구 이름", async () => {
    const huge = Array.from({ length: 61000 }, (_, i) => row({ CTRT_DAY: i % 2 ? "20240510" : "20240610" }));
    const f = yearSetup({ fetch: fakeSeoulFetch({ ...yearData(), 송파구: huge.map((r) => ({ ...r, CGG_NM: "송파구" })) }), concurrency: 4 });
    const out = await createHandler(f.deps)(yearEvent());
    assert.deepEqual(out.capped, ["송파구"]);
    assert.equal(f.deps.store.json("data/202405/송파구.json").total.truncated, true);
    assert.equal(f.deps.store.json("data/202406/송파구.json").total.truncated, true);
    assert.equal(f.deps.store.json("data/202401/강남구.json").total.truncated, false);
    assert.equal(f.deps.store.json("data/202401/송파구.json").total.truncated, true, "상한 구의 빈 채움 달도 불완전");
    assert.equal(f.deps.store.json(INDEX_KEY).summary["202405"]["송파구"].truncated, true);
    assert.match(f.published.at(-1).message, /일부 구는 거래가 많아 끝까지 받지 못했습니다: 송파구/);
  });

  test("상한에 닿지 않았으면 한 달 1,500건이어도 truncated false (집계 모듈의 1000건 규칙 대신)", async () => {
    const many = Array.from({ length: 1500 }, () => row({ CTRT_DAY: "20240510" }));
    const f = yearSetup({ fetch: fakeSeoulFetch({ 강남구: many }) });
    await createHandler(f.deps)(yearEvent());
    const g = f.deps.store.json("data/202405/강남구.json");
    assert.equal(g.total.n, 1500);
    assert.equal(g.total.truncated, false);
  });

  test("서울 API 오류 코드(하루 한도 등) → error: 한도 안내 + resume, 키·URL 없음, 잠금 해제, 앞서 끝난 구 파일은 남는다", async () => {
    const base = fakeSeoulFetch({ 종로구: [row({ CGG_NM: "종로구", CTRT_DAY: "20240301" })] });
    const fetch = async (url, init) => {
      const gu = decodeURIComponent(new URL(url).pathname.split("/")[8]);
      if (gu === "중구") return jsonResponse({ RESULT: { CODE: "ERROR-337", MESSAGE: `일일 트래픽 초과 ${FAKE_KEY}` } });
      return base(url, init);
    };
    const f = yearSetup({ fetch });
    const out = await createHandler(f.deps)(yearEvent());
    assert.equal(out.ok, false);
    const last = f.published.at(-1);
    assert.equal(last.state, "error");
    assert.equal(last.kind, "fetch-year");
    assert.match(last.message, /중구/);
    assert.match(last.message, /하루 호출 한도/);
    assert.match(last.message, /resume/);
    assert.ok(!JSON.stringify([f.published, f.logs]).includes(FAKE_KEY));
    assert.ok(!JSON.stringify(f.published).includes("openapi.seoul.go.kr"));
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
    assert.ok(f.deps.store.json("data/202403/종로구.json"), "끝난 구는 남아 resume 이 건너뛴다");
    assert.deepEqual(f.deps.store.json(INDEX_KEY).months, ["202611"], "index 는 건드리지 않는다");
    assert.ok(f.logs.some((l) => /페이지/.test(l.msg) && typeof l.fields?.pages === "number"));
  });
});

describe("fetch-year: narrate", () => {
  test("narrate true 면 달마다 차례로 해설(kind narration, 달마다 jobId), 기본은 하지 않는다", async () => {
    let f = yearSetup({ env: NARR_ENV });
    await createHandler(f.deps)(yearEvent());
    assert.equal(f.deps.converse.calls.length, 0);
    f = yearSetup({ env: NARR_ENV });
    const out = await createHandler(f.deps)(yearEvent({ narrate: true }));
    for (const m of out.months) {
      assert.equal(Object.keys(f.deps.store.json(`data/${m}/narration.json`).items).length, 26, m);
      assert.equal(f.deps.store.json(`data/jobs/year-2024-test1-${m}-narration.json`).state, "done");
    }
    assert.equal(f.deps.converse.calls.length, out.months.length);
    const fetchDone = f.published.findIndex((m) => m.kind === "fetch-year" && m.state === "done");
    const firstNarr = f.published.findIndex((m) => m.kind === "narration");
    assert.ok(fetchDone < firstNarr, "연도 작업 done 뒤에 해설");
  });
});

describe("Task 13: 운영자가 narrate 를 직접 부르면 스스로 잠금을 잡는다", () => {
  test("API 없이 {action: narrate} → kind narration 잠금을 잡고 풀며 해설을 만든다", async () => {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV });
    let lockDuring = null;
    f.deps.converse = fakeConverse(() => { lockDuring = f.deps.store.json(LOCK_KEY); return bulkReply(); });
    const out = await createHandler(f.deps)({ action: "narrate", jobId: "n-202611-op1", month: "202611" });
    assert.equal(out.ok, true);
    assert.equal(lockDuring.jobId, "n-202611-op1");
    assert.equal(lockDuring.kind, "narration");
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
    assert.ok(f.deps.store.json("data/202611/narration.json"));
  });

  test("다른 작업이 잠금을 잡고 있으면 Bedrock 을 부르지 않고 busy", async () => {
    const store = storeWith202611();
    store.objects.set(LOCK_KEY, { text: JSON.stringify({ v: 1, jobId: "year-2024-x", month: "202400", kind: "fetch-year", ts: NOW }), etag: '"y"', opts: {} });
    const f = fakeDeps({ nowMs: NOW, store, env: NARR_ENV });
    const out = await createHandler(f.deps)({ action: "narrate", jobId: "n-202611-op2", month: "202611" });
    assert.equal(out.ok, false);
    assert.equal(out.error, "busy");
    assert.equal(f.deps.converse.calls.length, 0);
    assert.equal(f.deps.store.json(LOCK_KEY).jobId, "year-2024-x");
  });
});


describe("Task 11b: narrate onlyMissing / refreshTemplates", () => {
  function putNarration(store, { omit = [], template = [], withSource = true } = {}) {
    const keys = ["서울 전체", ...GU_ORDER].filter((k) => !omit.includes(k));
    const n = { v: 1, month: "202611", generatedAt: "old", model: "us.anthropic.claude-haiku-5-5", items: Object.fromEntries(keys.map((k) => [k, `기존 ${k} 문장입니다.`])) };
    if (withSource) n.source = Object.fromEntries(keys.map((k) => [k, template.includes(k) ? "template" : "model"]));
    store.objects.set("data/202611/narration.json", { text: JSON.stringify(n), etag: '"n"', opts: {} });
  }
  const run = (f, extra) => createHandler(f.deps)({ action: "narrate", jobId: "n-202611-fill1", month: "202611", onlyMissing: true, ...extra });

  test("없는 키만 묻고 기존 문장은 그대로 합친다(26/26)", async () => {
    const store = storeWith202611();
    putNarration(store, { omit: ["서울 전체", "중구"] });
    const f = fakeDeps({ nowMs: NOW, store, env: NARR_ENV });
    const out = await run(f);
    assert.equal(out.ok, true);
    assert.equal(f.deps.converse.calls.length, 1);
    assert.match(f.deps.converse.calls[0].prompt, /키 목록\(정확히 이 2개\): 서울 전체, 중구/);
    const n = f.deps.store.json("data/202611/narration.json");
    assert.equal(Object.keys(n.items).length, 26);
    assert.deepEqual(Object.keys(n.items), ["서울 전체", ...GU_ORDER]);
    assert.equal(n.items["강남구"], "기존 강남구 문장입니다.");
    assert.equal(n.items["중구"], "중구 10월 요약입니다.");
    assert.equal(n.source["중구"], "model");
    assert.equal(n.source["강남구"], "model");
    assert.equal(n.generatedAt, new Date(NOW).toISOString());
    assert.equal(f.published.at(-1).state, "done");
  });

  test("refreshTemplates: source 가 template 인 키도 다시 만든다", async () => {
    const store = storeWith202611();
    putNarration(store, { template: ["강남구", "송파구"] });
    const f = fakeDeps({ nowMs: NOW, store, env: NARR_ENV });
    await run(f, { refreshTemplates: true });
    assert.match(f.deps.converse.calls[0].prompt, /키 목록\(정확히 이 2개\): 강남구, 송파구/);
    const n = f.deps.store.json("data/202611/narration.json");
    assert.equal(n.source["강남구"], "model");
    assert.equal(n.items["강남구"], "강남구 10월 요약입니다.");
    assert.equal(n.items["종로구"], "기존 종로구 문장입니다.");
  });

  test("빠진 것이 없으면 Bedrock 을 부르지 않고 done '이미'", async () => {
    const store = storeWith202611();
    putNarration(store, { template: ["강남구"] });
    const f = fakeDeps({ nowMs: NOW, store, env: NARR_ENV });
    await run(f);
    assert.equal(f.deps.converse.calls.length, 0);
    assert.equal(f.published.at(-1).state, "done");
    assert.match(f.published.at(-1).message, /이미/);
    assert.equal(f.deps.store.json(LOCK_KEY).released, true);
  });

  test("source 가 없는 옛 파일은 모두 model 로 본다(refreshTemplates 여도 다시 만들지 않음)", async () => {
    const store = storeWith202611();
    putNarration(store, { withSource: false, omit: ["용산구"] });
    const f = fakeDeps({ nowMs: NOW, store, env: NARR_ENV });
    await run(f, { refreshTemplates: true });
    assert.match(f.deps.converse.calls[0].prompt, /키 목록\(정확히 이 1개\): 용산구/);
    const n = f.deps.store.json("data/202611/narration.json");
    assert.equal(n.source["종로구"], "model");
  });

  test("기존 파일이 없으면 26개 모두 만든다", async () => {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV });
    await run(f);
    assert.match(f.deps.converse.calls[0].prompt, /키 목록\(정확히 이 26개\)/);
    assert.equal(Object.keys(f.deps.store.json("data/202611/narration.json").items).length, 26);
  });

  test("API: narrate-month 본문의 onlyMissing·refreshTemplates 를 작업자에 넘긴다", async () => {
    const f = fakeDeps({ nowMs: NOW, store: storeWith202611(), env: NARR_ENV });
    const ev = httpEvent({ path: "/api/narrate-month", headers: { "x-presenter-key": PASS }, body: JSON.stringify({ month: "202611", onlyMissing: true, refreshTemplates: true }) });
    assert.equal((await createHandler(f.deps)(ev)).statusCode, 202);
    assert.deepEqual(f.invokes[0].payload, { action: "narrate", jobId: "job-0001-aaaa", month: "202611", onlyMissing: true, refreshTemplates: true });
  });
});
