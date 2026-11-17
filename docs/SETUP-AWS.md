# 새 AWS 계정에서 처음부터 배포하기

이 문서는 저장소를 받은 뒤 **아무것도 없는 AWS 계정**에 "서울이 선다"를 올리고, 데이터와 AI 해설까지 채워 발표 가능한 상태로 만드는 전체 절차입니다. 캡스톤 교육 계정이 사라진 뒤 개인 계정에서 다시 올릴 때 이 순서대로 하면 됩니다. 각 단계의 세부 설명은 `infra/README.md`에 있고, 사용법은 `docs/GUIDE.md`에 있습니다.

소요 시간은 처음부터 끝까지 약 40분입니다(배포 5분, 데이터 수집 2분, 해설 생성 15분 포함).

## 0. 준비물

| 항목 | 설명 |
|---|---|
| AWS 계정 | 개인 계정. 관리자 권한(AdministratorAccess) 사용자 또는 역할로 CLI에 로그인돼 있어야 합니다 |
| AWS CLI v2 | `aws sts get-caller-identity`가 계정 ID를 돌려주면 준비된 것입니다 |
| Node.js 24 이상, npm | `node -v` |
| git | 저장소 받기 |
| 서울 열린데이터광장 인증키 | data.seoul.go.kr 회원 가입 후 "인증키 신청"에서 발급(일반 인증키, 즉시 발급). 이 앱의 데이터 출처인 "부동산 실거래가 정보(tbLnOpendataRtmsV)"를 호출합니다. 하루 호출 한도가 있으니 이 앱 전용 키를 쓰는 것이 좋습니다 |
| 발표자 암호 | 영문·숫자 12자 이상, 직접 정합니다(한글 불가) |
| (선택) 웹캠 노트북 | 무대 화면(`#/stage`) 손짓 조작용. 없어도 마우스 모드로 동작합니다 |

리전은 **us-east-1**을 그대로 쓰는 것을 권합니다. Bedrock의 Claude Haiku 인퍼런스 프로파일(`us.anthropic.claude-haiku-5-5`)이 이 리전에서 검증됐고, CloudFront는 전역 서비스라 한국 사용자 체감 차이가 거의 없습니다. 다른 리전을 쓰려면 `infra/bin/app.js`의 `region`을 바꾸고, 그 리전에서 호출 가능한 Bedrock 모델 ID를 배포 때 `-c bedrockModelId=...`로 넘겨야 합니다(5절).

## 1. 저장소 받기와 의존성 설치

```bash
git clone https://github.com/walterpark5193/seoul-ar.git
cd seoul-ar
(cd frontend && npm install)
(cd tools && npm install)
(cd infra && npm install)
```

- `frontend`와 `tools`의 `package.json`에는 네이티브 `canvas` 패키지를 미리 빌드된 `@napi-rs/canvas`로 바꾸는 overrides가 들어 있어 arm64·x64 모두 그대로 설치됩니다.
- 무대 화면의 손 인식 모델은 용량 때문에 git에 없습니다. 루트 `README.md`의 "무대 모델 받기" 명령으로 `frontend/public/models/gesture_recognizer.task`(약 8MB)를 한 번 받습니다. 받지 않아도 배포는 되고, 무대는 마우스 모드로만 동작합니다.

## 2. AWS 자격 증명 확인

```bash
aws sts get-caller-identity
aws configure get region   # 비어 있으면 아래 명령들에 --region us-east-1 을 붙입니다
```

이 계정 ID는 다음 단계의 부트스트랩에 쓰입니다.

## 3. CDK 부트스트랩 (계정·리전당 1회)

```bash
cd infra
npx cdk bootstrap aws://<계정ID>/us-east-1
```

`CDKToolkit` 스택이 만들어집니다. 이미 있으면 그대로 넘어갑니다.

## 4. SSM 파라미터 두 개 만들기

서울 API 키와 발표자 암호는 코드·저장소·브라우저에 들어가지 않고 SSM에만 둡니다. 값은 명령에 직접 넣습니다. 터미널 기록에 남으니 공용 컴퓨터에서는 `history -c`로 지우거나 `read -rs`로 입력받아 쓰세요.

```bash
aws ssm put-parameter --region us-east-1 --name /seoul-ar/seoul-api-key \
  --type SecureString --value "<서울_API_키>"
aws ssm put-parameter --region us-east-1 --name /seoul-ar/presenter-passcode \
  --type SecureString --value "<영문숫자_12자_이상_암호>"
```

둘 다 `"Version": 1`이 출력되면 됩니다. 암호가 12자 미만이면 API가 요청을 거절합니다.

## 5. Bedrock 모델 접근 켜기

AI 해설은 Amazon Bedrock의 Claude Haiku로 만듭니다. 새 계정은 Anthropic 모델 사용 전에 콘솔에서 한 번 접근을 켜야 합니다.

