const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cdk = require("aws-cdk-lib");
const { Template, Match } = require("aws-cdk-lib/assertions");

let tmp;
let template;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seoul-ar-dist-"));
  fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>t</title>");
  // 저장소 데이터 스냅샷(frontend/public/data → dist/data). 시드 배포가 올린다.
  fs.mkdirSync(path.join(tmp, "data", "202611"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "data", "index.json"), "{}");
  fs.writeFileSync(path.join(tmp, "data", "202611", "강남구.json"), "{}");
  process.env.SEOUL_AR_DIST = tmp;
  const { SeoulArStack } = require("../lib/seoul-ar-stack");
  const app = new cdk.App();
  const stack = new SeoulArStack(app, "SeoulArStack", { env: { account: "557395122774", region: "us-east-1" } });
  template = Template.fromStack(stack);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("bucket blocks all public access", () => {
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test("one distribution with index.html root and SPA error responses", () => {
  template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: "index.html",
      CustomErrorResponses: [
        Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }),
        Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" }),
      ],
    }),
  });
});

test("AppSync Events API with API_KEY auth", () => {
  template.resourceCountIs("AWS::AppSync::Api", 1);
  const apis = Object.values(template.findResources("AWS::AppSync::Api"));
  const ec = apis[0].Properties.EventConfig;
  for (const k of ["AuthProviders", "ConnectionAuthModes", "DefaultPublishAuthModes", "DefaultSubscribeAuthModes"]) {
    assert.ok(JSON.stringify(ec[k]).includes("API_KEY"), `${k} includes API_KEY`);
  }
});

test("channel namespace seoul and one api key", () => {
  template.hasResourceProperties("AWS::AppSync::ChannelNamespace", { Name: "seoul" });
  template.resourceCountIs("AWS::AppSync::ApiKey", 1);
});

test("outputs exist", () => {
  const out = template.toJSON().Outputs;
  for (const k of ["CloudFrontUrl", "EventsHttpEndpoint", "EventsRealtimeEndpoint", "BucketName"]) {
    assert.ok(out[k], `output ${k}`);
  }
});

test("bucket deployment is configured and emits config.json source", () => {
  template.hasResourceProperties("Custom::CDKBucketDeployment", {
    Prune: true,
    DistributionPaths: ["/*"],
    SystemMetadata: Match.objectLike({ "cache-control": "no-cache" }),
  });
  const dep = Object.values(template.findResources("Custom::CDKBucketDeployment")).find((d) => d.Properties.Prune === true);
  assert.strictEqual(dep.Properties.SourceMarkers.length, 2);
  // config.json 의 배포 시점 토큰: CloudFront 도메인, Events http/realtime DNS, API 키
  const attrs = Object.values(dep.Properties.SourceMarkers[1]).map((v) => v["Fn::GetAtt"].join("."));
  assert.ok(attrs.some((a) => a.startsWith("Distribution") && a.endsWith(".DomainName")));
  assert.ok(attrs.some((a) => a.endsWith("Dns.Http")));
  assert.ok(attrs.some((a) => a.endsWith("Dns.Realtime")));
  assert.ok(attrs.some((a) => a.endsWith("ApiKey")));
  assert.deepStrictEqual(dep.Properties.SourceMarkersConfig[1], { jsonEscape: true });
});

// ---- Task 9a: 월 실시간 수집 (CONTRACTS 10.6) ----
// 한 Lambda 에 Function URL 과 DISTRIBUTION_ID 를 함께 두면
// Distribution → FunctionUrl → Function → (env DISTRIBUTION_ID) → Distribution 순환이 생긴다.
// 그래서 같은 코드(lambda/fetch-month)로 함수 둘을 만든다: API(Function URL) 와 작업자(무효화·발행).
const WORKER_NAME = "SeoulArStack-FetchMonthWorker";
// CONTRACTS 10.6 의 7개 + 12.2 의 BEDROCK_MODEL_ID
const CONTRACT_ENV = ["BUCKET", "DISTRIBUTION_ID", "EVENTS_HTTP_ENDPOINT", "EVENTS_API_KEY", "SSM_API_KEY_NAME", "SSM_PASSCODE_NAME", "SELF_FUNCTION_NAME", "BEDROCK_MODEL_ID",
  // security round: 비공개 인증 상태 버킷과 서버 쪽 HMAC 비밀
  "AUTH_BUCKET", "AUTH_SECRET_ARN"];

