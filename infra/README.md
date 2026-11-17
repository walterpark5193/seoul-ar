# seoul-ar infra

CDK(JavaScript) 스택 `SeoulArStack`, 리전 us-east-1 고정(조직 SCP가 ap-northeast-2를 막음).

- S3 비공개 버킷 + CloudFront(OAC). 403/404는 `/index.html` 200으로 응답(SPA). 이 규칙은 `/api/*`에도 적용되므로 API는 403/404를 쓰지 않는다(아래 표).
- AppSync Events API `seoul-ar-events`, 채널 네임스페이스 `seoul`, API 키 인증(유효 90일).
- `BucketDeployment` 두 개:
  - `DeploySite`: `frontend/dist`(단 `data/*` 제외)와 배포 시점에 만든 `config.json`을 버킷 루트에 올리고(prune) CloudFront 캐시를 비운다. `exclude: ["data/*"]` 이므로 `data/` 아래는 올리지도 지우지도 않는다.
  - `DeployDataSeed`: `frontend/dist/data` → `data/` 를 prune 없이 올린다(저장소의 달 폴더와 `index.json`). 아무것도 지우지 않는다. `dist/data` 가 없으면 건너뛴다(정보 메시지만).
- 월 실시간 수집(아래): Lambda 두 개, Function URL, CloudFront `/api/*`, 배포마다 index 재구성.

## 배포

먼저 `frontend/`에서 빌드해 `frontend/dist`를 만든다(다른 경로면 `SEOUL_AR_DIST`로 지정). 월 수집을 쓰려면 배포 전에 SSM 파라미터 두 개를 만든다(아래).

```
cd infra
npm install
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

## 확인과 삭제

```
npm test                        # 전부: CDK assertions(test/) + Lambda 단위 테스트(lambda/), 임시 dist 사용
npm run test:stack              # CDK assertions 만
npm run test:lambda             # Lambda 단위 테스트만 (서울 API, S3, SSM, CloudFront, Lambda, AppSync 는 전부 가짜)
npm run sync:lambda             # tools/data 의 집계 코드를 Lambda 로 복사 (아래)
SEOUL_AR_DIST=<빈 폴더> npx cdk synth --strict -q
npx cdk destroy
```

## 출력

`CloudFrontUrl`, `EventsHttpEndpoint`, `EventsRealtimeEndpoint`, `BucketName`, `FetchMonthUrl`(`https://<distribution>.cloudfront.net/api/fetch-month`).

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

## 월 실시간 수집 (CONTRACTS 10)

발표자 화면에서 월을 고르면 Lambda 가 서울 열린데이터광장 API(`tbLnOpendataRtmsV`)를 25구 모두 불러 집계하고, `data/{month}/{gu}.json` 25개와 `data/index.json` 을 S3 에 쓴 뒤 진행 상황을 AppSync Events `/seoul/jobs` 로 알린다. 서울 API 키는 SSM 에만 있고 코드, 저장소, 브라우저에는 없다.

### 1. SSM 파라미터 (사용자가 만든다)

스택은 이름만 참조하고 만들지 않는다(값이 템플릿에 들어가지 않게). us-east-1, SecureString(기본 `aws/ssm` 키). 키가 셸 기록에 남지 않도록 `read -rs` 로 받아 넣는다.

```bash
read -rs SEOUL_API_KEY   # 서울 열린데이터광장 인증키를 붙여 넣고 Enter
aws ssm put-parameter --region us-east-1 --name /seoul-ar/seoul-api-key \
  --type SecureString --value "$SEOUL_API_KEY"
read -rs PRESENTER_PASSCODE   # 발표자 암호(영문·숫자·기호 권장: 브라우저 헤더는 한글을 보낼 수 없다)
aws ssm put-parameter --region us-east-1 --name /seoul-ar/presenter-passcode \
  --type SecureString --value "$PRESENTER_PASSCODE"
unset SEOUL_API_KEY PRESENTER_PASSCODE
```

값을 바꿀 때는 같은 명령에 `--overwrite` 를 붙인다. Lambda 는 요청마다 SSM 을 읽으므로 재배포가 필요 없다.

### 2. 엔드포인트 `POST /api/fetch-month`

