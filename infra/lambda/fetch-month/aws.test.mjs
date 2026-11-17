import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { s3Store, ssmGetter, cloudFrontInvalidator, lambdaInvoker, bedrockConverser, authSecretGetter, makeDefaultDeps } from "./aws.mjs";
import { PreconditionFailed } from "./job.mjs";

// SDK 명령 클래스 대역: 입력을 그대로 들고 있다.
const command = (name) => class { constructor(input) { this.name = name; this.input = input; } };
const fakeClient = (reply) => {
  const sent = [];
  return { sent, send: async (cmd) => { sent.push(cmd); return reply(cmd); } };
};
const sdkError = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe("s3Store", () => {
  const C = { GetObjectCommand: command("Get"), PutObjectCommand: command("Put"), ListObjectsV2Command: command("List") };

  test("get: 본문 문자열과 ETag", async () => {
    const client = fakeClient(() => ({ ETag: '"e1"', Body: { transformToString: async (enc) => (enc === "utf-8" ? '{"a":1}' : "?") } }));
    const store = s3Store({ client, bucket: "b", ...C });
    assert.deepEqual(await store.get("data/index.json"), { text: '{"a":1}', etag: '"e1"' });
    assert.deepEqual(client.sent[0].input, { Bucket: "b", Key: "data/index.json" });
  });

  test("get: NoSuchKey / 404 는 null, 그 밖의 오류는 그대로", async () => {
    for (const e of [sdkError("NoSuchKey", 404), sdkError("NotFound", 404)]) {
      const store = s3Store({ client: fakeClient(() => { throw e; }), bucket: "b", ...C });
      assert.equal(await store.get("k"), null);
    }
    const denied = s3Store({ client: fakeClient(() => { throw sdkError("AccessDenied", 403); }), bucket: "b", ...C });
    await assert.rejects(denied.get("k"), /AccessDenied/);
  });

  test("put: ContentType, CacheControl, IfMatch, IfNoneMatch 를 넘긴다", async () => {
    const client = fakeClient(() => ({ ETag: '"e2"' }));
    const store = s3Store({ client, bucket: "b", ...C });
    const out = await store.put("data/jobs/lock.json", "{}", { contentType: "application/json; charset=utf-8", cacheControl: "no-cache", ifNoneMatch: "*" });
    assert.deepEqual(out, { etag: '"e2"' });
    assert.deepEqual(client.sent[0].input, {
      Bucket: "b", Key: "data/jobs/lock.json", Body: "{}", ContentType: "application/json; charset=utf-8", CacheControl: "no-cache", IfNoneMatch: "*",
    });
    await store.put("k", "x", { ifMatch: '"e1"' });
    assert.equal(client.sent[1].input.IfMatch, '"e1"');
    assert.equal("IfNoneMatch" in client.sent[1].input, false);
  });

  test("put: 412 / 409 는 PreconditionFailed", async () => {
    for (const e of [sdkError("PreconditionFailed", 412), sdkError("ConditionalRequestConflict", 409)]) {
      const store = s3Store({ client: fakeClient(() => { throw e; }), bucket: "b", ...C });
      await assert.rejects(store.put("k", "x", { ifNoneMatch: "*" }), PreconditionFailed);
    }
  });
});

test("s3Store.list: ListObjectsV2 를 ContinuationToken 으로 끝까지 넘긴다", async () => {
  const pages = [
    { Contents: [{ Key: "data/a.json" }, { Key: "data/b.json" }], IsTruncated: true, NextContinuationToken: "t1" },
    { Contents: [{ Key: "data/c.json" }], IsTruncated: false },
  ];
  const client = fakeClient(() => pages.shift());
  const store = s3Store({ client, bucket: "b", GetObjectCommand: command("Get"), PutObjectCommand: command("Put"), ListObjectsV2Command: command("List") });
  assert.deepEqual(await store.list("data/"), ["data/a.json", "data/b.json", "data/c.json"]);
  assert.deepEqual(client.sent.map((c) => c.input), [{ Bucket: "b", Prefix: "data/" }, { Bucket: "b", Prefix: "data/", ContinuationToken: "t1" }]);
});

