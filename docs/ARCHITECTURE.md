# 서울이 선다 — 아키텍처

GitHub에서 바로 보이는 Mermaid 그림으로 전체 구조, AWS 서비스 사용, 실시간 동기화, 월 수집·해설 파이프라인, 배포 흐름, 보안 경계를 정리했습니다. 공식 AWS 아이콘으로 그린 레퍼런스 아키텍처 그림은 아래 PNG와 편집용 `docs/seoul-ar-aws-architecture.drawio`(draw.io 또는 app.diagrams.net 에서 열기)입니다.

![서울이 선다 AWS 아키텍처](seoul-ar-aws-architecture.png) 세부 계약은 `docs/CONTRACTS.md`, 배포 절차는 `docs/SETUP-AWS.md`.

## 1. 전체 구조

```mermaid
flowchart LR
  subgraph Users["사용자"]
    Host["발표자 노트북<br/>#/host · #/stage(웹캠) · #/3d?stage=1(프로젝터)"]
    Phone["관객 스마트폰<br/>#/ar(카메라 AR) · #/3d"]
  end

  subgraph AWS["AWS us-east-1"]
    CF["Amazon CloudFront<br/>정적 사이트(OAC) · /api/* → Lambda URL(OAC)"]
    S3["S3 site bucket (비공개)<br/>앱 번들 · MediaPipe wasm · 손 인식 모델 · 마커 · 음성<br/>data/{월}/{구}.json · index.json · narration.json · jobs/"]
    EV["AppSync Events API (API 키)<br/>/seoul/state · /seoul/jobs · /seoul/stage"]
    API["Lambda FetchMonth API (Node 22)<br/>월 검증 · 발표자 암호 · IP 잠금 · 202"]
    WK["Lambda FetchMonth Worker (Node 22, 600s)<br/>수집 · 집계 · 쓰기 · 무효화 · 해설 · 발행"]
    SSM["SSM Parameter Store<br/>/seoul-ar/seoul-api-key · /seoul-ar/presenter-passcode"]
    SM["Secrets Manager<br/>잠금 키 HMAC 시크릿"]
    AUTH["S3 auth-state bucket (비공개)<br/>IP별 실패 횟수"]
    BR["Amazon Bedrock<br/>us.anthropic.claude-haiku-5-5"]
  end

  SEOUL["서울 열린데이터광장 Open API<br/>부동산 실거래가 (HTTP, 8088)"]

  Host -- "앱·데이터 읽기" --> CF
  Phone -- "앱·데이터 읽기" --> CF
  CF -- "OAC" --> S3
  Host -- "상태 발행 (month·gu·metric)" --> EV
  EV -- "구독 · 1초 내 반영" --> Phone
  Host -- "POST /api/fetch-month · /api/narrate-month<br/>x-presenter-key · x-amz-content-sha256" --> CF
  CF -- "SigV4 OAC" --> API
  API --> SSM
  API --> SM
  API --> AUTH
  API -- "비동기 호출 {jobId, month}" --> WK
  WK -- "접수연도·자치구별 1000건 페이지" --> SEOUL
  WK -- "data/{월}/{구}.json · index.json · jobs/" --> S3
  WK -- "무효화 /data/*" --> CF
  WK -- "26줄 해설 (Converse)" --> BR
  WK -- "진행·완료 이벤트 /seoul/jobs" --> EV
  WK --> SSM
```

## 2. AWS 서비스별 역할