function fetchMonthFns() {
  const fns = Object.entries(template.findResources("AWS::Lambda::Function"));
  const worker = fns.find(([, r]) => r.Properties.FunctionName === WORKER_NAME);
  const api = fns.find(([, r]) => r.Properties.Environment?.Variables?.SELF_FUNCTION_NAME !== undefined);
  assert.ok(worker, "worker function");
  assert.ok(api, "api function");
  return { worker, api };
}

function statementsOf([, fn]) {
  const roleId = fn.Properties.Role["Fn::GetAtt"][0];
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => p.Properties.Roles.some((r) => r.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}

const actionsOf = (st) => [].concat(st.Action);
const findStatement = (sts, action) => sts.find((st) => actionsOf(st).includes(action));
const logicalId = (type) => Object.keys(template.findResources(type))[0];

test("fetch-month worker: Node.js 22, 512 MB, 600 s, worker env", () => {
  const [, w] = fetchMonthFns().worker;
  assert.equal(w.Properties.Runtime, "nodejs22.x");
  assert.equal(w.Properties.Handler, "index.handler");
  assert.equal(w.Properties.MemorySize, 512);
  assert.equal(w.Properties.Timeout, 600);
  const env = w.Properties.Environment.Variables;
  assert.deepEqual(Object.keys(env).sort(), ["BEDROCK_MODEL_ID", "BUCKET", "DISTRIBUTION_ID", "EVENTS_API_KEY", "EVENTS_HTTP_ENDPOINT", "SSM_API_KEY_NAME"]);
  // 계정에서 확인됨: 기반 모델 ID 는 on-demand 불가, us. 인퍼런스 프로파일은 된다(11a fix)
  assert.equal(env.BEDROCK_MODEL_ID, "us.anthropic.claude-haiku-5-5");
  assert.deepEqual(env.BUCKET, { Ref: logicalId("AWS::S3::Bucket") });
  assert.deepEqual(env.DISTRIBUTION_ID, { Ref: logicalId("AWS::CloudFront::Distribution") });
  assert.equal(env.SSM_API_KEY_NAME, "/seoul-ar/seoul-api-key");
  assert.ok(JSON.stringify(env.EVENTS_HTTP_ENDPOINT).includes("Dns.Http"));
  assert.ok(JSON.stringify(env.EVENTS_HTTP_ENDPOINT).includes("/event"));
  assert.deepEqual(env.EVENTS_API_KEY["Fn::GetAtt"][1], "ApiKey");
});

test("fetch-month: 예약 동시성 없음(누구나 채워 발표자를 굶길 수 있으므로. IP 별 원자적 셈에 맡긴다)", () => {
  assert.equal(fetchMonthFns().api[1].Properties.ReservedConcurrentExecutions, undefined);
  assert.equal(fetchMonthFns().worker[1].Properties.ReservedConcurrentExecutions, undefined);
});

test("fetch-month api: Node.js 22, env, SELF_FUNCTION_NAME 은 작업자 이름(리터럴, 순환 없음)", () => {
  const [, a] = fetchMonthFns().api;
  assert.equal(a.Properties.Runtime, "nodejs22.x");
  assert.equal(a.Properties.Handler, "index.handler");
  const env = a.Properties.Environment.Variables;
  assert.deepEqual(Object.keys(env).sort(), ["AUTH_BUCKET", "AUTH_SECRET_ARN", "BUCKET", "SELF_FUNCTION_NAME", "SSM_PASSCODE_NAME"]);
  assert.equal(env.SELF_FUNCTION_NAME, WORKER_NAME);
  assert.equal(env.SSM_PASSCODE_NAME, "/seoul-ar/presenter-passcode");
  assert.deepEqual(env.BUCKET, { Ref: logicalId("AWS::S3::Bucket") });
  assert.deepEqual(env.AUTH_BUCKET, { Ref: authBucketId() });
  assert.deepEqual(env.AUTH_SECRET_ARN, { Ref: logicalId("AWS::SecretsManager::Secret") });
});

// ---- security round: 비공개 인증 상태 버킷 + 서버 쪽 임의 HMAC 비밀 ----
function authBucketId() {
  const id = Object.keys(template.findResources("AWS::S3::Bucket")).find((k) => k.startsWith("AuthStateBucket"));
  assert.ok(id, "AuthStateBucket");
  return id;
}

test("사이트 버킷은 첫 번째 버킷(logicalId 도우미가 가리키는 것)", () => {
  assert.ok(logicalId("AWS::S3::Bucket").startsWith("SiteBucket"));
});

test("AuthStateBucket: 공개 차단, SSE-S3, SSL 강제, 1일 뒤 만료, 삭제 시 비움", () => {
  const R = template.toJSON().Resources;
  const id = authBucketId();
  const b = R[id];
  assert.deepEqual(b.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.deepEqual(b.Properties.BucketEncryption.ServerSideEncryptionConfiguration, [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }]);
  assert.deepEqual(b.Properties.LifecycleConfiguration.Rules.map((r) => ({ d: r.ExpirationInDays, s: r.Status })), [{ d: 1, s: "Enabled" }]);
  assert.equal(b.DeletionPolicy, "Delete");
  const policy = Object.values(R).find((r) => r.Type === "AWS::S3::BucketPolicy" && r.Properties.Bucket.Ref === id);
  assert.ok(policy, "버킷 정책");
  const ssl = policy.Properties.PolicyDocument.Statement.find((st) => st.Effect === "Deny" && st.Condition?.Bool?.["aws:SecureTransport"] === "false");
  assert.ok(ssl, "SSL 강제");
  assert.ok(Object.values(R).some((r) => r.Type === "Custom::S3AutoDeleteObjects" && r.Properties.BucketName.Ref === id), "autoDeleteObjects");
  // CloudFront 오리진이 아니다(공개 경로 없음)
  const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0].Properties.DistributionConfig;
  assert.ok(!JSON.stringify(dist.Origins).includes(id));
});

