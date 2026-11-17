import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LOCK_KEY, LOCK_STALE_MS, INDEX_KEY, jobKey, guKey, PreconditionFailed, isPrecondition,
  isLockFresh, acquireLock, releaseLock, mergeIndex, JobError, writeJobRecord, JSON_PUT,
  rebuildIndexFromStore, mapPool,
} from "./job.mjs";
import { aggregateRows, buildIndex, SOURCE } from "./aggregate.mjs";
import { GU_ORDER } from "./gu.mjs";
import { fakeStore, row } from "./fakes.mjs";

const NOW = Date.UTC(2026, 10, 17, 3, 0, 0);

describe("키 이름", () => {
  test("lock, index, 작업 기록, 구 파일", () => {
    assert.equal(LOCK_KEY, "data/jobs/lock.json");
    assert.equal(INDEX_KEY, "data/index.json");
    assert.equal(jobKey("abc-1"), "data/jobs/abc-1.json");
    assert.equal(guKey("202610", "강남구"), "data/202610/강남구.json");
    assert.equal(LOCK_STALE_MS, 10 * 60 * 1000);
  });

  test("JSON 쓰기 옵션은 no-cache + UTF-8 JSON", () => {
    assert.deepEqual(JSON_PUT, { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" });
  });
});

describe("isLockFresh", () => {
  test("10분 안이면 fresh, 10분 넘으면 stale", () => {
    assert.equal(isLockFresh({ jobId: "a", ts: NOW - 60_000 }, NOW), true);
    assert.equal(isLockFresh({ jobId: "a", ts: NOW - LOCK_STALE_MS + 1 }, NOW), true);
    assert.equal(isLockFresh({ jobId: "a", ts: NOW - LOCK_STALE_MS }, NOW), false);
    assert.equal(isLockFresh({ jobId: "a", ts: NOW - 11 * 60_000 }, NOW), false);
  });

  test("해제된 잠금, 깨진 잠금, 없는 잠금은 fresh 아님", () => {
    assert.equal(isLockFresh({ jobId: "a", ts: NOW, released: true }, NOW), false);
    assert.equal(isLockFresh({ jobId: "a", ts: "어제" }, NOW), false);
    assert.equal(isLockFresh(null, NOW), false);
  });
});

describe("acquireLock / releaseLock", () => {
  test("잠금이 없으면 IfNoneMatch 로 만든다", async () => {
    const store = fakeStore();
    const out = await acquireLock(store, { jobId: "j1", month: "202610", nowMs: NOW });
    assert.deepEqual(out, { ok: true });
    assert.equal(store.puts[0].opts.ifNoneMatch, "*");
    assert.equal(store.puts[0].opts.cacheControl, "no-cache");
    assert.deepEqual(store.json(LOCK_KEY), { v: 1, jobId: "j1", month: "202610", ts: NOW, startedAt: new Date(NOW).toISOString() });
  });

  test("fresh 잠금이 있으면 실패하고 보유 작업을 알려 준다", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "old", month: "202609", ts: NOW - 5 * 60_000 } });
    const out = await acquireLock(store, { jobId: "j2", month: "202610", nowMs: NOW });
    assert.equal(out.ok, false);
    assert.equal(out.holder.jobId, "old");
    assert.equal(out.holder.month, "202609");
    assert.equal(out.holder.kind, null);
    assert.equal(store.json(LOCK_KEY).jobId, "old");
  });

  test("stale 잠금(10분 넘음)은 IfMatch 로 넘겨받는다", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "old", month: "202609", ts: NOW - 11 * 60_000 } });
    const etag = (await store.get(LOCK_KEY)).etag;
    const out = await acquireLock(store, { jobId: "j3", month: "202610", nowMs: NOW });
    assert.deepEqual(out, { ok: true });
    assert.equal(store.json(LOCK_KEY).jobId, "j3");
    assert.equal(store.puts.at(-1).opts.ifMatch, etag);
  });

  test("해제된 잠금은 넘겨받는다", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "old", ts: NOW, released: true } });
    assert.deepEqual(await acquireLock(store, { jobId: "j4", month: "202610", nowMs: NOW }), { ok: true });
  });

  test("깨진 잠금 파일은 stale 로 본다", async () => {
    const store = fakeStore({ [LOCK_KEY]: "{not json" });
    assert.deepEqual(await acquireLock(store, { jobId: "j5", month: "202610", nowMs: NOW }), { ok: true });
  });

  test("넘겨받는 사이 다른 요청이 먼저 쓰면(IfMatch 실패) 실패", async () => {
    const store = fakeStore({ [LOCK_KEY]: { v: 1, jobId: "old", ts: NOW - 11 * 60_000 } });
    const realGet = store.get.bind(store);
    store.get = async (key) => {
      const cur = await realGet(key);
      // 읽은 뒤, 쓰기 전에 경쟁자가 잠금을 가져간다
      store.objects.set(LOCK_KEY, { text: JSON.stringify({ v: 1, jobId: "rival", ts: NOW }), etag: '"rival"', opts: {} });
      return cur;
    };
    const out = await acquireLock(store, { jobId: "j6", month: "202610", nowMs: NOW });
    assert.equal(out.ok, false);
    assert.equal(store.json(LOCK_KEY).jobId, "rival");
  });

  test("kind 를 주면 잠금에 남기고 보유자 정보로 돌려준다", async () => {
    const store = fakeStore();
    await acquireLock(store, { jobId: "n1", month: "202611", nowMs: NOW, kind: "narration" });
    assert.equal(store.json(LOCK_KEY).kind, "narration");
    const out = await acquireLock(store, { jobId: "x", month: "202610", nowMs: NOW });
    assert.deepEqual(out, { ok: false, holder: { jobId: "n1", month: "202611", kind: "narration" } });
  });

  test("S3 오류는 그대로 올린다", async () => {
    const store = fakeStore();
    store.failPut = () => new Error("AccessDenied");
    await assert.rejects(acquireLock(store, { jobId: "j7", month: "202610", nowMs: NOW }), /AccessDenied/);
  });

  test("release 는 자기 잠금만 해제 표시로 덮어쓴다", async () => {
    const store = fakeStore();
    await acquireLock(store, { jobId: "mine", month: "202610", nowMs: NOW });
    assert.equal(await releaseLock(store, { jobId: "other", nowMs: NOW }), false);
    assert.equal(store.json(LOCK_KEY).released, undefined);
    assert.equal(await releaseLock(store, { jobId: "mine", nowMs: NOW + 1000 }), true);
    const lock = store.json(LOCK_KEY);
    assert.equal(lock.released, true);
    assert.equal(lock.jobId, "mine");
    assert.equal(isLockFresh(lock, NOW + 1000), false);
    // 해제 뒤에는 바로 새 작업이 잡을 수 있다
    assert.deepEqual(await acquireLock(store, { jobId: "next", month: "202609", nowMs: NOW + 2000 }), { ok: true });
  });

  test("잠금이 없으면 release 는 false", async () => {
    assert.equal(await releaseLock(fakeStore(), { jobId: "x", nowMs: NOW }), false);
  });

  test("isPrecondition 은 PreconditionFailed 와 S3 412/409 를 알아본다", () => {
    assert.equal(isPrecondition(new PreconditionFailed()), true);
    assert.equal(isPrecondition(Object.assign(new Error("x"), { name: "PreconditionFailed" })), true);
    assert.equal(isPrecondition(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 412 } })), true);
    assert.equal(isPrecondition(Object.assign(new Error("x"), { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } })), true);
    assert.equal(isPrecondition(new Error("AccessDenied")), false);
  });
});

