# seoul-ar infra

CDK(JavaScript) 스택 `SeoulArStack`, 리전 us-east-1 고정(조직 SCP가 ap-northeast-2를 막음).

- S3 비공개 버킷 + CloudFront(OAC). 403/404는 `/index.html` 200으로 응답(SPA). 이 규칙은 `/api/*`에도 적용되므로 API는 403/404를 쓰지 않는다(아래 표).
- AppSync Events API `seoul-ar-events`, 채널 네임스페이스 `seoul`, API 키 인증(유효 90일).
- `BucketDeployment` 두 개:
  - `DeploySite`: `frontend/dist`(단 `data/*` 제외)와 배포 시점에 만든 `config.json`을 버킷 루트에 올리고(prune) CloudFront 캐시를 비운다. `exclude: ["data/*"]` 이므로 `data/` 아래는 올리지도 지우지도 않는다.
  - `DeployDataSeed`: `frontend/dist/data` → `data/` 를 prune 없이 올린다(저장소의 달 폴더와 `index.json`). 아무것도 지우지 않는다. `dist/data` 가 없으면 건너뛴다(정보 메시지만).
- 월 실시간 수집과 AI 해설(아래): Lambda 두 개, Function URL, CloudFront `/api/*`, 배포마다 index 재구성, Bedrock.

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

값을 바꿀 때는 같은 명령에 `--overwrite` 를 붙인다. 재배포는 필요 없다(서울 API 키는 작업마다 읽고, 발표자 암호는 길어야 1분 뒤 반영된다: 60초 메모리 캐시).

보안 권장:
- 서울 API 는 HTTP 로만 열려 있다(확인함: 8088 포트는 TLS 핸드셰이크가 실패하고 443 은 응답하지 않는다). 그래서 키가 `openapi.seoul.go.kr` 까지 평문으로 간다. **이 앱 전용 키**를 발급해 쓰고 행사가 끝나면 **폐기·재발급**한다.
- 발표자 암호는 **12자 이상**이어야 한다(코드가 강제한다: 짧으면 모든 요청에 503 `passcode_too_short`, 작업자 로그에 error). 같은 접속(IP, IPv6 는 /64)에서 10분 안에 10번 시도해 틀리면 10분 동안 429 로 막는다(아래 표).
- 이전 버전(암호 시도 기록을 공개 사이트 버킷 `data/jobs/_auth/` 에 두던 것)을 배포한 적이 있으면, 이번 배포 뒤 그 객체들을 지우고(`aws s3 rm s3://<BucketName>/data/jobs/_auth/ --recursive`) **발표자 암호를 바꾼다**. 그 기록 이름은 암호에서 유도돼 있어 오프라인 대입에 쓰일 수 있었다.
- 행사장 와이파이처럼 관객과 같은 공인 IP(NAT)를 쓰면, 관객 누군가가 10번 틀려도 발표자까지 10분 막힌다. 발표자는 **휴대폰 핫스폿** 같은 다른 회선을 쓰고, 암호는 **처음부터 정확히** 넣는다.

### 2. 엔드포인트 `POST /api/fetch-month` (와 `POST /api/narrate-month`, 7절)

CloudFront 추가 동작 `/api/*` → Lambda Function URL(**AuthType AWS_IAM + CloudFront OAC**: 이 배포만 SigV4 로 서명해 부를 수 있고, Function URL 을 직접 부르면 403). 캐시 없음(`CACHING_DISABLED`), 오리진 요청 정책 `ALL_VIEWER_EXCEPT_HOST_HEADER`(헤더·본문·`CloudFront-Viewer-Address` 전달), 메서드 전부 허용, HTTPS 리다이렉트. 발표자 암호 검사는 그대로 한다.

