import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateMonth, currentMonthKst, passcodeMatches, createHandler, MIN_MONTH } from "./index.mjs";
import { LOCK_KEY, INDEX_KEY, isLockFresh } from "./job.mjs";
import { aggregateRows, buildIndex } from "./aggregate.mjs";
import { fakeDeps, fakeStore, fakeSeoulFetch, httpEvent, row, jsonResponse, FAKE_KEY, GU_ORDER } from "./fakes.mjs";

const NOW = Date.UTC(2026, 10, 17, 3, 0, 0); // 2026-11-17 12:00 KST
const PASS = "open-sesame";

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
      assert.equal(f.deps.store.puts.length, 0);
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