describe("writeJobRecord", () => {
  test("data/jobs/{jobId}.json 에 마지막 상태를 no-cache 로 쓴다", async () => {
    const store = fakeStore();
    const msg = { v: 1, type: "job", jobId: "j1", month: "202610", state: "running", done: 3, total: 25, gu: "용산구", ts: NOW };
    await writeJobRecord(store, msg);
    assert.deepEqual(store.json("data/jobs/j1.json"), msg);
    assert.equal(store.puts[0].opts.cacheControl, "no-cache");
  });
});

describe("mergeIndex", () => {
  const GEN_OLD = "2026-11-17T07:00:00.000Z";
  const GEN_NEW = "2026-11-17T09:30:00.000Z";
  const monthData = (month, gen) => GU_ORDER.map((gu) =>
    aggregateRows(gu === "강남구" ? [row({ CTRT_DAY: `${month}05`, THING_AMT: "250000", ARCH_AREA: 100 })] : [], { month, gu, generatedAt: gen }));
  const existing = () => buildIndex([monthData("202611", GEN_OLD), monthData("202609", GEN_OLD)], { months: ["202609", "202611"], generatedAt: GEN_OLD });

  test("기존 index 가 없으면 그 달 하나짜리 새 index (buildIndex 와 같음)", () => {
    const out = mergeIndex(null, monthData("202610", GEN_NEW), { month: "202610", generatedAt: GEN_NEW });
    assert.deepEqual(out, buildIndex([monthData("202610", GEN_NEW)], { months: ["202610"], generatedAt: GEN_NEW }));
  });

  test("months 에 추가하고 정렬, summary[month] 교체, 다른 달 유지, generatedAt 갱신", () => {
    const before = existing();
    const out = mergeIndex(before, monthData("202610", GEN_NEW), { month: "202610", generatedAt: GEN_NEW });
    assert.deepEqual(out.months, ["202609", "202610", "202611"]);
    assert.equal(out.generatedAt, GEN_NEW);
    assert.equal(out.v, 1);
    assert.equal(out.source, SOURCE);
    assert.deepEqual(out.gus, GU_ORDER);
    assert.deepEqual(out.summary["202609"], before.summary["202609"]);
    assert.deepEqual(out.summary["202611"], before.summary["202611"]);
    assert.deepEqual(Object.keys(out.summary), ["202609", "202610", "202611"]);
    assert.deepEqual(Object.keys(out.summary["202610"]), GU_ORDER);
    assert.equal(out.summary["202610"]["강남구"].n, 1);
    assert.equal(out.summary["202610"]["강남구"].medPerM2, 2500);
    assert.equal(out.summary["202610"]["종로구"].n, 0);
  });

  test("이미 있는 달을 다시 가져오면 중복 없이 summary 만 교체", () => {
    const before = existing();
    const again = GU_ORDER.map((gu) => aggregateRows([], { month: "202611", gu, generatedAt: GEN_NEW }));
    const out = mergeIndex(before, again, { month: "202611", generatedAt: GEN_NEW });
    assert.deepEqual(out.months, ["202609", "202611"]);
    assert.equal(out.summary["202611"]["강남구"].n, 0);
    assert.deepEqual(out.summary["202609"], before.summary["202609"]);
  });

  test("기존 index 는 바꾸지 않는다", () => {
    const before = existing();
    const snapshot = JSON.stringify(before);
    mergeIndex(before, monthData("202610", GEN_NEW), { month: "202610", generatedAt: GEN_NEW });
    assert.equal(JSON.stringify(before), snapshot);
  });

  test("형식이 깨진 기존 index 는 덮어쓰지 않고 JobError", () => {
    assert.throws(() => mergeIndex({ v: 2 }, monthData("202610", GEN_NEW), { month: "202610", generatedAt: GEN_NEW }), JobError);
    assert.throws(() => mergeIndex({ v: 1, months: "202611", summary: {} }, [], { month: "202610", generatedAt: GEN_NEW }), JobError);
  });
});