요청: 헤더 `x-presenter-key: <발표자 암호>` 와 **`x-amz-content-sha256: <본문의 SHA-256 hex>`**, 본문 `{"month": "202610"}`. OAC 는 POST 본문을 서명해야 해서, 이 헤더가 없으면 Lambda 가 403 을 주고 CloudFront 는 그것을 SPA 규칙대로 `/index.html` 200 으로 바꾼다(브라우저에서는 JSON 이 아닌 응답으로 보인다). 브라우저는 `crypto.subtle.digest("SHA-256", 본문 바이트)` 로 만든다.

| 코드 | 본문 | 뜻 |
|---|---|---|
| 202 | `{"jobId", "month"}` | 시작됨. 진행은 `/seoul/jobs` 이벤트와 `data/jobs/{jobId}.json` |
| 400 | `{"error": "bad_month" \| "bad_request", "message"}` | YYYYMM 형식, 200601 이상, 한국 시간 이번 달 이하가 아님 / 본문이 JSON 이 아님 |
| 401 | `{"error": "unauthorized", "message"}` | 암호 헤더 없음 또는 불일치(sha256 다이제스트를 `timingSafeEqual` 로 비교). 월 검사보다 먼저 |
| 409 | `{"error": "busy", "message", "jobId"?, "month"?}` | 다른 작업 진행 중(`data/jobs/lock.json`, 10분 지나면 stale 로 무시) |
| 429 | `{"error": "locked", "message": "암호를 너무 많이 틀렸습니다. 약 N분 뒤 다시 시도해 주세요.", "retryAfterSeconds"}`, 헤더 `retry-after`(초) | 같은 접속(IP, IPv6 는 /64 접두사)에서 10분 안에 10번째 시도가 틀림 → 10분 잠금. 시도는 암호를 비교하기 **전에** 센다: 비공개 버킷 `AuthStateBucket` 의 `attempts/<HMAC-SHA256(ip, 서버 쪽 임의 비밀)>.json`(no-store, 원래 주소는 남기지 않음)을 ETag 조건부 쓰기(처음 `IfNoneMatch: "*"`, 갱신 `IfMatch`)로 올리고 경합이면 3번까지 다시 한다. 비밀은 Secrets Manager `AuthHmacSecret`(CDK 가 만든 32자 임의 값, 발표자 암호와 무관, 컨테이너마다 한 번 읽음). 비밀을 못 읽거나 셈을 기록하지 못하면 비교하지 않고 503 `auth_unavailable`(fail-closed, 틀린 암호 401 과 구별). 맞히면 초기화. IP 는 `CloudFront-Viewer-Address`(없으면 `sourceIp`). 예약 동시성은 두지 않는다(누구나 채워 발표자를 굶길 수 있다) |
| 503 | `{"error": "auth_unavailable", "message": "잠금 상태를 확인할 수 없어 요청을 받지 않았습니다. 잠시 후 다시 시도해 주세요."}` | 인증 상태 버킷이나 HMAC 비밀을 쓸 수 없음(fail-closed). 틀린 암호(401)와 구별되므로 브라우저는 저장된 암호를 지우지 않는다 |
| 503 | `{"error": "passcode_too_short", "message": "발표자 암호는 12자 이상이어야 합니다. SSM 값을 바꿔 주세요."}` | SSM 의 발표자 암호가 12자 미만(설정 오류, 시도로 세지 않음) |
| 405 / 500 | `{"error", "message"}` | POST 아님 / 설정·잠금·작업자 호출 실패 |

2xx 가 아닌 응답은 모두 `{ "error": <코드>, "message": <한국어 한 문장> }` 이고 키·URL 이 없다(409 는 잠금 주인에 따라 "{월} 데이터를 가져오는 중입니다" 또는 "{월} 해설을 만드는 중입니다").

