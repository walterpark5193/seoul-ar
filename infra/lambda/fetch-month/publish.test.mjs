import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JOBS_CHANNEL, jobMessage, createPublisher, createReporter } from "./publish.mjs";

const ENDPOINT = "https://abc.appsync-api.us-east-1.amazonaws.com/event";
const API_KEY = "da2-secretish";

describe("jobMessage (CONTRACTS 10.4 JobMessage)", () => {
  test("필수 필드와 선택 필드", () => {
    assert.deepEqual(
      jobMessage({ jobId: "j", month: "202610", state: "running", done: 3, total: 25, gu: "용산구", ts: 5 }),
      { v: 1, type: "job", jobId: "j", month: "202610", state: "running", done: 3, total: 25, gu: "용산구", ts: 5 },
    );
  });

  test("gu, message 가 없으면 키 자체를 넣지 않는다", () => {
    const m = jobMessage({ jobId: "j", month: "202610", state: "done", done: 25, total: 25, ts: 9 });
    assert.equal("gu" in m, false);
    assert.equal("message" in m, false);
  });

  test("error 는 message", () => {
    const m = jobMessage({ jobId: "j", month: "202610", state: "error", done: 2, total: 25, message: "실패했습니다.", ts: 9 });
    assert.equal(m.message, "실패했습니다.");
  });
});

describe("createPublisher (AppSync Events HTTP publish)", () => {
  test("x-api-key 로 {channel, events:[JSON 문자열]} 을 POST", async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ failed: [], successful: [{}] }) }; };
    const publish = createPublisher({ fetch, endpoint: ENDPOINT, apiKey: API_KEY });
    const msg = jobMessage({ jobId: "j", month: "202610", state: "running", done: 1, total: 25, gu: "종로구", ts: 1 });
    await publish(msg);
    assert.equal(JOBS_CHANNEL, "/seoul/jobs");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.equal(calls[0].init.headers["x-api-key"], API_KEY);
    assert.ok(calls[0].init.signal, "timeout signal");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.channel, "/seoul/jobs");
    assert.equal(body.events.length, 1);
    assert.equal(typeof body.events[0], "string");
    assert.deepEqual(JSON.parse(body.events[0]), msg);
  });

  test("HTTP 오류나 failed 항목은 예외(키·URL 없이)", async () => {
    const bad = createPublisher({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }), endpoint: ENDPOINT, apiKey: API_KEY });
    await assert.rejects(bad({}), (e) => /401/.test(e.message) && !e.message.includes(API_KEY) && !e.message.includes(ENDPOINT));
    const partial = createPublisher({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ failed: [{ code: 400 }], successful: [] }) }), endpoint: ENDPOINT, apiKey: API_KEY });
    await assert.rejects(partial({}), (e) => !e.message.includes(API_KEY));
  });

  test("네트워크 예외(URL 포함)는 원인을 버리고 감싼다", async () => {
    const pub = createPublisher({ fetch: async (url) => { throw new TypeError(`fetch failed ${url} ${API_KEY}`); }, endpoint: ENDPOINT, apiKey: API_KEY });
    await assert.rejects(pub({}), (e) => !e.message.includes(API_KEY) && !e.message.includes("appsync-api") && e.cause === undefined);
  });
});

describe("createReporter: 발행과 작업 기록을 순서대로, 실패는 삼키고 남긴다", () => {
  test("보낸 순서를 지킨다(앞 발행이 느려도)", async () => {
    const order = [];
    const publish = async (m) => { await new Promise((r) => setTimeout(r, m.done === 1 ? 20 : 0)); order.push(`p${m.done}`); };
    const record = async (m) => { order.push(`r${m.done}`); };
    const report = createReporter({ publish, record, log: () => {} });
    await Promise.all([report({ done: 1 }), report({ done: 2 })]);
    assert.deepEqual(order.filter((x) => x.startsWith("p")), ["p1", "p2"]);
    assert.deepEqual(order.filter((x) => x.startsWith("r")), ["r1", "r2"]);
  });

  test("발행 실패는 로그만 남기고 기록은 계속", async () => {
    const logs = [];
    const recorded = [];
    const report = createReporter({
      publish: async () => { throw new Error("AppSync 발행 실패 (HTTP 500)"); },
      record: async (m) => recorded.push(m),
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
    await report({ done: 1 });
    assert.equal(recorded.length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "warn");
  });
});
