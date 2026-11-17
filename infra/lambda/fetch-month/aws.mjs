// 런타임 기본 I/O: Node.js 22 Lambda 런타임에 내장된 AWS SDK v3(S3, SSM, CloudFront, Lambda, Bedrock Runtime)와 global fetch 만 쓴다(npm 의존성 없음).
// 각 어댑터는 client 와 명령 클래스를 받으므로 SDK 없이 테스트할 수 있다(aws.test.mjs).
import { randomUUID } from "node:crypto";
import { PreconditionFailed, isPrecondition } from "./job.mjs";
import { createPublisher } from "./publish.mjs";

/** S3 저장소: get(key) → {text, etag} | null, put(key, text, opts) → {etag}, list(prefix) → 키 배열. 조건 불일치는 PreconditionFailed. */
export function s3Store({ client, bucket, GetObjectCommand, PutObjectCommand, ListObjectsV2Command }) {
  return {
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const input = { Bucket: bucket, Prefix: prefix };
        if (token) input.ContinuationToken = token;
        const r = await client.send(new ListObjectsV2Command(input));
        for (const o of r.Contents ?? []) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { text: await r.Body.transformToString("utf-8"), etag: r.ETag };
      } catch (e) {
        if (e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async put(key, text, { contentType, cacheControl, ifMatch, ifNoneMatch } = {}) {
      const input = { Bucket: bucket, Key: key, Body: text };
      if (contentType) input.ContentType = contentType;
      if (cacheControl) input.CacheControl = cacheControl;
      if (ifMatch !== undefined) input.IfMatch = ifMatch;
      if (ifNoneMatch !== undefined) input.IfNoneMatch = ifNoneMatch;
      try {
        const r = await client.send(new PutObjectCommand(input));
        return { etag: r.ETag };
      } catch (e) {
        if (isPrecondition(e)) throw new PreconditionFailed();
        throw e;
      }
    },
  };
}

/** SSM SecureString 값을 복호화해 읽는다. 빈 값은 오류. */
export function ssmGetter({ client, GetParameterCommand }) {
  return async function getParameter(name) {
    const r = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = typeof r?.Parameter?.Value === "string" ? r.Parameter.Value.trim() : "";
    if (value === "") throw new Error("SSM 파라미터 값이 비어 있음");
    return value;
  };
}

export function cloudFrontInvalidator({ client, CreateInvalidationCommand }) {
  return async function invalidate({ distributionId, paths, callerReference }) {
    await client.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: paths.length, Items: [...paths] } },
    }));
  };
}

/** 비동기(Event) 호출. Lambda 는 받아들이면 202 를 준다. */
export function lambdaInvoker({ client, InvokeCommand }) {
  return async function invoke({ functionName, payload }) {
    const r = await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    if (r?.StatusCode !== 202) throw new Error(`Lambda 비동기 호출이 받아들여지지 않음 (StatusCode ${r?.StatusCode})`);
  };
}

/** Bedrock Converse 한 번 → { text, stopReason }. 텍스트 조각은 이어 붙인다. temperature 는 넣지 않는다(모델별 제약을 피한다). */
export function bedrockConverser({ client, ConverseCommand, timeoutMs = 60_000 }) {
  return async function converse({ modelId, system, prompt, maxTokens }) {
    const r = await client.send(new ConverseCommand({
      modelId,
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens },
    }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    return { text: (r?.output?.message?.content ?? []).map((part) => part?.text ?? "").join(""), stopReason: r?.stopReason };
  };
}

/** 서버 쪽 임의 비밀(SecretString)을 읽는다. 값은 오류 메시지에 넣지 않는다. */
export function authSecretGetter({ client, GetSecretValueCommand }) {
  return async function getAuthSecret(secretId) {
    const r = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const value = typeof r?.SecretString === "string" ? r.SecretString : "";
    if (value === "") throw new Error("인증 비밀이 비어 있음");
    return value;
  };
}

function jsonLog(level, msg, fields = {}) {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** 환경 변수(CONTRACTS 10.6)로 런타임 의존성을 만든다. importModule 은 테스트용. */
export async function makeDefaultDeps(env, { importModule = (name) => import(name) } = {}) {
  const [s3, ssm, cloudfront, lambda] = await Promise.all([
    importModule("@aws-sdk/client-s3"),
    importModule("@aws-sdk/client-ssm"),
    importModule("@aws-sdk/client-cloudfront"),
    importModule("@aws-sdk/client-lambda"),
  ]);
  const fetch = globalThis.fetch;
  // Bedrock 런타임은 해설을 만들 때(작업자)만 불러온다. API 함수는 쓰지 않는다.
  let converser = null;
  const converse = async (args) => {
    if (!converser) {
      const br = await importModule("@aws-sdk/client-bedrock-runtime");
      converser = bedrockConverser({ client: new br.BedrockRuntimeClient({}), ConverseCommand: br.ConverseCommand });
    }
    return converser(args);
  };
  // 암호 시도 셈의 HMAC 비밀은 API 함수만 쓴다. 첫 사용 때 클라이언트를 불러온다(값 캐시는 index.mjs).
  let secretGetter = null;
  const getAuthSecret = async (arn) => {
    if (!secretGetter) {
      const sm = await importModule("@aws-sdk/client-secrets-manager");
      secretGetter = authSecretGetter({ client: new sm.SecretsManagerClient({}), GetSecretValueCommand: sm.GetSecretValueCommand });
    }
    return secretGetter(arn);
  };
  const s3Client = new s3.S3Client({});
  const s3Commands = { GetObjectCommand: s3.GetObjectCommand, PutObjectCommand: s3.PutObjectCommand, ListObjectsV2Command: s3.ListObjectsV2Command };
  return {
    env,
    fetch,
    store: s3Store({ client: s3Client, bucket: env.BUCKET, ...s3Commands }),
    // 비공개 인증 상태 버킷(암호 시도 셈). API 함수에만 AUTH_BUCKET 이 있다.
    authStore: env.AUTH_BUCKET ? s3Store({ client: s3Client, bucket: env.AUTH_BUCKET, ...s3Commands }) : null,
    getAuthSecret,
    getParameter: ssmGetter({ client: new ssm.SSMClient({}), GetParameterCommand: ssm.GetParameterCommand }),
    invalidate: cloudFrontInvalidator({ client: new cloudfront.CloudFrontClient({}), CreateInvalidationCommand: cloudfront.CreateInvalidationCommand }),
    invoke: lambdaInvoker({ client: new lambda.LambdaClient({}), InvokeCommand: lambda.InvokeCommand }),
    publish: createPublisher({ fetch, endpoint: env.EVENTS_HTTP_ENDPOINT, apiKey: env.EVENTS_API_KEY }),
    converse,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomId: () => randomUUID(),
    log: jsonLog,
    concurrency: 4,
  };
}
