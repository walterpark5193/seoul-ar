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
  const dep = Object.values(template.findResources("Custom::CDKBucketDeployment"))[0];
  assert.strictEqual(dep.Properties.SourceMarkers.length, 2);
  // config.json 의 배포 시점 토큰: CloudFront 도메인, Events http/realtime DNS, API 키
  const attrs = Object.values(dep.Properties.SourceMarkers[1]).map((v) => v["Fn::GetAtt"].join("."));
  assert.ok(attrs.some((a) => a.startsWith("Distribution") && a.endsWith(".DomainName")));
  assert.ok(attrs.some((a) => a.endsWith("Dns.Http")));
  assert.ok(attrs.some((a) => a.endsWith("Dns.Realtime")));
  assert.ok(attrs.some((a) => a.endsWith("ApiKey")));
  assert.deepStrictEqual(dep.Properties.SourceMarkersConfig[1], { jsonEscape: true });
});