무차별 대입 방어를 이렇게 정한 이유: 이 엔드포인트를 쓰는 사람은 발표자 한 명이고 행사는 몇 시간이다. 그래서 (1) IP(IPv6 /64)마다 원자적으로 세는 잠금(10분에 10번 → 10분)과 (2) 12자 이상 강제로 막는다. 잠금은 IP 하나당 시간당 약 60번까지만 허용하고, 12자 무작위 암호(영문 소문자·숫자만 써도 36¹² ≈ 4.7×10¹⁸)는 IP 를 수천 개 써도 행사 안에 맞힐 수 없다. 예약 동시성으로 병렬 대입을 묶는 방식은 쓰지 않는다: 누구나 그 몇 칸을 채워 발표자를 굶길 수 있다(인증 없는 DoS). AWS WAF 속도 제한은 월 고정비와 규칙 관리가 들고, IP 당 요청 수만 보아 같은 효과를 내면서 이 작은 데모에는 과하다. 대신 잠금 기록은 공개 경로가 없는 별도 버킷에 서버 쪽 임의 비밀로 만든 HMAC 이름으로 두어, 기록에서 암호나 IP 를 거꾸로 찾을 수 없게 했다. 남는 위험은 같은 NAT 를 쓰는 관객이 발표자를 잠글 수 있다는 것(1절 권장: 핫스폿).

### 3. 작업 흐름

Lambda 두 개가 같은 코드(`lambda/fetch-month`, 의존성 없음: 런타임 내장 AWS SDK v3 와 global fetch)를 쓴다.

- `FetchMonthApi` (Function URL, 256 MB, 15 초): 경로·메서드 → 시도 셈(비공개 인증 상태 버킷, 잠금이면 429, 기록·비밀 실패면 503 `auth_unavailable`) → 암호 읽기(60초 캐시, 실패면 500) → 저장된 암호가 12자 미만이면 503 `passcode_too_short`(시도로 세지 않음) → 암호 비교(401) → 월(400) → 잠금(409, S3 조건부 쓰기 `IfNoneMatch`/`IfMatch` 로 원자적) → 작업 기록 `running 0/25` → 작업자를 `InvocationType: Event` 로 호출(`SELF_FUNCTION_NAME`) → 202.
- `SeoulArStack-FetchMonthWorker` (512 MB, 600 초, 비동기 재시도 0, 5분 안에 시작 못 한 이벤트는 버림): 페이로드 `{jobId, month}`.
  1. SSM 에서 서울 API 키를 읽는다.
  2. 25구를 동시에 4개씩: `RCPT_YR = month[:4]`, `CGG_NM = 구` 로 1000건씩 페이지 호출. 페이지가 1000건 미만이거나, 페이지의 **가장 최근** `CTRT_DAY` 가 그 달 1일보다 앞서거나(정렬 순서가 확인되지 않아 페이지 전체가 지난 뒤에만 멈춘다), `list_total_count` 에 닿거나, 30페이지면 멈춘다. `CTRT_DAY[:6] === month` 인 행만 남긴다. `INFO-200` 은 빈 결과. 네트워크·429·5xx·형식 오류는 1.5초 쉬고 한 번 다시 시도한다. 한 구가 실패하면 다른 구도 다음 페이지를 부르지 않는다.
  3. 구 하나 끝날 때마다 `tools/data/aggregate.mjs` 의 `aggregateRows` 로 집계하고 `running`(done 1..25, 구 이름)을 발행. `total.truncated`(와 index 의 그 구 summary)는 "30페이지 상한에 닿아 끝까지 받지 못함"으로 바꿔 쓴다.
  4. 25구가 다 되면 `data/{month}/{gu}.json` 25개 → `data/index.json` 병합(기존 달 유지, 그 달 summary 교체, months 정렬, generatedAt 갱신). 모두 `Cache-Control: no-cache`.
  5. CloudFront `/data/*` 무효화(실패해도 경고만: 파일이 no-cache 라 곧 보인다).
  6. 잠금을 먼저 풀고 `done 25/25` 또는 `error`(사용자용 `message`)를 발행한다(받자마자 다음 달을 눌러도 409 가 나지 않게). `done` 의 `message`: 상한에 닿은 구가 있으면 "일부 구는 거래가 많아 끝까지 받지 못했습니다: 강남구, 송파구", 11·12월이면 "11·12월은 다음 해에 신고된 거래가 빠질 수 있습니다". Lambda 제한 시간 90초 전이면 스스로 멈추고 `error` 를 알린다(10분 stale 전에 끝나 다음 작업과 겹치지 않게).