test("IAM API: 인증 상태 버킷 Get/Put 만, 작업자는 그 버킷에 권한 없음", () => {
  const id = authBucketId();
  const apiSts = statementsOf(fetchMonthFns().api).filter((st) => JSON.stringify(st.Resource).includes(`"${id}"`));
  assert.equal(apiSts.length, 1);
  assert.equal(apiSts[0].Effect, "Allow");
  assert.deepEqual(actionsOf(apiSts[0]).sort(), ["s3:GetObject", "s3:PutObject"]);
  assert.deepEqual(apiSts[0].Resource, { "Fn::Join": ["", [{ "Fn::GetAtt": [id, "Arn"] }, "/*"]] });
  assert.equal(statementsOf(fetchMonthFns().worker).filter((st) => JSON.stringify(st.Resource).includes(`"${id}"`)).length, 0);
});

test("IAM API: 사이트 버킷의 data/jobs/_auth 는 명시적으로 거부, 허용 문 어디에도 _auth 없음", () => {
  const sts = statementsOf(fetchMonthFns().api);
  assert.ok(sts.filter((st) => st.Effect !== "Deny").every((st) => !JSON.stringify(st.Resource).includes("_auth")));
  const deny = sts.find((st) => st.Effect === "Deny");
  assert.ok(deny, "Deny 문");
  assert.deepEqual(actionsOf(deny).sort(), ["s3:GetObject", "s3:PutObject"]);
  assert.deepEqual(deny.Resource, { "Fn::Join": ["", [{ "Fn::GetAtt": [logicalId("AWS::S3::Bucket"), "Arn"] }, "/data/jobs/_auth/*"]] });
});