| 서비스 | 역할 | 설정 요점 |
|---|---|---|
| Amazon CloudFront | 유일한 공개 진입점. 정적 사이트와 `/api/*` 두 동작 | S3·Lambda URL 모두 OAC, 403/404 → index.html, HTTPS 강제, HTTP/2·3 |
| Amazon S3 (site) | 앱 번들, 데이터 JSON, 해설, 작업 기록 저장 | 퍼블릭 차단, SSE-S3, 모든 객체 `Cache-Control: no-cache` |
| AWS AppSync Events | 발표자 → 관객 실시간 채널, 작업 진행 채널, 무대 채널 | API 키 인증(90일), 네임스페이스 `seoul` |
| AWS Lambda (API) | 암호·잠금 검사 후 작업 시작 | Function URL AWS_IAM + CloudFront OAC, 15초, 256MB |
| AWS Lambda (Worker) | 서울 API 수집·집계, S3 쓰기, 무효화, Bedrock 해설, 이벤트 발행, 연 단위 수집, index 재구성 | 600초, 512MB, 구 4개 병렬, 데드라인 가드 |
| Amazon Bedrock | 월·구별 한 줄 해설 생성 | 인퍼런스 프로파일 `us.anthropic.claude-haiku-5-5`, 작업당 호출 ≤ 30 |
| SSM Parameter Store | 서울 API 키, 발표자 암호 | SecureString, 사용자가 직접 생성, 코드·저장소에 값 없음 |
| AWS Secrets Manager | IP 잠금 기록 키용 랜덤 시크릿 | CDK가 생성, API Lambda만 읽기 |
| Amazon S3 (auth-state) | 암호 실패 횟수(IP 해시별) | 비공개, 1일 만료, ETag 조건부 쓰기로 원자적 증가 |
| AWS CDK / CloudFormation | 위 전부를 스택 하나로 배포 | 사이트·데이터 시드 두 BucketDeployment, 배포마다 `rebuild-index` 호출 |

## 3. 실시간 동기화 (발표자 → 관객)

```mermaid
sequenceDiagram
  participant H as 발표자 호스트(#/host)
  participant EV as AppSync Events /seoul/state
  participant P as 관객 폰(#/ar · #/3d)
  participant CF as CloudFront/S3 data

  H->>EV: publish {v:1,type:"state",month,gu,metric,ts}
  Note over H,EV: 변경마다 발행 + 10초 하트비트
  EV-->>P: 구독 전달 (API 키)
  P->>P: 검증: ts 미래 30초 이내 · month∈index · gu∈index
  alt 모르는 월
    P->>CF: index.json 재로딩 (no-store, 30초 1회 제한)
  end
  P->>CF: data/{month}/{gu}.json (캐시)
  P->>P: 씬 focus/morph · 시트 갱신
  Note over P: 직접 조작 시 follow=false, "라이브로 돌아가기"로 복귀
```

## 4. 월 수집과 AI 해설 파이프라인

```mermaid
sequenceDiagram
  participant H as 호스트 "월 가져오기"
  participant CF as CloudFront /api/*
  participant API as Lambda API
  participant S as SSM · Secrets · auth-state S3
  participant W as Lambda Worker
  participant SEOUL as 서울 Open API
  participant S3 as S3 site (data/)
  participant BR as Bedrock Haiku
  participant EV as AppSync /seoul/jobs

  H->>CF: POST /api/fetch-month {month} + x-presenter-key + x-amz-content-sha256
  CF->>API: SigV4(OAC)
  API->>S: 암호 읽기(캐시 60초) · IP 잠금 확인(10회/10분)
  API->>S3: jobs/{jobId}.json running 0/25 · 잠금
  API-->>H: 202 {jobId, month}
  API->>W: 비동기 Invoke {jobId, month}
  loop 25개 자치구 (4 병렬)
    W->>SEOUL: RCPT_YR·CGG_NM 페이지(1000건) · 최신 CTRT_DAY가 월 이전이면 중단
    W->>S3: data/{month}/{구}.json
    W->>EV: running done/25 · gu
  end
  W->>S3: index.json 병합 · 잠금 해제
  W->>CF: 무효화 /data/*
  W->>EV: done (캡 걸린 구 · 11·12월 고지)
  H->>S3: jobs/{jobId}.json 로 done 확인 → index 재로딩 → 월 버튼 추가
  W->>W: 자동 해설 작업 {jobId}-narration (잠금)
  W->>BR: 26줄 JSON 요청 → 검증(길이·금지어) → 실패 항목 재시도 → 정형 문장 폴백
  W->>S3: data/{month}/narration.json (source: model|template)
  W->>EV: kind:"narration" running/done
  H->>H: "해설 생성 중 n/26" → 완료 시 해설 재로딩
```