- 진행 이벤트(`JobMessage`, CONTRACTS 10.4): `POST {EVENTS_HTTP_ENDPOINT}`, 헤더 `x-api-key`, 본문 `{"channel": "/seoul/jobs", "events": ["<JSON 문자열>"]}`. 같은 메시지를 `data/jobs/{jobId}.json` 에도 쓴다(폴링 폴백).

### 4. 재배포와 index 재구성

사이트 배포는 `data/*` 를 건드리지 않고, 시드 배포는 지우지 않는다. 시드가 `data/index.json` 을 저장소 스냅샷으로 덮어쓰므로, 배포마다 커스텀 리소스 `RebuildIndex`(AwsCustomResource, `physicalResourceId` 가 매번 바뀜)가 시드 배포 뒤 작업자를 `{"action": "rebuild-index"}` 로 동기 호출한다. 작업자는 S3 `data/YYYYMM/{gu}.json` 목록(`s3:ListBucket`, 접두사 `data/`)의 `total` 로 index 를 다시 만들고(빠진 구는 빈 통계, 구 파일이 없는 달은 뺌, 기존 `source` 유지) `/data/index.json` 을 무효화한다. 재구성 실패는 배포를 깨지 않는다(작업자 로그에 남는다).

주의: 시드는 저장소에 있는 달(예: 202611)의 구 파일을 저장소 버전으로 되돌린다. 배포 도중에 월 가져오기를 하면 그 달이 index 에서 빠질 수 있다(배포 뒤 다시 가져오면 된다).

### 5. IAM (최소 권한)

| 주체 | 허용 |
|---|---|
| 작업자 | `s3:GetObject`·`s3:PutObject` on `bucket/data/*`, `s3:ListBucket` on bucket (조건 `s3:prefix` = `data/`, `data/*`), `cloudfront:CreateInvalidation` on 이 배포, `ssm:GetParameter` on `/seoul-ar/seoul-api-key`, `kms:Decrypt` (조건 `kms:ViaService = ssm.us-east-1.amazonaws.com`), `bedrock:InvokeModel` on 그 모델과 `us.` 프로파일 |
| API | `s3:GetObject`·`s3:PutObject` on `bucket/data/jobs/*`(잠금, 작업 기록), `s3:GetObject` on `bucket/data/index.json`(narrate-month 확인), `ssm:GetParameter` on `/seoul-ar/presenter-passcode`, `kms:Decrypt` (ssm 경유), `lambda:InvokeFunction` on 작업자, `s3:GetObject`·`s3:PutObject` on `AuthStateBucket/*`(암호 시도 셈), `secretsmanager:GetSecretValue` on `AuthHmacSecret` 하나, **Deny** `s3:GetObject`·`s3:PutObject` on `bucket/data/jobs/_auth/*`(예전 공개 위치) |
| RebuildIndex | `lambda:InvokeFunction` on 작업자 |
| AuthStateBucket | 사이트와 따로 둔 비공개 버킷: 공개 차단, SSE-S3, SSL 강제, 1일 뒤 만료, 스택 삭제 시 비움. CloudFront 오리진이 아니다(공개 경로 없음). API 역할만 Get/Put |
| Function URL | AuthType AWS_IAM. `lambda:InvokeFunctionUrl` + `lambda:InvokeFunction`(`InvokedViaFunctionUrl`), Principal `cloudfront.amazonaws.com`, SourceArn = 이 배포 (OAC). 공개 권한 없음 |

왜 함수가 둘인가: 한 함수에 Function URL 과 `DISTRIBUTION_ID` 를 같이 두면 Distribution → FunctionUrl → Function → (env `DISTRIBUTION_ID`) → Distribution 순환이 생겨 CloudFormation 이 배포를 거부한다. 그래서 Function URL 쪽(API)은 작업자를 CloudFormation 참조 없이 리터럴 이름/ARN 으로만 가리키고, 배포 ID 는 작업자만 가진다. 덤으로 인터넷에 열린 함수는 서울 API 키와 CloudFront 권한이 없다.