1. AWS 콘솔 → Amazon Bedrock → 왼쪽 메뉴 "Model access"(모델 액세스) → "Modify model access" → Anthropic의 Claude Haiku 계열을 선택하고 사용 목적 양식을 제출합니다. 보통 몇 분 안에 "Access granted"가 됩니다.
2. 확인(아주 작은 호출 한 번, 비용 거의 없음):

```bash
aws bedrock-runtime converse --region us-east-1 \
  --model-id us.anthropic.claude-haiku-5-5 \
  --messages '[{"role":"user","content":[{"text":"숫자 1만 답해."}]}]' \
  --inference-config '{"maxTokens":5}'
```

`"text": "1"`이 들어 있는 응답이 오면 준비된 것입니다. `ValidationException ... inference profile`이 나오면 모델 ID를 프로파일 ID(`us.` 접두)로 쓰고 있는지 확인하고, `AccessDeniedException`이면 1번의 접근 요청이 아직 승인되지 않은 것입니다.

기본 모델 ID는 `us.anthropic.claude-haiku-5-5`로 코드에 들어 있습니다. 다른 모델을 쓰려면 배포 명령에 `-c bedrockModelId=<모델 또는 프로파일 ID>`를 붙입니다.

## 6. 빌드와 배포

```bash
cd frontend && npm run build && cd ..
cd infra && npx cdk deploy --require-approval never --outputs-file cdk-outputs.json
```

- 반드시 `npm run build`를 씁니다(`npx vite build`가 아니라). 빌드 전후에 MediaPipe WASM 복사, 모델 확인, 외부 통계 전송 코드 검사가 함께 돕니다.
- 첫 배포는 CloudFront 생성 때문에 5~7분 걸립니다. 끝나면 출력에 `CloudFrontUrl`(접속 주소), `FetchMonthUrl`, AppSync 엔드포인트가 나오고 `infra/cdk-outputs.json`에 저장됩니다.
- 만들어지는 것: 비공개 S3 버킷 + CloudFront(OAC), AppSync Events API(API 키), Lambda 두 개(API용·작업용), 잠금 상태용 비공개 버킷, 시크릿, 배포 직후 index를 다시 짜는 커스텀 리소스. 자세한 권한 구성은 `infra/README.md` 5절.
- 저장소의 `docs/GUIDE.md`에 적힌 주소는 예전 배포의 것이니, 새 `CloudFrontUrl`로 바꿔 읽으면 됩니다.

배포 직후 확인:

```bash
# 정적 파일과 설정이 올라갔는지
aws s3 ls s3://<BucketName 출력값>/ --region us-east-1
aws s3 cp s3://<BucketName 출력값>/config.json - --region us-east-1
```

브라우저에서 `CloudFrontUrl`을 열면 랜딩이 뜹니다. 이 시점의 데이터는 저장소에 들어 있는 2026년 11월 스냅샷 한 달입니다.

## 7. 데이터 채우기 (연 단위 수집)

작업용 Lambda를 직접 호출해 접수연도별로 한 번에 받습니다. 서울 데이터셋은 2024년 이후만 제공하므로 2024, 2025, 그리고 올해를 받으면 전부입니다. 한 해에 30초 안팎입니다.

```bash
for Y in 2024 2025 2026; do
  aws lambda invoke --region us-east-1 \
    --function-name SeoulArStack-FetchMonthWorker \
    --invocation-type Event \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"action\":\"fetch-year\",\"year\":\"$Y\",\"jobId\":\"year-$Y-$(date +%H%M%S)\",\"resume\":true,\"narrate\":false}" \
    /dev/stdout
  sleep 60
done
```

- 진행과 결과는 `s3://<BucketName>/data/jobs/<jobId>.json`에 남습니다(`state`가 `done`이면 완료).
- 한 번에 한 작업만 돌기 때문에(잠금) 앞 작업이 끝난 뒤 다음 해를 부릅니다. 위 `sleep 60`이 그 간격입니다.
- 서울 API 하루 한도에 걸려 중간에 `error`로 끝나면, 다음 날 같은 명령을 다시 실행합니다. `resume: true`라 이미 받은 구는 건너뜁니다.
- 끝나면 `data/index.json`의 `months`에 모든 달이 들어가고, 호스트 화면을 새로고침하면 월 버튼과 "시간 여행" 구역이 나타납니다.

매달 초에는 지난달 한 달만 받으면 됩니다. 호스트 화면의 "월 가져오기"(발표자 암호 필요)를 쓰거나, 위와 같은 방식으로 `{"action":"fetch-month","month":"YYYYMM","jobId":"..."}`를 호출합니다.

## 8. AI 해설 채우기

달마다 26줄(서울 전체 + 25구)을 Bedrock으로 만듭니다. 한 달에 15~20초, 36개월에 약 12분, 비용은 전체 몇 센트 수준입니다.