연 단위 수집(`fetch-year`)은 운영자가 Worker를 직접 호출하며, 구마다 접수연도 전체를 한 번 넘겨 계약월별로 나눠 저장합니다(월 단위보다 API 호출 1/6).

## 5. 배포 흐름 (CDK)

```mermaid
flowchart LR
  Dev["개발자 PC / GitHub<br/>npm run build → frontend/dist"] --> CDK["cdk deploy<br/>SeoulArStack"]
  CDK --> CFN["CloudFormation"]
  CFN --> D1["BucketDeployment (site)<br/>dist 전체, data/* 제외, prune"]
  CFN --> D2["BucketDeployment (seed)<br/>dist/data → data/, prune 없음"]
  CFN --> CR["AwsCustomResource<br/>Worker rebuild-index 호출"]
  D1 --> S3["S3 site bucket"]
  D2 --> S3
  CR --> WK["Lambda Worker"] --> S3
  D1 -. "/* 무효화" .-> CF["CloudFront"]
  CFN --> CFG["config.json 생성<br/>appUrl · AppSync 엔드포인트·키"]
  CFG --> S3
```

배포가 Lambda가 써 둔 달을 지우지 않게 사이트 동기화는 `data/*`를 건드리지 않고, 시드는 덮어쓰기만 하며, 배포 직후 S3에 있는 모든 달로 index를 다시 짭니다.

## 6. 보안 경계

| 경계 | 통제 | 알려진 제약 |
|---|---|---|
| 공개 인터넷 → CloudFront | HTTPS만, OAC로 S3·Lambda 직접 접근 차단 | — |
| 브라우저 → AppSync | API 키(설계상 공개, `config.json`) | 키로 발행도 가능해 주소를 아는 사람이 발표자 상태를 바꿀 수 있음. 폰은 ts·month·gu 검증과 작업 기록 확인으로 위조 영향 축소. 발행 잠금(Lambda 권한 부여자)은 미구현 |
| 호스트 → `/api/*` | 발표자 암호(12자 이상 강제), IP별 10회/10분 잠금(원자적), 본문 SHA-256 헤더, 코드별 한국어 사유 응답 | 공유 Wi-Fi에서는 관객이 발표자 IP를 잠글 수 있음(핫스팟 권고) |
| Worker → 서울 Open API | 키는 SSM에만, 로그·오류 메시지에 URL·키 미포함 | API가 HTTPS 미제공(평문 전송). 전용 키 사용·행사 뒤 폐기 |
| Worker → Bedrock | IAM을 프로파일·모델 ARN으로 한정, 작업당 호출 상한 | — |
| 데이터 | 법정동까지만, 본번·부번·건물명·행 단위 데이터 미포함(테스트로 강제) | — |
| 카메라·손 인식 | 브라우저 안에서만 처리, 외부 전송 없음, MediaPipe 통계 송신 코드 빌드 검사 | — |

## 7. 프론트엔드 구성

```mermaid
flowchart TB
  main["main.ts<br/>config · realtime · index · 라우터"] --> R{"해시 라우트"}
  R --> L["#/ 랜딩"]
  R --> AR["#/ar AR 뷰<br/>MindAR 세션(안정화·고정·회전)"]
  R --> D3["#/3d 3D 뷰<br/>OrbitControls · ?stage=1 큰 화면"]
  R --> HO["#/host 호스트<br/>월·구·지표 · 시간 여행 · 월 가져오기 · 해설 생성"]
  R --> ST["#/stage 무대<br/>MediaPipe 손짓 · 마우스 모드 · 투표 · 음성"]
  AR --> SC["scene/ 서울 씬<br/>25구 돌출 · 법정동 막대 · 보간"]
  D3 --> SC
  ST --> SC
  AR --> SH["ui/ 바텀시트(접힘·펼침) · 토스트"]
  D3 --> SH
  main --> RT["realtime/ AppSync events · mock · fallback"]
  main --> DT["data/ 로더 · 해설 · fetchMonth(sha256)"]
  main --> STT["state/ 리듀서 · remote 가드"]
```