### 6. 집계 코드 동기화

Lambda 는 `tools/` 를 import 할 수 없으므로 `tools/data/aggregate.mjs` 와 `tools/data/gu.mjs` 의 복사본을 `lambda/fetch-month/` 에 둔다. 원본을 고치면 다음으로 맞춘다.

```
node infra/scripts/sync-lambda-shared.mjs          # 복사 (또는 infra 에서 npm run sync:lambda)
node infra/scripts/sync-lambda-shared.mjs --check  # 다르면 exit 1
```

`lambda/fetch-month/shared.test.mjs` 가 두 파일이 바이트 단위로 같은지 검사하므로, 동기화를 잊으면 `npm test` 가 실패한다. Lambda 자산에서는 `*.test.mjs` 와 `fakes.mjs` 를 뺀다.

### 7. AI 한 줄 해설 (CONTRACTS 12)

달마다 `data/{month}/narration.json`(`{v, month, generatedAt, model, items}`, `Cache-Control: no-cache`)을 만든다. 키는 `"서울 전체"`와 25구, 값은 한국어 한 문장(80자 이내).

- 언제: (a) 월 수집이 `done` 된 뒤 같은 작업자 호출 안에서 자동으로(수집 잠금을 푼 뒤 `{수집 jobId}-narration` 으로 다시 잠근다. 그동안 "해설 생성"은 409 "{월} 해설을 만드는 중입니다". 다른 작업이 잠금을 잡고 있으면 자동 해설은 건너뛴다. 진행은 `/seoul/jobs` 에 `kind: "narration"`, jobId `{수집 jobId}-narration`, 기록 `data/jobs/{그 jobId}.json`). 실패해도 수집 결과는 그대로다. (b) 이미 있는 달은 `POST /api/narrate-month` `{"month"}` + `x-presenter-key` → 202 `{jobId, month}`. 검사와 잠금은 fetch-month 와 같고, index 에 없는 달이면 400 `no_data`.
- 어떻게: Bedrock Converse 로 한 번에 26개를 JSON 으로 받고, 코드로 검증한다(80자, 줄바꿈 없음, 금지어 `추천|매수|매도|사세요|팔세요|오를|내릴|전망|유망|투자하`, 번지·지번 숫자, 한글이 있어야 함, `{`·`"` 로 시작하는 JSON 조각·`<키>:` 조각·"죄송" 거절 문구는 거름, 키 유효성). 누락·실패 항목만 구별로 1회 다시 만들고, 그래도 안 되면 그 키를 뺀다. 한 작업 호출은 30회 이하(보통 1회, 최대 27회). 입력은 집계 숫자(구별 total, ㎡당 상위 법정동 3개, 서울 합계)뿐이다. 일괄 응답의 `stopReason` 을 로그에 남기고 `max_tokens` 면 잘렸다고 경고한다.
- 읽지 못한(없거나 깨진) 구 파일은 "거래 없음"으로 지어내지 않고 그 키를 뺀다. 구가 하나라도 빠지면 서울 합계가 틀리므로 "서울 전체"도 뺀다.
- 재시도 중 제한 시간(남은 90초)에 걸리면 거기서 멈추고 지금까지 통과한 항목만 저장한 뒤 `done`(빠진 키 이름을 `message` 로)을 알린다.
- 모델: env `BEDROCK_MODEL_ID`, 기본 `us.anthropic.claude-haiku-5-5`(인퍼런스 프로파일. 이 계정·리전에서 실제 Converse 로 확인: 기반 모델 ID `anthropic.claude-haiku-5-5` 는 on-demand 호출이 안 된다). 바꾸려면 `npx cdk deploy -c bedrockModelId=<ID>`(예: `us.anthropic.claude-haiku-4-5-20251001-v1:0`). on-demand 호출이 안 되는 모델이면 작업자가 `us.` 인퍼런스 프로파일로 한 번 바꿔 부르고, 실제로 쓴 ID 를 `model` 에 적는다.
- IAM: 작업자만 `bedrock:InvokeModel`, 대상은 `arn:aws:bedrock:*::foundation-model/<기반 모델>` 과 `arn:aws:bedrock:us-east-1:<계정>:inference-profile/us.<기반 모델>` 둘뿐. 공개 함수(API)에는 Bedrock 권한이 없다.
- 계정에서 그 모델 접근이 막혀 있으면 작업은 `error`("Bedrock 모델 접근 권한과 모델 ID 를 확인해 주세요")로 끝난다. Bedrock 콘솔 Model access 에서 Anthropic Claude Haiku 를 켠다(처음이면 사용 목적 양식).