test("ssmGetter: WithDecryption 으로 값을 읽는다", async () => {
  const client = fakeClient(() => ({ Parameter: { Value: "secret" } }));
  const get = ssmGetter({ client, GetParameterCommand: command("GetParameter") });
  assert.equal(await get("/seoul-ar/seoul-api-key"), "secret");
  assert.deepEqual(client.sent[0].input, { Name: "/seoul-ar/seoul-api-key", WithDecryption: true });
  const empty = ssmGetter({ client: fakeClient(() => ({ Parameter: { Value: "" } })), GetParameterCommand: command("G") });
  await assert.rejects(empty("/x"));
});

test("cloudFrontInvalidator: 경로 묶음", async () => {
  const client = fakeClient(() => ({}));
  const invalidate = cloudFrontInvalidator({ client, CreateInvalidationCommand: command("Inv") });
  await invalidate({ distributionId: "E1", paths: ["/data/*"], callerReference: "job-1" });
  assert.deepEqual(client.sent[0].input, {
    DistributionId: "E1",
    InvalidationBatch: { CallerReference: "job-1", Paths: { Quantity: 1, Items: ["/data/*"] } },
  });
});

test("lambdaInvoker: InvocationType Event, JSON 페이로드, 202 가 아니면 실패", async () => {
  const client = fakeClient(() => ({ StatusCode: 202 }));
  const invoke = lambdaInvoker({ client, InvokeCommand: command("Invoke") });
  await invoke({ functionName: "W", payload: { jobId: "j", month: "202610" } });
  const input = client.sent[0].input;
  assert.equal(input.FunctionName, "W");
  assert.equal(input.InvocationType, "Event");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(input.Payload)), { jobId: "j", month: "202610" });
  const bad = lambdaInvoker({ client: fakeClient(() => ({ StatusCode: 500 })), InvokeCommand: command("Invoke") });
  await assert.rejects(bad({ functionName: "W", payload: {} }));
});

test("authSecretGetter: 비밀 ARN 으로 SecretString 을 읽는다, 비어 있으면 오류", async () => {
  const client = fakeClient(() => ({ SecretString: "Rnd0mServerSideSecretForHmac32ch" }));
  const get = authSecretGetter({ client, GetSecretValueCommand: command("GetSecretValue") });
  assert.equal(await get("arn:aws:secretsmanager:us-east-1:1:secret:x"), "Rnd0mServerSideSecretForHmac32ch");
  assert.deepEqual(client.sent[0].input, { SecretId: "arn:aws:secretsmanager:us-east-1:1:secret:x" });
  const empty = authSecretGetter({ client: fakeClient(() => ({})), GetSecretValueCommand: command("G") });
  await assert.rejects(empty("arn:x"), (e) => !String(e.message).includes("Rnd0m"));
});

test("makeDefaultDeps: 인증 상태 버킷 저장소와 비밀 클라이언트(첫 사용 때만 불러옴)", async () => {
  const imported = [];
  const sent = [];
  const Client = class { async send(cmd) { sent.push(cmd); return { SecretString: "s3cr3t", ETag: '"e"' }; } };
  const anyModule = new Proxy({}, { get: (_, name) => (name === "then" ? undefined : String(name).endsWith("Client") ? Client : command(String(name))) });
  const deps = await makeDefaultDeps({ BUCKET: "site", AUTH_BUCKET: "auth-state" }, { importModule: async (n) => { imported.push(n); return anyModule; } });
  assert.equal(imported.includes("@aws-sdk/client-secrets-manager"), false);
  assert.equal(await deps.getAuthSecret("arn:x"), "s3cr3t");
  assert.equal(imported.filter((n) => n === "@aws-sdk/client-secrets-manager").length, 1);
  await deps.authStore.put("attempts/k.json", "{}", { ifNoneMatch: "*" });
  assert.equal(sent.at(-1).input.Bucket, "auth-state");
  await deps.store.put("data/x.json", "{}", {});
  assert.equal(sent.at(-1).input.Bucket, "site");
});

