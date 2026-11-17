const fs = require("fs");
const path = require("path");
const cdk = require("aws-cdk-lib");
const s3 = require("aws-cdk-lib/aws-s3");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const appsync = require("aws-cdk-lib/aws-appsync");
const lambda = require("aws-cdk-lib/aws-lambda");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const cr = require("aws-cdk-lib/custom-resources");

const REGION = "us-east-1";
// 사용자가 미리 만드는 SecureString 파라미터(CONTRACTS 10.1). 스택은 이름만 참조하고 만들지 않는다.
const SSM_API_KEY_NAME = "/seoul-ar/seoul-api-key";
const SSM_PASSCODE_NAME = "/seoul-ar/presenter-passcode";
const FETCH_MONTH_DIR = path.join(__dirname, "..", "lambda", "fetch-month");
// AI 해설 모델(CONTRACTS 12.2). 바꾸려면: npx cdk deploy -c bedrockModelId=<모델 또는 us. 인퍼런스 프로파일 ID>
// 이 계정·리전에서 확인됨(실제 Converse): 기반 모델 ID 는 on-demand 불가, us. 인퍼런스 프로파일은 된다.
const DEFAULT_BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-5-5";
const GEO_PREFIX_RE = /^(us|eu|apac|global|us-gov|jp|au|ca)\./;

class SeoulArStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const dist = process.env.SEOUL_AR_DIST ?? path.join(__dirname, "..", "..", "frontend", "dist");

    // 1) 비공개 S3 버킷 (showcase 패턴 계승). CloudFront OAC 만 읽는다.
    const bucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 2) CloudFront. SPA 이므로 403/404 를 index.html 200 으로 돌려준다.
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: cdk.Duration.seconds(0),
      })),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      comment: "서울이 선다 (seoul-ar)",
    });

    // 3) AppSync Events API. 발표자 페이지와 관객 폰 사이 실시간 채널. API 키로 연결/발행/구독.
    const api = new appsync.EventApi(this, "Events", {
      apiName: "seoul-ar-events",
      authorizationConfig: {
        authProviders: [
          {
            authorizationType: appsync.AppSyncAuthorizationType.API_KEY,
            apiKeyConfig: { name: "default", expires: cdk.Expiration.after(cdk.Duration.days(90)) },
          },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
      },
    });
    api.addChannelNamespace("seoul");
    // EventApi.apiKeys 는 apiKeyConfig.name 을 키로 하는 CfnApiKey 맵
    const apiKey = api.apiKeys["default"].attrApiKey;

    const httpEndpoint = "https://" + api.httpDns + "/event";
    const realtimeEndpoint = "wss://" + api.realtimeDns + "/event/realtime";

    // 4) 프론트 dist + 배포 시점에 만든 config.json (CONTRACTS 7절).
    //    data/* 는 exclude: 사이트 sync(--delete)가 Lambda 가 쓴 data/{month}/*, data/jobs/*, index.json 을
    //    지우거나 덮어쓰지 않는다. 저장소의 데이터 스냅샷은 아래 시드 배포가 따로 올린다.
    const siteDeployment = new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [
        s3deploy.Source.asset(dist),
        s3deploy.Source.jsonData("config.json", {
          v: 1,
          appUrl: "https://" + distribution.distributionDomainName,
          events: { httpEndpoint, realtimeEndpoint, region: REGION, apiKey },
        }),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
      exclude: ["data/*"],
      cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
    });

    // 4b) 데이터 시드: dist/data → data/ 를 prune 없이 올린다(저장소의 달 폴더와 index.json. 아무것도 지우지 않는다).
    //     index.json 은 저장소 스냅샷으로 덮어써지므로 배포 뒤 작업자가 S3 내용으로 다시 만든다(5번 RebuildIndex).
    const dataDir = path.join(dist, "data");
    let seedDeployment = null;
    if (fs.existsSync(dataDir)) {
      seedDeployment = new s3deploy.BucketDeployment(this, "DeployDataSeed", {
        sources: [s3deploy.Source.asset(dataDir)],
        destinationBucket: bucket,
        destinationKeyPrefix: "data/",
        prune: false,
        cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
      });
      seedDeployment.node.addDependency(siteDeployment);
    } else {
      cdk.Annotations.of(this).addInfo(`${dataDir} 가 없어 데이터 시드 배포를 건너뜁니다`);
    }

    // 5) 월 실시간 수집 (CONTRACTS 10). 같은 코드(lambda/fetch-month)로 함수 둘:
    //    - API: Function URL(AuthType AWS_IAM, CloudFront OAC 만 호출) ← CloudFront /api/*. 암호 검사, 잠금, 작업자 Event 호출 뒤 202.
    //    - 작업자: 서울 API 수집·집계, data/* 쓰기, /data/* 무효화, /seoul/jobs 발행, AI 해설(Bedrock).
    //    한 함수로 합치면 Distribution → FunctionUrl → Function → (env DISTRIBUTION_ID) → Distribution
    //    순환이 생겨 배포가 안 된다. API 는 작업자를 CloudFormation 참조 없이 리터럴 이름/ARN 으로만 가리킨다.
    this.addFetchMonth({ bucket, distribution, httpEndpoint, apiKey, seedDeployment });

    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: "https://" + distribution.distributionDomainName,
      description: "서울이 선다 접속 URL",
    });
    new cdk.CfnOutput(this, "EventsHttpEndpoint", { value: httpEndpoint });
    new cdk.CfnOutput(this, "EventsRealtimeEndpoint", { value: realtimeEndpoint });
    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
  }

  addFetchMonth({ bucket, distribution, httpEndpoint, apiKey, seedDeployment }) {
    const workerName = `${this.stackName}-FetchMonthWorker`;
    const bedrockModelId = this.node.tryGetContext("bedrockModelId") ?? DEFAULT_BEDROCK_MODEL_ID;
    // 기반 모델 ID 와 us. 인퍼런스 프로파일 ID. 작업자는 on-demand 가 안 되면 us. 프로파일로 바꿔 부른다.
    const baseModelId = bedrockModelId.replace(GEO_PREFIX_RE, "");
    const profileId = GEO_PREFIX_RE.test(bedrockModelId) ? bedrockModelId : `us.${bedrockModelId}`;
    const workerArn = this.formatArn({ service: "lambda", resource: "function", resourceName: workerName, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME });
    const paramArn = (name) => this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.replace(/^\//, "") });
    // aws/ssm 관리형 키로 암호화한 SecureString 을 SSM 을 통해서만 복호화
    const kmsViaSsm = new iam.PolicyStatement({
      actions: ["kms:Decrypt"],
      resources: [this.formatArn({ service: "kms", resource: "key", resourceName: "*" })],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
    });
    const code = lambda.Code.fromAsset(FETCH_MONTH_DIR, { exclude: ["*.test.mjs", "fakes.mjs"] });
    const logGroup = (id) => new logs.LogGroup(this, id, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: cdk.RemovalPolicy.DESTROY });

    const worker = new lambda.Function(this, "FetchMonthWorker", {
      functionName: workerName,
      description: "서울이 선다: 한 달 25구 실거래 수집·집계 → S3 data/*, /seoul/jobs 진행 발행",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code,
      memorySize: 512,
      timeout: cdk.Duration.seconds(600),
      retryAttempts: 0,
      maxEventAge: cdk.Duration.minutes(5), // 5분 안에 시작 못 한 작업은 버린다(잠금 10분 stale 전에)
      logGroup: logGroup("FetchMonthWorkerLogs"),
      environment: {
        BUCKET: bucket.bucketName,
        DISTRIBUTION_ID: distribution.distributionId,
        EVENTS_HTTP_ENDPOINT: httpEndpoint,
        EVENTS_API_KEY: apiKey,
        SSM_API_KEY_NAME,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
    });
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.arnForObjects("data/*")] }));
    // index 재구성이 data/YYYYMM/{gu}.json 목록을 읽는다
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [bucket.bucketArn],
      conditions: { StringLike: { "s3:prefix": ["data/", "data/*"] } },
    }));
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["cloudfront:CreateInvalidation"], resources: [distribution.distributionArn] }));
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [paramArn(SSM_API_KEY_NAME)] }));
    worker.addToRolePolicy(kmsViaSsm);
    // Converse 는 bedrock:InvokeModel 권한을 쓴다. 그 모델(교차 리전 프로파일이 보내는 모든 리전)과 us. 프로파일로만.
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/${baseModelId}`,
        this.formatArn({ service: "bedrock", resource: "inference-profile", resourceName: profileId }),
      ],
    }));

    const api = new lambda.Function(this, "FetchMonthApi", {
      description: "서울이 선다: POST /api/fetch-month, /api/narrate-month (발표자 암호, 잠금, 작업자 비동기 호출)",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      reservedConcurrentExecutions: 2, // 병렬 암호 대입 상한(셋째 동시 요청은 Lambda 가 429 로 거절)
      logGroup: logGroup("FetchMonthApiLogs"),
      environment: {
        BUCKET: bucket.bucketName,
        SSM_PASSCODE_NAME,
        SELF_FUNCTION_NAME: workerName, // 같은 코드의 작업자. 리터럴이라 순환 참조가 없다
      },
    });
    api.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.arnForObjects("data/jobs/*")] }));
    // POST /api/narrate-month 가 그 달이 index 에 있는지 바로 확인한다(읽기만)
    api.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [bucket.arnForObjects("data/index.json")] }));
    api.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [paramArn(SSM_PASSCODE_NAME)] }));
    api.addToRolePolicy(kmsViaSsm);
    api.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [workerArn] }));

    // AWS_IAM + CloudFront OAC: 이 배포만 Function URL 을 부를 수 있다(9a fix S1). 발표자 암호 검사는 그대로.
    // OAC 는 POST 본문을 서명해야 하므로 브라우저가 x-amz-content-sha256 (본문 SHA-256 hex) 헤더를 보내야 한다.
    const url = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    distribution.addBehavior("/api/*", origins.FunctionUrlOrigin.withOriginAccessControl(url), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });

    // 배포마다(physicalResourceId 가 매번 바뀜) 시드 배포가 끝난 뒤 작업자를 동기 호출해 index.json 을 S3 내용으로 다시 만든다.
    const rebuildCall = {
      service: "Lambda",
      action: "invoke",
      parameters: { FunctionName: worker.functionName, InvocationType: "RequestResponse", Payload: JSON.stringify({ action: "rebuild-index" }) },
      physicalResourceId: cr.PhysicalResourceId.of(`rebuild-${Date.now()}`),
      outputPaths: ["StatusCode"], // 응답 Payload 를 커스텀 리소스 데이터(4KB 제한)에 싣지 않는다
    };
    const rebuild = new cr.AwsCustomResource(this, "RebuildIndex", {
      onCreate: rebuildCall,
      onUpdate: rebuildCall,
      installLatestAwsSdk: false,
      timeout: cdk.Duration.minutes(3),
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [worker.functionArn] }),
      ]),
    });
    rebuild.node.addDependency(worker);
    if (seedDeployment) rebuild.node.addDependency(seedDeployment);

    new cdk.CfnOutput(this, "FetchMonthUrl", {
      value: "https://" + distribution.distributionDomainName + "/api/fetch-month",
      description: "월 가져오기 API (POST, x-presenter-key)",
    });
  }
}

module.exports = { SeoulArStack };