### 8. 리허설 점검표 (배포 전후)

1. **배포 직전에 프론트를 다시 빌드한다**: `frontend/` 에서 빌드해 `frontend/dist` 를 새로 만든 다음 `infra/` 에서 `npx cdk deploy …`. 사이트 배포는 그때의 dist 를 올린다(오래된 dist 면 옛 화면이 나간다).
2. **202610 을 가져와 구별 건수를 본다**: 발표자 화면에서 2026년 10월을 가져오고 `data/202610/{구}.json` 의 `total.n` 이 구마다 그럴듯한지(대부분 0 이 아닌지) 확인한다. 거의 전부 0 인 빈 달이면 서울 API 가 계약일 **오름차순**으로 준다는 뜻이다. 그때는 `lambda/fetch-month/seoulApi.mjs` 의 "가장 최근 계약일" 멈춤 규칙을 빼야 한다(1000건 미만·`list_total_count`·30페이지 멈춤만 남긴다).
3. **202611 해설을 미리 만든다**: 호스트 화면의 "해설 생성"(`POST /api/narrate-month` `{"month":"202611"}`)으로 `data/202611/narration.json` 을 만든다. Bedrock 모델 ARN 짝(기반 모델 + `us.` 인퍼런스 프로파일) IAM 과 런타임 내장 SDK 클라이언트(Bedrock Runtime, Secrets Manager 등)가 실제로 도는지 여기서 확인된다. 실패하면 작업자 로그의 `Bedrock 호출 실패` 를 본다.
4. 틀린 암호 한 번으로 401, 맞는 암호로 202 가 나는지 보고(Function URL 을 직접 부르면 403 인지도), 발표 회선(핫스폿)에서 다시 한 번 해 본다.

### 9. 알려진 한계

- 서울 API 는 `http://openapi.seoul.go.kr:8088` (HTTP) 로만 열려 있어 키가 평문으로 오간다(1절 보안 권장: 전용 키, 행사 뒤 폐기).
- 접수연도(`RCPT_YR`)로 거르므로, 11·12월에 계약하고 다음 해에 신고한 거래는 빠진다. 다음 해까지 뒤지면 그 해 전체를 넘겨야 해서 하지 않고, `done` 메시지로 알린다.
- 거래가 많은 오래된 달은 30페이지(30,000건, 접수연도 전체 기준) 안에 다 못 받을 수 있다. 그 구는 `truncated: true` 가 되고 `done` 메시지에 이름이 나온다.
- `truncated` 의 뜻: 실시간 수집(이 Lambda)은 "페이지 상한에 닿아 끝까지 받지 못함", 저장소 스냅샷(tools/data, MCP 1,000건 상한)은 집계 코드 그대로 "그 달 행이 1000건 이상".
- 서울 API 의 정렬 순서는 확인하지 못했다. 멈춤 규칙("페이지의 가장 최근 계약일이 그 달 1일보다 앞서면 멈춤")은 계약일 **내림차순**(구마다 한 페이지를 더 받는다)과 계약일이 **섞인 페이지**(접수일 순 등)에는 안전하다. 계약일 **오름차순**이면 첫 페이지부터 지난달 이전이라 바로 멈춰 덜 모은다. 실제 API 를 한 번 불러 순서를 보면 결론이 난다.