CloudFront 추가 동작 `/api/*` → Lambda Function URL(AuthType NONE). 캐시 없음(`CACHING_DISABLED`), 오리진 요청 정책 `ALL_VIEWER_EXCEPT_HOST_HEADER`(헤더·본문 전달), 메서드 전부 허용, HTTPS 리다이렉트. Function URL 을 직접 불러도 같은 검사를 거친다(경로 `/fetch-month` 도 받는다).

요청: 헤더 `x-presenter-key: <발표자 암호>`, 본문 `{"month": "202610"}`.

| 코드 | 본문 | 뜻 |
|---|---|---|
| 202 | `{"jobId", "month"}` | 시작됨. 진행은 `/seoul/jobs` 이벤트와 `data/jobs/{jobId}.json` |
| 400 | `{"error": "bad_month" \| "bad_request", "message"}` | YYYYMM 형식, 200601 이상, 한국 시간 이번 달 이하가 아님 / 본문이 JSON 이 아님 |
| 401 | `{"error": "unauthorized", "message"}` | 암호 헤더 없음 또는 불일치(sha256 다이제스트를 `timingSafeEqual` 로 비교). 월 검사보다 먼저 |
| 409 | `{"error": "busy", "message", "jobId"?, "month"?}` | 다른 작업 진행 중(`data/jobs/lock.json`, 10분 지나면 stale 로 무시) |
| 405 / 500 | `{"error", "message"}` | POST 아님 / 설정·잠금·작업자 호출 실패 |

`message` 는 모두 한국어 한 문장이고 키·URL 이 없다.

### 3. 작업 흐름

Lambda 두 개가 같은 코드(`lambda/fetch-month`, 의존성 없음: 런타임 내장 AWS SDK v3 와 global fetch)를 쓴다.

- `FetchMonthApi` (Function URL, 256 MB, 15 초): 경로·메서드 → 암호(401) → 월(400) → 잠금(409, S3 조건부 쓰기 `IfNoneMatch`/`IfMatch` 로 원자적) → 작업 기록 `running 0/25` → 작업자를 `InvocationType: Event` 로 호출(`SELF_FUNCTION_NAME`) → 202.
- `SeoulArStack-FetchMonthWorker` (512 MB, 600 초, 비동기 재시도 0): 페이로드 `{jobId, month}`.
  1. SSM 에서 서울 API 키를 읽는다.
  2. 25구를 동시에 4개씩: `RCPT_YR = month[:4]`, `CGG_NM = 구` 로 1000건씩 페이지 호출. 페이지가 1000건 미만이거나, 페이지의 가장 오래된 `CTRT_DAY` 가 그 달 1일보다 앞서거나, `list_total_count` 에 닿거나, 12페이지면 멈춘다. `CTRT_DAY[:6] === month` 인 행만 남긴다. `INFO-200` 은 빈 결과.
  3. 구 하나 끝날 때마다 `tools/data/aggregate.mjs` 의 `aggregateRows` 로 집계하고 `running`(done 1..25, 구 이름)을 발행.
  4. 25구가 다 되면 `data/{month}/{gu}.json` 25개 → `data/index.json` 병합(기존 달 유지, 그 달 summary 교체, months 정렬, generatedAt 갱신). 모두 `Cache-Control: no-cache`.
  5. CloudFront `/data/*` 무효화(실패해도 경고만: 파일이 no-cache 라 곧 보인다) → `done 25/25` 발행.
  6. 실패하면 `error`(사용자용 `message`) 발행. 어떤 경우든 `finally` 에서 잠금 해제. Lambda 제한 시간 90초 전이면 스스로 멈추고 `error` 를 알린다(10분 stale 전에 끝나 다음 작업과 겹치지 않게).
- 진행 이벤트(`JobMessage`, CONTRACTS 10.4): `POST {EVENTS_HTTP_ENDPOINT}`, 헤더 `x-api-key`, 본문 `{"channel": "/seoul/jobs", "events": ["<JSON 문자열>"]}`. 같은 메시지를 `data/jobs/{jobId}.json` 에도 쓴다(폴링 폴백).

### 4. 재배포와 index 재구성