test("HMAC 비밀: Secrets Manager 임의 값(32자, 구두점 없음), API 역할만 GetSecretValue(그 비밀 하나)", () => {
  template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  const [id, secret] = Object.entries(template.findResources("AWS::SecretsManager::Secret"))[0];
  assert.equal(secret.Properties.GenerateSecretString.ExcludePunctuation, true);
  assert.equal(secret.Properties.GenerateSecretString.PasswordLength, 32);
  assert.equal(secret.Properties.SecretString, undefined, "값을 템플릿에 넣지 않는다");
  const apiSm = statementsOf(fetchMonthFns().api).filter((st) => actionsOf(st).some((a) => a.startsWith("secretsmanager:")));
  assert.equal(apiSm.length, 1);
  assert.deepEqual(actionsOf(apiSm[0]), ["secretsmanager:GetSecretValue"]);
  assert.deepEqual(apiSm[0].Resource, { Ref: id });
  assert.equal(statementsOf(fetchMonthFns().worker).filter((st) => actionsOf(st).some((a) => a.startsWith("secretsmanager:"))).length, 0);
  // 다른 어떤 정책도 이 비밀을 가리키지 않는다
  const others = Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p) => !p.Properties.Roles.some((r) => r.Ref === fetchMonthFns().api[1].Properties.Role["Fn::GetAtt"][0]))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  assert.ok(others.every((st) => !JSON.stringify(st.Resource).includes(`"${id}"`)));
});

test("fetch-month: 두 함수의 env 이름을 합치면 계약의 7개와 같고, 같은 코드 자산을 쓴다", () => {
  const { worker, api } = fetchMonthFns();
  const names = new Set([...Object.keys(worker[1].Properties.Environment.Variables), ...Object.keys(api[1].Properties.Environment.Variables)]);
  assert.deepEqual([...names].sort(), [...CONTRACT_ENV].sort());
  assert.deepEqual(worker[1].Properties.Code, api[1].Properties.Code);
});

test("fetch-month worker: 비동기 재시도 0 (시간 초과 뒤 같은 작업이 다시 돌지 않게)", () => {
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    FunctionName: { Ref: fetchMonthFns().worker[0] },
    MaximumRetryAttempts: 0,
  });
});

test("fetch-month: 로그 그룹 보존 14일", () => {
  const { worker, api } = fetchMonthFns();
  for (const [, fn] of [worker, api]) {
    const lgId = fn.Properties.LoggingConfig.LogGroup.Ref;
    assert.equal(template.toJSON().Resources[lgId].Properties.RetentionInDays, 14);
  }
});

test("Function URL: API 함수, AuthType AWS_IAM, 이 배포의 CloudFront(OAC)만 호출 가능 (9a fix S1)", () => {
  const [apiId] = fetchMonthFns().api;
  template.resourceCountIs("AWS::Lambda::Url", 1);
  template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM", TargetFunctionArn: { "Fn::GetAtt": [apiId, "Arn"] } });
  const perms = Object.values(template.findResources("AWS::Lambda::Permission"));
  assert.ok(perms.length >= 1);
  assert.ok(perms.every((p) => p.Properties.Principal !== "*"), "공개 권한 없음");
  const distId = logicalId("AWS::CloudFront::Distribution");
  const urlPerm = perms.find((p) => p.Properties.Action === "lambda:InvokeFunctionUrl");
  assert.equal(urlPerm.Properties.Principal, "cloudfront.amazonaws.com");
  assert.ok(JSON.stringify(urlPerm.Properties.SourceArn).includes(`{"Ref":"${distId}"}`), "SourceArn = 이 배포");
  assert.deepEqual(urlPerm.Properties.FunctionName, { "Fn::GetAtt": [logicalId("AWS::Lambda::Url"), "FunctionArn"] });
  const fnPerm = perms.find((p) => p.Properties.Action === "lambda:InvokeFunction");
  assert.ok(fnPerm, "OAC 는 lambda:InvokeFunction 도 필요");
  assert.equal(fnPerm.Properties.InvokedViaFunctionUrl, true);
  for (const p of perms) {
    assert.equal(p.Properties.Principal, "cloudfront.amazonaws.com");
    assert.ok(JSON.stringify(p.Properties.SourceArn).includes(`{"Ref":"${distId}"}`));
  }
});