describe("rebuildIndexFromStore: S3 의 data/YYYYMM/{gu}.json 으로 index 를 다시 만든다", () => {
  const GEN = "2026-11-17T10:00:00.000Z";
  const g = (month, gu, rows) => aggregateRows(rows, { month, gu, generatedAt: "2026-11-01T00:00:00.000Z" });
  const quiet = () => {};
  function seeded() {
    const init = {};
    for (const gu of GU_ORDER) init[`data/202611/${gu}.json`] = g("202611", gu, gu === "강남구" ? [row({ THING_AMT: "250000", ARCH_AREA: 100 })] : []);
    init["data/202609/서초구.json"] = g("202609", "서초구", [row({ CGG_NM: "서초구", THING_AMT: "120000", ARCH_AREA: 60 }), row({ CGG_NM: "서초구", THING_AMT: "80000", ARCH_AREA: 40 })]);
    init["data/jobs/lock.json"] = { v: 1, jobId: "x", ts: 0, released: true };
    init["data/jobs/job-1.json"] = { v: 1, type: "job" };
    init["data/202610/narration.json"] = { v: 1 }; // 구 파일이 없는 달은 빼야 한다
    init["data/notamonth/강남구.json"] = g("202611", "강남구", []);
    init["data/202611/없는구.json"] = { total: { n: 99 } };
    init[INDEX_KEY] = { v: 1, generatedAt: "old", source: "서울 열린데이터광장 부동산 실거래가(tbLnOpendataRtmsV)", months: ["202611"], gus: GU_ORDER, summary: {} };
    return init;
  }

  test("두 달: months 오름차순, 구별 total, 빠진 구는 빈 Stat (buildIndex 와 같음)", async () => {
    const store = fakeStore(seeded());
    const out = await rebuildIndexFromStore(store, { generatedAt: GEN, log: quiet });
    assert.deepEqual(out.months, ["202609", "202611"]);
    const expected = buildIndex(
      [[g("202609", "서초구", [row({ CGG_NM: "서초구", THING_AMT: "120000", ARCH_AREA: 60 }), row({ CGG_NM: "서초구", THING_AMT: "80000", ARCH_AREA: 40 })])],
       GU_ORDER.map((gu) => g("202611", gu, gu === "강남구" ? [row({ THING_AMT: "250000", ARCH_AREA: 100 })] : []))],
      { months: ["202609", "202611"], generatedAt: GEN },
    );
    assert.deepEqual(out, expected);
    assert.equal(out.summary["202609"]["서초구"].n, 2);
    assert.deepEqual(out.summary["202609"]["강남구"], { n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null, truncated: false });
    assert.equal(out.summary["202611"]["강남구"].medPerM2, 2500);
    assert.equal(out.generatedAt, GEN);
  });

  test("기존 index 의 source 문자열을 지킨다", async () => {
    const init = seeded();
    init[INDEX_KEY] = { ...init[INDEX_KEY], source: "직접 쓴 출처" };
    const out = await rebuildIndexFromStore(fakeStore(init), { generatedAt: GEN, log: quiet });
    assert.equal(out.source, "직접 쓴 출처");
    const noIndex = seeded();
    delete noIndex[INDEX_KEY];
    assert.equal((await rebuildIndexFromStore(fakeStore(noIndex), { generatedAt: GEN, log: quiet })).source, SOURCE);
  });

  test("깨진 구 파일은 빈 Stat 으로 두고 경고, 그 달에 읽을 수 있는 구 파일이 없으면 달을 뺀다", async () => {
    const init = seeded();
    init["data/202611/중구.json"] = "{broken";
    init["data/202608/강남구.json"] = "{broken";
    const warns = [];
    const out = await rebuildIndexFromStore(fakeStore(init), { generatedAt: GEN, log: (lv, msg, f) => warns.push({ lv, msg, f }) });
    assert.deepEqual(out.months, ["202609", "202611"]);
    assert.equal(out.summary["202611"]["중구"].n, 0);
    assert.ok(warns.filter((w) => w.lv === "warn").length >= 2);
  });

  test("구 파일이 하나도 없으면 null (호출자가 index 를 덮어쓰지 않게)", async () => {
    const store = fakeStore({ [INDEX_KEY]: { v: 1, months: ["202611"] }, "data/jobs/lock.json": {} });
    assert.equal(await rebuildIndexFromStore(store, { generatedAt: GEN, log: quiet }), null);
  });
});

describe("mapPool", () => {
  test("결과 순서 유지, 동시 실행 상한", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5 - x));
      live--;
      return x * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
    assert.equal(peak, 2);
  });

  test("실패하면 새 항목을 시작하지 않고 첫 오류를 던진다", async () => {
    const started = [];
    await assert.rejects(mapPool([1, 2, 3, 4], 1, async (x) => { started.push(x); if (x === 2) throw new Error("boom"); return x; }), /boom/);
    assert.deepEqual(started, [1, 2]);
  });
});
