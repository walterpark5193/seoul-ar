#!/usr/bin/env node
const cdk = require("aws-cdk-lib");
const { SeoulArStack } = require("../lib/seoul-ar-stack");

const app = new cdk.App();
new SeoulArStack(app, "SeoulArStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // 조직 SCP 가 ap-northeast-2 를 막으므로 us-east-1 고정
    region: "us-east-1",
  },
  description: "서울이 선다: 정적 사이트(S3 비공개 + CloudFront OAC) + AppSync Events 실시간 채널",
});