test("CloudFront /api/* 오리진은 Lambda 용 OAC 로 서명한다 (sigv4, always)", () => {
  const oacs = Object.entries(template.findResources("AWS::CloudFront::OriginAccessControl"));
  const lambdaOac = oacs.find(([, r]) => r.Properties.OriginAccessControlConfig.OriginAccessControlOriginType === "lambda");
  assert.ok(lambdaOac, "lambda OAC");
  assert.equal(lambdaOac[1].Properties.OriginAccessControlConfig.SigningBehavior, "always");
  assert.equal(lambdaOac[1].Properties.OriginAccessControlConfig.SigningProtocol, "sigv4");
  const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0].Properties.DistributionConfig;
  const cb = dist.CacheBehaviors.find((x) => x.PathPattern === "/api/*");
  const origin = dist.Origins.find((o) => o.Id === cb.TargetOriginId);
  assert.deepEqual(origin.OriginAccessControlId, { "Fn::GetAtt": [lambdaOac[0], "Id"] });
});

test("fetch-month worker: 비동기 이벤트는 5분 안에 시작 못 하면 버린다 (maxEventAge)", () => {
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    FunctionName: { Ref: fetchMonthFns().worker[0] },
    MaximumEventAgeInSeconds: 300,
  });
});

test("CloudFront /api/* → Function URL 오리진, 캐시 끔, ALL_VIEWER_EXCEPT_HOST_HEADER, 메서드 전부, HTTPS 리다이렉트", () => {
  const dist = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0].Properties.DistributionConfig;
  const cb = dist.CacheBehaviors.find((b) => b.PathPattern === "/api/*");
  assert.ok(cb, "/api/* behavior");
  assert.deepEqual([...cb.AllowedMethods].sort(), ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
  assert.equal(cb.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // Managed-CachingDisabled
  assert.equal(cb.OriginRequestPolicyId, "b689b0a8-53d0-40ab-baf2-68738e2966ac"); // Managed-AllViewerExceptHostHeader
  assert.equal(cb.ViewerProtocolPolicy, "redirect-to-https");
  const origin = dist.Origins.find((o) => o.Id === cb.TargetOriginId);
  const urlId = logicalId("AWS::Lambda::Url");
  assert.ok(JSON.stringify(origin.DomainName).includes(`"${urlId}","FunctionUrl"`), "Function URL 도메인");
  assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, "https-only");
  // 기본 동작(정적 사이트)은 그대로
  assert.deepEqual(dist.DefaultCacheBehavior.AllowedMethods, ["GET", "HEAD"]);
});

test("IAM 작업자: data/* Get/Put, 이 배포 무효화, API 키 파라미터 + kms:Decrypt(ssm 경유)", () => {
  const sts = statementsOf(fetchMonthFns().worker);
  const bucketId = logicalId("AWS::S3::Bucket");
  const s3 = findStatement(sts, "s3:PutObject");
  assert.deepEqual(actionsOf(s3).sort(), ["s3:GetObject", "s3:PutObject"]);
  assert.deepEqual(s3.Resource, { "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/data/*"]] });
  const cf = findStatement(sts, "cloudfront:CreateInvalidation");
  assert.deepEqual(actionsOf(cf), ["cloudfront:CreateInvalidation"]);
  const cfArn = JSON.stringify(cf.Resource);
  assert.ok(cfArn.includes(":cloudfront::557395122774:distribution/"), cfArn);
  assert.ok(cfArn.includes(`{"Ref":"${logicalId("AWS::CloudFront::Distribution")}"}`), cfArn);
  const ssm = findStatement(sts, "ssm:GetParameter");
  assert.deepEqual(actionsOf(ssm), ["ssm:GetParameter"]);
  assert.ok(JSON.stringify(ssm.Resource).includes(":ssm:us-east-1:557395122774:parameter/seoul-ar/seoul-api-key"));
  assert.ok(!JSON.stringify(ssm.Resource).includes("presenter-passcode"));
  const kms = findStatement(sts, "kms:Decrypt");
  assert.deepEqual(actionsOf(kms), ["kms:Decrypt"]);
  assert.deepEqual(kms.Condition, { StringEquals: { "kms:ViaService": "ssm.us-east-1.amazonaws.com" } });
  assert.equal(findStatement(sts, "lambda:InvokeFunction"), undefined);
});