사이트 배포는 `data/*` 를 건드리지 않고, 시드 배포는 지우지 않는다. 시드가 `data/index.json` 을 저장소 스냅샷으로 덮어쓰므로, 배포마다 커스텀 리소스 `RebuildIndex`(AwsCustomResource, `physicalResourceId` 가 매번 바뀜)가 시드 배포 뒤 작업자를 `{"action": "rebuild-index"}` 로 동기 호출한다. 작업자는 S3 `data/YYYYMM/{gu}.json` 목록(`s3:ListBucket`, 접두사 `data/`)의 `total` 로 index 를 다시 만들고(빠진 구는 빈 통계, 구 파일이 없는 달은 뺌, 기존 `source` 유지) `/data/index.json` 을 무효화한다. 재구성 실패는 배포를 깨지 않는다(작업자 로그에 남는다).

주의: 시드는 저장소에 있는 달(예: 202611)의 구 파일을 저장소 버전으로 되돌린다. 배포 도중에 월 가져오기를 하면 그 달이 index 에서 빠질 수 있다(배포 뒤 다시 가져오면 된다).

### 5. IAM (최소 권한)

| 주체 | 허용 |
|---|---|
| 작업자 | `s3:GetObject`·`s3:PutObject` on `bucket/data/*`, `s3:ListBucket` on bucket (조건 `s3:prefix` = `data/`, `data/*`), `cloudfront:CreateInvalidation` on 이 배포, `ssm:GetParameter` on `/seoul-ar/seoul-api-key`, `kms:Decrypt` (조건 `kms:ViaService = ssm.us-east-1.amazonaws.com`) |
| API | `s3:GetObject`·`s3:PutObject` on `bucket/data/jobs/*`, `ssm:GetParameter` on `/seoul-ar/presenter-passcode`, `kms:Decrypt` (ssm 경유), `lambda:InvokeFunction` on 작업자 |
| RebuildIndex | `lambda:InvokeFunction` on 작업자 |
| Function URL | `lambda:InvokeFunctionUrl` + `lambda:InvokeFunction`(`InvokedViaFunctionUrl`), Principal `*`, AuthType NONE (보호는 발표자 암호) |

왜 함수가 둘인가: 한 함수에 Function URL 과 `DISTRIBUTION_ID` 를 같이 두면 Distribution → FunctionUrl → Function → (env `DISTRIBUTION_ID`) → Distribution 순환이 생겨 CloudFormation 이 배포를 거부한다. 그래서 Function URL 쪽(API)은 작업자를 CloudFormation 참조 없이 리터럴 이름/ARN 으로만 가리키고, 배포 ID 는 작업자만 가진다. 덤으로 인터넷에 열린 함수는 서울 API 키와 CloudFront 권한이 없다.

### 6. 집계 코드 동기화

Lambda 는 `tools/` 를 import 할 수 없으므로 `tools/data/aggregate.mjs` 와 `tools/data/gu.mjs` 의 복사본을 `lambda/fetch-month/` 에 둔다. 원본을 고치면 다음으로 맞춘다.

```
node infra/scripts/sync-lambda-shared.mjs          # 복사 (또는 infra 에서 npm run sync:lambda)
node infra/scripts/sync-lambda-shared.mjs --check  # 다르면 exit 1
```

`lambda/fetch-month/shared.test.mjs` 가 두 파일이 바이트 단위로 같은지 검사하므로, 동기화를 잊으면 `npm test` 가 실패한다. Lambda 자산에서는 `*.test.mjs` 와 `fakes.mjs` 를 뺀다.

### 7. 알려진 한계

- 서울 API 는 `http://openapi.seoul.go.kr:8088` (HTTP) 로만 열려 있어 키가 평문으로 오간다(캡스톤 server.py 와 같음).
- 접수연도(`RCPT_YR`)로 거르므로, 12월에 계약하고 다음 해 1월에 신고한 거래는 12월 수집에서 빠진다.
- 거래가 많은 오래된 달은 12페이지(12,000건, 접수연도 전체 기준) 안에 다 못 받을 수 있다(작업자 로그 `페이지 상한에 닿음`).
- `truncated` 는 집계 코드 그대로 "그 달 행이 1000건 이상"이다. 실시간 수집은 여러 페이지를 받으므로 1000건 이상이어도 잘린 것이 아닐 수 있다.
