# seoul-ar infra

CDK(JavaScript) 스택 `SeoulArStack`, 리전 us-east-1 고정(조직 SCP가 ap-northeast-2를 막음).

- S3 비공개 버킷 + CloudFront(OAC). 403/404는 `/index.html` 200으로 응답(SPA).
- AppSync Events API `seoul-ar-events`, 채널 네임스페이스 `seoul`, API 키 인증(유효 90일).
- `BucketDeployment`가 `frontend/dist`와 배포 시점에 만든 `config.json`을 버킷에 올리고 CloudFront 캐시를 비웁니다.

## 배포

먼저 `frontend/`에서 빌드해 `frontend/dist`를 만든다(다른 경로면 `SEOUL_AR_DIST`로 지정).

```
cd infra
npm install
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

## 확인과 삭제

```
npm test                        # 단위 테스트(임시 dist 사용)
SEOUL_AR_DIST=<빈 폴더> npx cdk synth --strict -q
npx cdk destroy
```

## 출력

`CloudFrontUrl`, `EventsHttpEndpoint`, `EventsRealtimeEndpoint`, `BucketName`.

## config.json 계약 (CONTRACTS 7절)

배포 때 `Source.jsonData`로 버킷 루트에 생성된다. 값은 배포 시점에 치환된다.

```json
{
  "v": 1,
  "appUrl": "https://<distribution>.cloudfront.net",
  "events": {
    "httpEndpoint": "https://<api>.appsync-api.us-east-1.amazonaws.com/event",
    "realtimeEndpoint": "wss://<api>.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime",
    "region": "us-east-1",
    "apiKey": "da2-..."
  }
}
```

API 키는 90일 뒤 만료되므로 그 전에 다시 배포해 갱신한다. 키는 정적 사이트에 공개되는 값이다(연결, 발행, 구독만 가능).