test("IAM API: data/jobs/* Get/Put, 암호 파라미터 + kms:Decrypt, 작업자 lambda:InvokeFunction 만", () => {
  const sts = statementsOf(fetchMonthFns().api);
  const s3 = findStatement(sts, "s3:PutObject");
  assert.deepEqual(actionsOf(s3).sort(), ["s3:GetObject", "s3:PutObject"]);
  assert.deepEqual(s3.Resource, { "Fn::Join": ["", [{ "Fn::GetAtt": [logicalId("AWS::S3::Bucket"), "Arn"] }, "/data/jobs/*"]] });
  const ssm = findStatement(sts, "ssm:GetParameter");
  assert.ok(JSON.stringify(ssm.Resource).includes(":parameter/seoul-ar/presenter-passcode"));
  assert.ok(!JSON.stringify(ssm.Resource).includes("seoul-api-key"));
  assert.ok(findStatement(sts, "kms:Decrypt"));
  const inv = findStatement(sts, "lambda:InvokeFunction");
  assert.deepEqual(actionsOf(inv), ["lambda:InvokeFunction"]);
  assert.ok(JSON.stringify(inv.Resource).includes(`:lambda:us-east-1:557395122774:function:${WORKER_NAME}"`), JSON.stringify(inv.Resource));
  assert.equal(findStatement(sts, "cloudfront:CreateInvalidation"), undefined);
});

test("IAM fetch-month: 와일드카드 동작·삭제 권한 없음", () => {
  const { worker, api } = fetchMonthFns();
  for (const st of [...statementsOf(worker), ...statementsOf(api)]) {
    for (const a of actionsOf(st)) {
      assert.ok(!a.includes("*"), `wildcard action ${a}`);
      assert.ok(!/Delete/.test(a), `delete action ${a}`);
    }
    if (actionsOf(st).some((a) => a.startsWith("s3:") || a.startsWith("ssm:") || a.startsWith("lambda:") || a.startsWith("cloudfront:"))) {
      assert.notEqual(st.Resource, "*", JSON.stringify(st));
    }
  }
});

test("SSM 파라미터는 이름으로만 참조하고 만들지 않는다", () => {
  template.resourceCountIs("AWS::SSM::Parameter", 0);
  const json = JSON.stringify(template.toJSON());
  assert.ok(json.includes("/seoul-ar/seoul-api-key"));
  assert.ok(json.includes("/seoul-ar/presenter-passcode"));
  assert.ok(!json.includes("SecureString"));
  assert.ok(!json.includes("resolve:ssm"));
});

test("출력 FetchMonthUrl = CloudFront 도메인 + /api/fetch-month", () => {
  const out = template.toJSON().Outputs.FetchMonthUrl;
  assert.ok(out, "FetchMonthUrl");
  const v = JSON.stringify(out.Value);
  assert.ok(v.includes("DomainName") && v.includes("/api/fetch-month"), v);
});

test("템플릿 리소스 의존 그래프에 순환이 없다 (Ref, GetAtt, Sub, DependsOn)", () => {
  const R = template.toJSON().Resources;
  const edges = {};
  const collect = (v, out) => {
    if (Array.isArray(v)) return v.forEach((x) => collect(x, out));
    if (!v || typeof v !== "object") return;
    if (typeof v.Ref === "string" && R[v.Ref]) out.add(v.Ref);
    if (Array.isArray(v["Fn::GetAtt"]) && R[v["Fn::GetAtt"][0]]) out.add(v["Fn::GetAtt"][0]);
    if (typeof v["Fn::GetAtt"] === "string" && R[v["Fn::GetAtt"].split(".")[0]]) out.add(v["Fn::GetAtt"].split(".")[0]);
    const sub = v["Fn::Sub"];
    const subText = typeof sub === "string" ? sub : Array.isArray(sub) ? sub[0] : null;
    if (subText) for (const [, name] of subText.matchAll(/\$\{([^}.!]+)/g)) if (R[name]) out.add(name);
    Object.values(v).forEach((x) => collect(x, out));
  };
  for (const [id, r] of Object.entries(R)) {
    const s = new Set();
    collect(r.Properties, s);
    [].concat(r.DependsOn ?? []).forEach((d) => s.add(d));
    edges[id] = [...s];
  }
  const state = {};
  const visit = (n, trail) => {
    state[n] = 1;
    for (const m of edges[n] ?? []) {
      if (state[m] === 1) assert.fail(`cycle: ${[...trail, n, m].join(" -> ")}`);
      if (!state[m]) visit(m, [...trail, n]);
    }
    state[n] = 2;
  };
  for (const n of Object.keys(R)) if (!state[n]) visit(n, []);
});

