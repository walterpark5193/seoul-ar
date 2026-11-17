const path = require("path");
const cdk = require("aws-cdk-lib");
const s3 = require("aws-cdk-lib/aws-s3");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const s3deploy = require("aws-cdk-lib/aws-s3-deployment");
const appsync = require("aws-cdk-lib/aws-appsync");

const REGION = "us-east-1";

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

    // 4) 프론트 dist + 배포 시점에 만든 config.json (CONTRACTS 7절)
    new s3deploy.BucketDeployment(this, "DeploySite", {
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
      cacheControl: [s3deploy.CacheControl.fromString("no-cache")],
    });

    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: "https://" + distribution.distributionDomainName,
      description: "서울이 선다 접속 URL",
    });
    new cdk.CfnOutput(this, "EventsHttpEndpoint", { value: httpEndpoint });
    new cdk.CfnOutput(this, "EventsRealtimeEndpoint", { value: realtimeEndpoint });
    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
  }
}

module.exports = { SeoulArStack };