test("makeDefaultDeps: 런타임 내장 SDK 네 개를 불러 엮는다", async () => {
  const imported = [];
  const mod = (names) => Object.fromEntries(names.map((n) => [n, n.endsWith("Client") ? class { constructor(cfg) { this.cfg = cfg; } async send() { return {}; } } : command(n)]));
  const modules = {
    "@aws-sdk/client-s3": mod(["S3Client", "GetObjectCommand", "PutObjectCommand", "ListObjectsV2Command"]),
    "@aws-sdk/client-ssm": mod(["SSMClient", "GetParameterCommand"]),
    "@aws-sdk/client-cloudfront": mod(["CloudFrontClient", "CreateInvalidationCommand"]),
    "@aws-sdk/client-lambda": mod(["LambdaClient", "InvokeCommand"]),
  };
  const env = { BUCKET: "b", EVENTS_HTTP_ENDPOINT: "https://x/event", EVENTS_API_KEY: "da2-x" };
  const deps = await makeDefaultDeps(env, { importModule: async (n) => { imported.push(n); return modules[n]; } });
  assert.deepEqual(imported.sort(), Object.keys(modules).sort());
  for (const k of ["store", "getParameter", "invalidate", "invoke", "publish", "fetch", "now", "randomId", "log"]) {
    assert.equal(typeof deps[k] === "object" ? "object" : typeof deps[k], k === "store" ? "object" : "function", k);
  }
  assert.equal(deps.env, env);
  assert.match(deps.randomId(), /^[0-9a-f-]{36}$/);
});

test("bedrockConverser: Converse 요청 모양, 응답 텍스트 이어 붙이기, 타임아웃 signal", async () => {
  const sent = [];
  const client = { send: async (cmd, opts) => { sent.push({ cmd, opts }); return { stopReason: "end_turn", output: { message: { content: [{ text: '{"a":' }, { text: ' "b"}' }] } } }; } };
  const converse = bedrockConverser({ client, ConverseCommand: command("Converse") });
  const out = await converse({ modelId: "anthropic.claude-haiku-5-5", system: "규칙", prompt: "질문", maxTokens: 400 });
  assert.deepEqual(out, { text: '{"a": "b"}', stopReason: "end_turn" });
  assert.deepEqual(sent[0].cmd.input, {
    modelId: "anthropic.claude-haiku-5-5",
    system: [{ text: "규칙" }],
    messages: [{ role: "user", content: [{ text: "질문" }] }],
    inferenceConfig: { maxTokens: 400 },
  });
  assert.ok(sent[0].opts.abortSignal, "abortSignal");
});

test("makeDefaultDeps: Bedrock 런타임은 첫 converse 때만 불러온다(API 함수 콜드 스타트 절약)", async () => {
  const imported = [];
  const Client = class { async send() { return { output: { message: { content: [{ text: "ok" }] } } }; } };
  const anyModule = new Proxy({}, { get: (_, name) => (name === "then" ? undefined : String(name).endsWith("Client") ? Client : command(String(name))) });
  const deps = await makeDefaultDeps({ BUCKET: "b" }, { importModule: async (n) => { imported.push(n); return anyModule; } });
  assert.equal(imported.includes("@aws-sdk/client-bedrock-runtime"), false);
  assert.equal((await deps.converse({ modelId: "m", system: "s", prompt: "p", maxTokens: 10 })).text, "ok");
  assert.equal(imported.filter((n) => n === "@aws-sdk/client-bedrock-runtime").length, 1);
  await deps.converse({ modelId: "m", system: "s", prompt: "p", maxTokens: 10 });
  assert.equal(imported.filter((n) => n === "@aws-sdk/client-bedrock-runtime").length, 1);
});