```bash
for M in $(aws s3 cp s3://<BucketName>/data/index.json - --region us-east-1 | python3 -c 'import sys,json; print(" ".join(json.load(sys.stdin)["months"]))'); do
  aws lambda invoke --region us-east-1 \
    --function-name SeoulArStack-FetchMonthWorker \
    --invocation-type Event \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"action\":\"narrate\",\"month\":\"$M\",\"jobId\":\"narr-$M-$(date +%H%M%S)\",\"onlyMissing\":true}" \
    /dev/stdout
  sleep 25
done
```

- `onlyMissing: true`는 이미 있는 문장은 두고 빠진 항목만 만듭니다. 몇 번 더 돌려도 비용이 늘지 않습니다.
- 모델 문장이 검증(길이·금지어)에 걸린 항목은 데이터로 조립한 정형 문장이 들어가고 `source`에 `"template"`으로 표시됩니다. 그 항목만 모델 문장으로 다시 만들려면 payload에 `"refreshTemplates":true`를 더해 다시 호출합니다.
- 발표에서 "월 가져오기"로 새 달을 받으면 그 달의 해설은 자동으로 이어서 만들어집니다.

## 9. 발표 전 확인

1. 호스트 화면(`<CloudFrontUrl>/#/host`)을 열고 틀린 암호 → 거절, 맞는 암호 → 통과를 한 번 확인합니다. 10회 틀리면 그 IP는 10분 잠깁니다.
2. `infra/README.md` 8절의 리허설 점검표와 `docs/GUIDE.md`의 순서대로 폰 AR, 3D, 큰 화면, 무대 화면을 한 번씩 돌려 봅니다.
3. 진행 중인 달(이번 달)은 발표 직전에 한 번 더 받아 수치를 최신으로 맞춥니다.

## 10. 비용과 정리

- 발표 수준의 사용에서 비용은 대부분 Lambda·CloudFront·S3·AppSync의 소액과, 해설 생성 때의 Bedrock 호출(1회성)입니다. 무대 해설 음성을 다시 만들 때만 Polly 비용이 추가됩니다(루트 `README.md` "해설 다시 만들기").
- 끝난 뒤 전부 지우기:

```bash
cd infra && npx cdk destroy
aws ssm delete-parameter --region us-east-1 --name /seoul-ar/seoul-api-key
aws ssm delete-parameter --region us-east-1 --name /seoul-ar/presenter-passcode
```

`cdk destroy`는 버킷 안의 객체까지 함께 지웁니다. `CDKToolkit` 부트스트랩 스택은 남겨 두어도 비용이 거의 없습니다. 서울 API 키는 발표가 끝나면 열린데이터광장에서 재발급(폐기)하는 것이 좋습니다.

## 11. 알아 둘 보안·설계 제약

- `config.json`의 AppSync API 키는 설계상 공개됩니다(관객 폰이 구독해야 하므로). 이 키로 발표자 상태 메시지를 발행할 수도 있어서, 주소를 아는 사람이 발표자 상태를 바꿀 수 있습니다. 발표자 암호로 발행을 잠그는 Lambda 권한 부여자는 아직 넣지 않은 알려진 제약입니다.
- 서울 열린데이터광장 API는 HTTPS를 제공하지 않아 키가 평문으로 전달됩니다. 이 앱 전용 키를 쓰고 행사 뒤 폐기하세요.
- 수집·해설 API는 CloudFront 뒤의 Lambda Function URL(OAC)이고 발표자 암호와 IP별 잠금으로 보호됩니다. 자세한 트레이드오프는 `infra/README.md` 2절.

## 12. 문제가 생기면

| 증상 | 확인 |
|---|---|
| `cdk deploy`가 BucketDeployment에서 실패 | 산출물이 50MB라 메모리 1024MB로 잡아 두었습니다. 그래도 실패하면 `frontend/dist`가 `npm run build`로 만들어졌는지(`mediapipe/`, `models/` 포함) 봅니다 |
| 해설 작업이 `error`, 메시지에 접근 거부 | 5절 Bedrock 모델 접근이 켜져 있는지, 모델 ID가 `us.` 프로파일인지 |
| "월 가져오기"가 "연결하지 못했습니다" | 브라우저가 `x-amz-content-sha256` 헤더를 보내야 하므로 HTTPS(CloudFront 주소)로 열었는지, 발표자 암호가 12자 이상인지 |
| 월 버튼에 받은 달이 안 보임 | `data/index.json`을 확인하고, 필요하면 작업용 Lambda에 `{"action":"rebuild-index"}`를 보내 index를 다시 짭니다(배포 때는 자동) |
| 무대가 마우스 모드로만 시작 | `frontend/public/models/gesture_recognizer.task`를 받고 다시 빌드·배포했는지, 노트북에 카메라가 있는지 |
| 수집이 `error`, 메시지에 하루 한도 | 서울 API 키의 일일 호출 한도. 다음 날 `resume: true`로 다시 실행 |