// ---- 재배포가 Lambda 가 쓴 data/ 를 지우지 않게 (Task 9a 추가) ----
const deployments = () => Object.entries(template.findResources("Custom::CDKBucketDeployment"));
const siteDeployment = () => deployments().find(([, d]) => d.Properties.Prune === true);
const seedDeployment = () => deployments().find(([, d]) => d.Properties.DestinationBucketKeyPrefix === "data/");

test("사이트 배포: prune 은 그대로, data/* 는 올리지도 지우지도 않는다(exclude)", () => {
  const [, d] = siteDeployment();
  assert.deepEqual(d.Properties.Exclude, ["data/*"]);
  assert.equal(d.Properties.DestinationBucketKeyPrefix, undefined);
  assert.deepEqual(d.Properties.DistributionPaths, ["/*"]);
});

test("시드 배포: dist/data → data/ 접두사, prune false, no-cache", () => {
  assert.equal(deployments().length, 2);
  const [, d] = seedDeployment();
  assert.equal(d.Properties.Prune, false);
  assert.deepEqual(d.Properties.SystemMetadata, { "cache-control": "no-cache" });
  assert.equal(d.Properties.SourceObjectKeys.length, 1);
  assert.equal(d.Properties.Exclude, undefined);
});

test("index 재구성: 배포마다 작업자를 {action: rebuild-index} 로 호출하는 AwsCustomResource", () => {
  const crs = Object.entries(template.findResources("Custom::AWS"));
  assert.equal(crs.length, 1);
  const [id, cr] = crs[0];
  const workerId = fetchMonthFns().worker[0];
  for (const phase of ["Create", "Update"]) {
    const call = JSON.stringify(cr.Properties[phase]);
    assert.ok(call.includes('\\"service\\":\\"Lambda\\"') && call.includes('\\"action\\":\\"invoke\\"'), call);
    assert.ok(call.includes(`{"Ref":"${workerId}"}`), "FunctionName = 작업자");
    assert.ok(call.includes('\\"InvocationType\\":\\"RequestResponse\\"'), call);
    assert.ok(call.includes('rebuild-index'), call);
    assert.match(call, /\\"physicalResourceId\\":\{\\"id\\":\\"rebuild-\d+\\"\}/);
    assert.ok(call.includes('\\"outputPaths\\":[\\"StatusCode\\"]'), "응답 크기 제한");
  }
  const payload = JSON.parse(JSON.parse(cr.Properties.Create["Fn::Join"][1].join("").replace(/\{"Ref":"[^"]+"\}/g, "W")).parameters?.Payload ?? "null");
  assert.deepEqual(payload, { action: "rebuild-index" });
  assert.equal(cr.Properties.InstallLatestAwsSdk, false);
  const deps = [].concat(cr.DependsOn ?? []);
  assert.ok(deps.includes(seedDeployment()[0]), "시드 배포 뒤");
  assert.ok(deps.includes(workerId), "작업자 뒤");
  // 커스텀 리소스 정책: 작업자 lambda:InvokeFunction 만
  const policyId = deps.find((d) => d.startsWith("RebuildIndexCustomResourcePolicy"));
  assert.ok(policyId, "커스텀 리소스 전용 정책");
  const sts = template.toJSON().Resources[policyId].Properties.PolicyDocument.Statement;
  assert.deepEqual(sts.map((st) => st.Action), ["lambda:InvokeFunction"]);
  assert.deepEqual(sts[0].Resource, { "Fn::GetAtt": [workerId, "Arn"] });
  assert.ok(id);
});

test("IAM 작업자: s3:ListBucket 은 data/ 접두사로만", () => {
  const sts = statementsOf(fetchMonthFns().worker);
  const list = findStatement(sts, "s3:ListBucket");
  assert.deepEqual(actionsOf(list), ["s3:ListBucket"]);
  assert.deepEqual(list.Resource, { "Fn::GetAtt": [logicalId("AWS::S3::Bucket"), "Arn"] });
  assert.deepEqual(list.Condition, { StringLike: { "s3:prefix": ["data/", "data/*"] } });
  assert.equal(findStatement(statementsOf(fetchMonthFns().api), "s3:ListBucket"), undefined);
});

test("dist 에 data/ 가 없으면 시드 배포 없이 합성되고 재구성은 남는다", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "seoul-ar-bare-"));
  const saved = process.env.SEOUL_AR_DIST;
  try {
    process.env.SEOUL_AR_DIST = bare;
    const { SeoulArStack } = require("../lib/seoul-ar-stack");
    const t = Template.fromStack(new SeoulArStack(new cdk.App(), "Bare", { env: { account: "557395122774", region: "us-east-1" } }));
    t.resourceCountIs("Custom::CDKBucketDeployment", 1);
    t.resourceCountIs("Custom::AWS", 1);
  } finally {
    process.env.SEOUL_AR_DIST = saved;
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

// ---- Task 11: AI 해설 (CONTRACTS 12.2) ----
test("IAM 작업자: bedrock:InvokeModel 은 그 모델과 us. 인퍼런스 프로파일로만", () => {
  const sts = statementsOf(fetchMonthFns().worker);
  const br = findStatement(sts, "bedrock:InvokeModel");
  assert.deepEqual(actionsOf(br), ["bedrock:InvokeModel"]);
  const res = JSON.stringify(br.Resource);
  assert.ok(res.includes(":bedrock:*::foundation-model/anthropic.claude-haiku-5-5"), res);
  assert.ok(res.includes(":bedrock:us-east-1:557395122774:inference-profile/us.anthropic.claude-haiku-5-5"), res);
  assert.equal([].concat(br.Resource).length, 2);
  assert.ok(!res.includes("us.us."), res);
  assert.equal(findStatement(statementsOf(fetchMonthFns().api), "bedrock:InvokeModel"), undefined, "공개 함수에는 Bedrock 권한 없음");
});

test("IAM API: narrate-month 의 달 확인용 data/index.json 읽기만 추가", () => {
  const sts = statementsOf(fetchMonthFns().api);
  const reads = sts.filter((st) => actionsOf(st).includes("s3:GetObject") && !actionsOf(st).includes("s3:PutObject"));
  assert.equal(reads.length, 1);
  assert.deepEqual(actionsOf(reads[0]), ["s3:GetObject"]);
  assert.deepEqual(reads[0].Resource, { "Fn::Join": ["", [{ "Fn::GetAtt": [logicalId("AWS::S3::Bucket"), "Arn"] }, "/data/index.json"]] });
});

test("모델 ID 는 cdk 컨텍스트 bedrockModelId 로 바꿀 수 있고, 프로파일 ID 를 주면 그 프로파일과 기반 모델로 권한을 건다", () => {
  const app = new cdk.App({ context: { bedrockModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" } });
  const { SeoulArStack } = require("../lib/seoul-ar-stack");
  const t = Template.fromStack(new SeoulArStack(app, "Ctx", { env: { account: "557395122774", region: "us-east-1" } })).toJSON();
  const worker = Object.values(t.Resources).find((r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === "Ctx-FetchMonthWorker");
  assert.equal(worker.Properties.Environment.Variables.BEDROCK_MODEL_ID, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
  const res = JSON.stringify(Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy").flatMap((p) => p.Properties.PolicyDocument.Statement).find((st) => [].concat(st.Action).includes("bedrock:InvokeModel")).Resource);
  assert.ok(res.includes("foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"), res);
  assert.ok(res.includes("inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0"), res);
  assert.ok(!res.includes("us.us."), res);
});
