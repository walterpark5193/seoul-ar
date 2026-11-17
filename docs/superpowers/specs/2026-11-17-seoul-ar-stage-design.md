# 손짓으로 들어올리는 서울 (seoul-ar `#/stage`) 설계

2026-11-17. 대상: `seoul-ar` 저장소에 새 라우트 `#/stage` 추가. 작업 공간: 워크트리 `~/claude-lab/seoul-ar-stage`, 브랜치 `feat/stage` (main 2469af7에서 분기). 본체 설계: `docs/superpowers/specs/2026-11-17-seoul-ar-design.md`, 본체 계약: `docs/CONTRACTS.md`.

사용자 결정: 아이디어 목록의 B "손짓으로 들어올리는 서울"을 seoul-ar의 `#/stage`로 넣는다. 관객은 3명으로 가정하고, 카메라에는 발표자 손만 보여 준다. 실행은 "가능한 모든 서브에이전트, 최소 20개, 최대 병렬".

## 1. 의도와 이유

발표자가 프로젝터에 `#/stage`를 띄우고 노트북 웹캠 앞에서 손을 움직인다. 허공의 손바닥이 화면 위 커서가 되고, 손을 오므리면 커서 아래 구(예: 강남구)가 들려 올라오며 법정동 막대가 자라고 서연 목소리가 그 구를 소개한다. 두 손을 펴 보이면 25개 구가 지도에서 떠나 ㎡당 가격순으로 한 줄로 늘어선다. "보고 싶은 구 손 들어 주세요" 하면 카메라가 든 손의 개수를 세어 후보 셋 중 하나를 뽑는다. 관객 폰(`#/ar`, `#/3d`)도 같은 장면을 따라간다.

왜: 화면을 만지지 않고 손짓만으로 도시가 움직이는 장면은 설명 없이 전달되는 와우다. 손 인식이 브라우저 안에서만 돌고 숫자만 나간다는 점이 "개인정보 걱정 없는 AI"라는 캡스톤 서사가 된다. 본체가 이미 가진 3D 서울, 실거래 스냅샷, AppSync Events 채널을 재사용하므로 새 AWS 런타임 자원이 없다.

## 2. 목표, 비목표, 실패 조건

목표
- `#/stage`: 프로젝터용 전체 화면. 3D 서울이 화면 대부분, 오른쪽 아래 작은 웹캠 미리보기(거울 모드, 손 골격 오버레이, 키로 숨김), 아래 가운데 자막, 위에 모드 표시.
- 손 조작(MediaPipe GestureRecognizer, 브라우저 안 추론):
  - 커서: 손바닥 중심을 화면 좌표로 옮긴 커서. 커서 아래 구가 밝아진다(hover).
  - 주먹(`Closed_Fist`): 커서 아래 구를 들어올린다. 쥐고 있는 동안 그 구가 높이 떠 있고, 놓으면 본체의 focus 상태(상승 + 법정동 막대)로 내려앉는다. 해설 재생.
  - 두 손 펴기(두 손 모두 `Open_Palm`, 사용자 결정): 25개 구가 가격순 정렬 배치로 펼쳐진다. 다시 두 손을 펴면 지도로 돌아온다. 한 손을 편 것은 커서 이동일 뿐 아무것도 켜지 않는다. 정렬 상태에서 주먹을 쥐면 커서 아래 구가 들어올려지고, 놓으면 지도로 돌아가 focus.
  - 브이(`Victory`): 전체 보기(focus 해제, 지도 배치).
- 투표: 발표자가 `V` 키 또는 화면 버튼으로 시작. 후보 3곳을 하나씩 5초 동안 띄우고 그동안 카메라에 보이는 손 개수를 센다(상한 6손 = 관객 3명 × 2). 결과를 막대와 숫자로 보여 주고 최다 득표 구를 들어올려 해설한다. 투표 중에는 제스처 조작이 꺼진다.
  - 사용자 결정: 카메라에는 발표자 손만 비춘다. 데모에서는 발표자가 손 0~2개를 들어 관객 3명의 표를 대신 보여 준다(관객이 노트북 앞으로 오지 않음, 앉은 관객의 손은 세지 않음). 숫자키 `0`~`6` 입력이 같은 자격의 예비 경로다.
  - 개수 직접 선택(사용자 요청): 카메라가 잘못 세거나 카메라가 없을 때를 위해 발표자가 각 후보의 손 개수를 직접 고를 수 있다.
    - 투표 패널의 후보 줄마다 `0`~`6` 선택 버튼(클릭·터치). 카메라 값을 언제든 덮어쓰고, 직접 고른 값에는 "직접" 표시가 붙는다. 키보드 숫자키도 같다.
    - 투표 입력 방식 두 가지: "카메라"와 "직접 선택". 카메라 거부·없음·모델 실패·마우스 모드면 자동으로 "직접 선택". 패널 토글이나 `N` 키로 언제든 바꾼다.
    - "직접 선택" 방식은 타이머가 없다. 후보 안내 뒤 개수를 고를 때까지 기다리고, 고르면 1초 뒤 다음 후보로 간다.
    - "카메라" 방식에서 5초 동안 안정된 손 개수가 한 번도 안 잡히면(인식 실패) 0표로 넘기지 않는다. 타이머를 멈추고 "손이 인식되지 않았어요 · 개수를 골라 주세요"를 띄워 선택을 기다린다.
    - 결과 확정 전 검토: 세 후보를 다 센 뒤 "집계 확인" 3초. 이 동안 어느 줄이든 개수를 고칠 수 있고, 고치면 자동 확정이 멈춰 `Enter` 또는 "확정" 버튼을 기다린다. 확정해야 승자 결정·해설·publish가 일어난다.
- 웹캠 미리보기: 기본은 거울 영상 + 손 골격(발표자 손만 비추므로). `C` 키로 "영상+골격 → 골격만 → 숨김" 순환. 어느 경우든 영상은 로컬 화면에만 그린다. 내 결정.
- 해설(설계 결정 A, 미리 생성): 빌드 전에 Bedrock이 25개 구 × 3개월 해설 문장을 데이터 사실만으로 쓰고, 템플릿 문장(투표 안내, 득표 결과, 펼치기 소개 등)과 함께 Polly 서연으로 MP3를 만들어 정적 파일로 싣는다. 무대에서는 재생만 한다. 재생 중 자막을 같이 보인다.
- 마우스·키보드 폴백: 카메라 거부, 모델 파일 없음, wasm 로드 실패 시 자동으로 마우스 모드로 바꾸고 토스트. 언제든 키로 전환 가능.
- 실시간: 들어올림·focus는 본체 `/seoul/state` 메시지로 publish(폰이 그대로 따라감). 펼치기 모드와 투표 집계는 새 채널 `/seoul/stage`로 publish. 폰은 펼치기를 따라가고 투표 결과를 바텀시트에 짧게 보인다.
- 리허설 도구: 화면 구석의 진단 표시(인식 FPS, 손 개수, 현재 제스처와 점수, 커서 좌표)를 `D` 키로 켠다.

비목표
- 실시간 해설 생성(Lambda), 관객 폰 투표, 여러 사람 동시 조작, 손 추적 정확도 튜닝 UI, 카메라 영상 저장·전송, 원거리 군중 손 세기.
- 본체 `#/host` 변경. `#/stage`는 호스트와 같은 publish 권한을 쓰는 별도 화면이다.

실패 조건
- 카메라 프레임, 손 좌표, 골격이 네트워크로 나간다. 나가는 것은 상태 메시지와 집계 숫자뿐이어야 한다(테스트가 publish 페이로드 키를 검사).
- 외부 CDN에서 wasm·모델을 받는다. 전부 같은 출처(`/mediapipe/wasm/`, `/models/`)에서 로드.
- 카메라나 모델이 없을 때 빈 화면이나 멈춘 화면. 반드시 마우스 모드로 떨어진다.
- 해설 문장에 데이터에 없는 숫자, 건물명, 본번·부번이 들어간다.
- 오인식으로 장면이 마구 바뀐다(제스처 확정 조건과 쿨다운이 없음).
- 전형적인 AI 생성 화면 티(카드 남발, 같은 그림자, ALL CAPS, 섹션 페이드인). 본체 디자인 규칙 그대로.

## 3. 제약

- 본체 제약 전부 계승: us-east-1, 외부 CDN·폰트 금지, 데이터 규칙(만원·㎡·법정동까지), Bash 명령문에 URL 금지(세션 가드), 이 머신에 브라우저 없음.
- 다른 세션이 main에서 본체 Task 1, 3, 4, 5를 병렬 구현 중이다(06:58 기준 Task 2, 6 완료). 이 작업은 워크트리 `feat/stage`에서 하고, 본체 파일을 고쳐야 하는 부분은 본체 해당 Task가 main에 커밋된 뒤 rebase해서 진행한다. 병합은 본체 Task 7(통합·배포) 전후로 사용자와 맞춘다.
- 본체 컨트롤러가 배포 직후 Task 8(Lambda 권한 부여자 + 발표자 암호)로 publish를 잠글 예정이다. `#/stage`는 publish를 본체 `RealtimeClient` 하나로만 하므로 Task 8이 들어오면 같은 경로로 따라간다. 이 작업이 권한 체계를 따로 만들지 않는다.
- MediaPipe: `@mediapipe/tasks-vision` 0.10.35(npm, wasm 포함. 최종 리뷰에서 1.x가 실행 중 Google로 사용 통계를 보내는 것이 확인되어 고정, 계약 11절). 모델 `gesture_recognizer.task`(float16)는 npm에 없어 사용자가 `frontend/public/models/gesture_recognizer.task`에 직접 내려받는다(git 제외, README에 받는 법). wasm은 빌드 전에 `node_modules`에서 `frontend/public/mediapipe/wasm/`으로 복사(git 제외).
- 확인됨(2026-11-17): Bedrock `global.anthropic.claude-sonnet-5-5` Converse 호출 가능(응답 첫 블록이 reasoningContent이므로 text 블록을 골라야 함). Polly `Seoyeon` neural·generative 모두 ko-KR MP3 합성 가능. 자격 증명은 이 EC2 인스턴스 역할.
- 브라우저 오토플레이와 카메라 권한: 첫 화면에 "무대 시작" 버튼을 두고, 그 클릭 안에서 카메라 시작과 오디오 잠금 해제를 한다.

## 4. 검토한 접근

### 4.1 해설 생성 시점 (사용자 결정 대기 후 A로 진행, 바꾸려면 승인 때 말씀)

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A. 미리 생성 | 빌드 전 Bedrock 문장 + Polly MP3를 정적 파일로 | 지연 0, 네트워크 무관, 브라우저에 AWS 자격 증명 없음, 한 번 수 센트 | 투표 결과 문장은 조합된 클립 |
| B. 실시간 생성 | 투표 종료 시 Lambda가 Bedrock+Polly 호출 | 매번 다른 자연스러운 문장 | Lambda·함수 URL·보호 장치 추가, 2~4초 침묵, 실패 지점 추가 |
| C. 혼합 | A 기본, B가 3초 안에 오면 교체 | 가장 화려 | 작업량 최대 |

선택: **A**. 관객 3명, 발표자 손만 쓰는 통제된 데모라 경우의 수(구 25 × 득표 0~6)가 작아 전부 미리 만들 수 있고, 사용자가 꼽은 현장 리스크를 하나 줄인다. 내 추천, 사용자 확인 대기.

### 4.2 손 인식 모델

| 안 | 내용 | 판정 |
|---|---|---|
| GestureRecognizer | 손 랜드마크 + 기본 제스처 7종(`Closed_Fist`, `Open_Palm`, `Victory` 등) | **선택**. 오므리기·펼치기를 학습 없이 바로 씀 |
| HandLandmarker + 직접 규칙 | 손가락 굽힘 각도로 판정 | 제스처 규칙과 튜닝을 직접 해야 함. GestureRecognizer가 랜드마크도 주므로 필요 없음 |
| PoseLandmarker로 손 든 사람 세기 | 사람 단위 | 관객 3명·발표자 손만이라 과함. 비목표 |

### 4.3 커서와 구 선택

| 안 | 내용 | 판정 |
|---|---|---|
| 손바닥 커서 + 레이캐스트 | 커서 화면 좌표로 three 레이캐스트, 맞은 구가 대상 | **선택**. 손 위치가 곧 선택이라 장면이 직관적 |
| 손 좌우 스와이프로 구 순회 | 선택이 순서대로 넘어감 | 25개를 넘기기 느리고 와우가 약함 |

### 4.4 펼치기 손짓 (사용자 결정)

| 안 | 내용 | 판정 |
|---|---|---|
| 두 손 펴기 | 한 손은 커서와 주먹 전용, 두 손 모두 펴 보이면 펼치기 토글 | **선택(사용자)**. 커서 자세(한 손 편 상태)와 주먹 놓기와 충돌 없음, 무대에서 크게 보임 |
| 주먹을 펴는 순간 | 쥐면 들어올림, 펴면 펼치기 | 들어올린 뒤 항상 펼치기로 넘어가 한 구에 머무는 장면이 어려움 |
| 편 손 1초 정지 | 한 손으로 전부 | 설명 중 손을 멈추면 실수로 켜짐, 1초 대기 |

### 4.5 펼치기와 투표의 실시간 전달

| 안 | 내용 | 판정 |
|---|---|---|
| 새 채널 `/seoul/stage` + 새 메시지 타입 | 본체 `StateMessage`는 그대로 | **선택**. 본체 계약을 안 깨고, 구버전 뷰어는 무시 |
| `StateMessage`에 필드 추가 | `mode`, `vote` 필드 | 본체 `isStateMessage`·reduce와 병렬 작업 중인 Task 4를 흔든다 |

## 5. 설계

### 5.1 화면

```
┌──────────────────────────── #/stage (프로젝터 16:9) ─────────────────────────────┐
│ 서울이 선다 · 무대                 2026년 11월 · ㎡당 가격      ● 실시간 연결     │
│                                                                                 │
│                  ╭───────╮                                                      │
│                  │ 강남구 │ ← 주먹으로 들어올린 구(높이 뜸, 그림자)              │
│        ▢▢▢▢▢     ╰───────╯                                                      │
│      ▢▢▢▢▢▢▢   ✋ ← 손바닥 커서(원형 링, 주먹이면 채워짐)                         │
│       ▢▢▢▢▢▢                                                                    │
│                                                         ┌──────────────┐        │
│   "강남구는 이번 달 ㎡당 2,890만 원으로 1위입니다."        │ 웹캠(거울)    │        │
│              ↑ 자막(해설 재생 중)                        │ 손 골격       │        │
│                                                         └──────────────┘        │
│ 주먹: 들어올리기   두 손 펴기: 가격순 펼치기   브이: 전체 보기   V: 투표   M: 음소거 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

투표 중:

```
│        강남구 보고 싶은 분, 손 들어 주세요            ◔ 3초                     │
│                                                                                 │
│   강남구  ███████████  2손 카메라      0  1 [2] 3  4  5  6                         │
│   마포구  ░░░░░░░░░░░  —   (대기)                                                │
│   노원구  ░░░░░░░░░░░  —   (대기)                                                │
│                                              입력: [카메라] 직접 선택   (N)       │
```

인식 실패 또는 직접 선택 방식:

```
│        마포구 보고 싶은 분, 손 들어 주세요       손이 인식되지 않았어요 · 개수를 골라 주세요 │
│   강남구  ███████████  2손 카메라      0  1 [2] 3  4  5  6                         │
│   마포구  ░░░░░░░░░░░  ?               0  1  2  3  4  5  6   ← 여기서 선택(숫자키 가능) │
│   노원구  ░░░░░░░░░░░  —   (대기)                                                │
```

집계 확인(3초, 고치면 멈춤):

```
│                 집계 확인 · 고칠 곳이 있으면 개수를 누르세요      [확정 Enter] ◔ 2초 │
│   강남구  ███████████  2손 카메라      0  1 [2] 3  4  5  6                         │
│   마포구  ██████░░░░░  1손 직접        0 [1] 2  3  4  5  6                         │
│   노원구  ░░░░░░░░░░░  0손 카메라     [0] 1  2  3  4  5  6                         │
```

- 진입: "무대 시작" 버튼 한 개(카메라·오디오 권한). 옆에 "마우스로 시작" 작은 링크.
- 하단 안내 줄은 조작법을 항상 보여 준다(리허설과 관객 이해용). `H` 키로 숨김.
- 진단 표시(`D`): FPS, 손 개수, 상위 제스처와 점수, 커서 좌표, 모델 로드 시간.
- 손 미리보기 오버레이와 골격 그리기는 로컬 캔버스에서만 한다.

### 5.2 손 인식 파이프라인 (`frontend/src/stage/hands/`)

- 로더: `FilesetResolver.forVisionTasks("/mediapipe/wasm")`, `GestureRecognizer.createFromOptions({ baseOptions: { modelAssetPath: "/models/gesture_recognizer.task", delegate: "GPU" }, runningMode: "VIDEO", numHands: 6 })`. GPU 실패 시 CPU로 재시도. 둘 다 실패하면 마우스 모드.
- 프레임 루프: `requestVideoFrameCallback`(없으면 rAF)에서 `recognizeForVideo(video, now)`. 결과를 순수 데이터 `HandFrame { t, hands: { landmarks: [x,y,z][], gesture: string, score: number, handedness: string }[] }`로 바꿔 아래 순수 모듈에 넘긴다. 순수 모듈은 MediaPipe를 import하지 않아 vitest로 시험한다.
- 주 조작 손: 여러 손이 보이면 직전에 추적하던 손(손목 위치 최근접), 없으면 가장 큰 손(손바닥 폭).
- 커서: 손바닥 중심 = 랜드마크 0, 5, 9, 13, 17 평균. 거울 모드이므로 x는 `1 - x`. 카메라 가장자리 10%는 화면 끝에 닿도록 확대 매핑. 떨림은 One Euro 필터(minCutoff 1.0, beta 0.02 시작값, 빌더가 조정)로 거른다.
- 제스처 확정(`gestureMachine`): 같은 제스처가 점수 0.6 이상으로 연속 6프레임(약 200ms) 유지되면 확정 이벤트. 확정 후 800ms 쿨다운. `Closed_Fist`는 시작(`grab`)과 끝(`release`) 두 이벤트, `Victory`는 한 번(`victory`). `None`이나 손 없음이 300ms 이상이면 `release`. 두 손 펴기(`spread`): 손이 정확히 2개이고 둘 다 `Open_Palm` 0.6 이상이 연속 6프레임이면 한 번. 한 손 `Open_Palm`은 이벤트를 내지 않는다(커서 자세). 주먹을 쥔 동안(lifted)에는 `spread`를 무시해, 들고 있는 구를 다른 손으로 펼쳐 버리는 일을 막는다. 두 손이 보이는 동안 커서는 직전 추적 손을 따른다.
- 투표 손 세기(`voteCounter`): 후보 창 5초 동안 프레임별 손 개수를 받고, 같은 개수가 500ms 이상 이어진 구간 중 최댓값을 그 후보의 표로 한다(순간 오검출 제거). 상한 6.

### 5.3 무대 상태 (`frontend/src/stage/stageState.ts`, 순수 리듀서)

```
StageState { mode: "map" | "spread"; hover: gu|null; lifted: gu|null; focus: gu|null;
             input: "hands" | "mouse"; vote: VoteState|null; month; metric }
VoteState  { candidates: [gu, gu, gu]; index: 0..2;
             phase: "prompt" | "counting" | "awaitManual" | "review" | "result";
             method: "camera" | "manual";
             counts: (number|null)[]; sources: ("camera" | "manual" | null)[];
             reviewEdited: boolean; winner: gu|null; endsAt: number|null }
```

- 이벤트: `hover(gu)`, `grab`, `release`, `spread`, `victory`, `voteStart(candidates)`, `voteTick(now, handCount)`, `voteSet(index, n)`, `voteMethod(method)`, `voteConfirm`, `voteCancel`, `setInput`, `month`, `metric`.
- 규칙: `grab` → `lifted = hover`(hover 없으면 무시). `release` → `focus = lifted, lifted = null, mode = "map"`. `spread` → mode 토글(map ↔ spread). `victory` → `focus = null, lifted = null, mode = "map"`. 투표 중에는 grab·spread·victory 무시.
- 투표 진행: 후보마다 prompt(1.5초, 안내 음성) → counting(카메라 방식 5초, 직접 선택 방식은 `voteSet`까지 대기) → 다음 후보. 카메라 방식에서 창이 끝났는데 `voteCounter` 값이 null이면 `awaitManual`(타이머 멈춤, `voteSet` 대기). 세 후보가 끝나면 review(3초, `voteSet`이 오면 `reviewEdited = true`로 자동 확정 정지, `voteConfirm` 대기). 확정되면 result: 최다 득표 구가 winner, 동점이면 후보 순서상 앞선 구, 전원 0표면 winner = 첫 후보이고 "아무도 손을 들지 않아 ○○구로 갑니다" 클립. result 후 winner를 focus로.
- `voteSet(index, n)`: n은 0~6 정수만. 이미 지난 후보와 현재 후보는 언제든, 아직 안 온 후보는 review에서만 받는다. 직접 값은 같은 후보의 이후 카메라 값보다 우선(`sources[index] = "manual"`). `input`이 mouse로 바뀌거나 카메라 로드가 실패하면 `method = "manual"`.
- 기본 후보: 현재 월 ㎡당 중앙값 1위, 13위, 25위 구(비싼 곳·중간·싼 곳). URL `#/stage?vote=강남구,마포구,노원구`로 바꿀 수 있다. 잘못된 이름은 무시하고 기본값으로 채운다.
- 상태가 바뀌면 출력 효과 세 가지로 나간다: 씬 명령, 해설 큐, publish. 효과 계산은 `diffEffects(prev, next) → Effect[]` 순수 함수.

### 5.4 마우스·키보드 폴백 (`frontend/src/stage/mouseInput.ts`)

- 마우스 이동 = 커서(hover). 누르고 있기 = 주먹(grab/release). 스페이스 = 두 손 펴기(spread). `Esc` = 브이(victory).
- 투표 중 숫자키 `0`~`6` = 현재 후보(review에서는 선택된 줄, `↑`/`↓`로 이동)의 손 개수 직접 선택. 패널의 숫자 버튼 클릭과 같다. `N` = 투표 입력 방식(카메라 ↔ 직접 선택). `Enter` = 집계 확정.
- `G` = 손 모드 ↔ 마우스 모드 전환. `V` = 투표 시작/취소. `M` = 음소거. `C` = 웹캠 미리보기 숨김. `D` = 진단. `H` = 안내 줄 숨김. `←`/`→` = 월, `P` = 가격·건수 지표 전환.
- 손 모드에서도 마우스와 키는 항상 살아 있다(발표 중 비상 조작).

### 5.5 3D 씬 확장 (본체 `frontend/src/scene/`, 본체 Task 3 커밋 후)

본체 `SeoulScene`에 메서드를 더한다. 계약 변경은 `docs/CONTRACTS-stage.md`에 적고, 본체 계약서에는 한 줄 참조만 단다.

```ts
setHover(gu: string | null): void;              // 테두리 밝게 + 살짝 상승(y 0.01)
lift(gu: string | null): void;                  // y 0.12까지 상승, 아래 그림자 원판, 다른 구 어둡게. null이면 내려놓음
setLayout(mode: "map" | "spread", summary: Record<string, Stat>, metric: Metric): void; // 0.8초 보간
pick(ndcX: number, ndcY: number, camera: Camera): string | null; // 레이캐스트로 구 이름
```

- 펼치기 배치(`spreadLayout(summary, metric) → { gu, x, z, height, rank }[]`, 순수 함수): 지표 내림차순(값 없는 구는 뒤), 왼쪽에서 오른쪽으로 25개를 완만한 호(반지름 0.9, 각도 ±50°)에 놓는다. 구 모양은 유지하고 각 구를 해당 위치로 옮기며, 높이를 지표에 비례해 기둥처럼 키운다(0.02~0.30). 순위 숫자와 구 이름 라벨.
- 무대 카메라: 원근 카메라, 지도 모드는 위에서 55° 내려다봄, 펼치기 모드는 정면에 가깝게 25° 로 0.8초 이동. 자동 회전 없음(발표자가 조작). reduced-motion이면 보간 없이 즉시.

### 5.6 해설 (`tools/narration/`, `frontend/public/narration/`, `frontend/src/stage/narrator.ts`)

생성 도구(Node 24, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-polly`, 인스턴스 역할):

- `facts.mjs`: 본체 데이터(`frontend/public/data/index.json`, `{yyyymm}/{gu}.json`)에서 구·월별 사실표를 만든다. `{ gu, month, n, medPerM2, rankPrice(1~25), maxAmt, topDong, topDongMedPerM2, cancelled }`. 순수 함수, 테스트 대상.
- `write.mjs`: 사실표마다 Bedrock(`global.anthropic.claude-sonnet-5-5`, Converse, text 블록 선택) 호출. 규칙: 한국어 존댓말, 두 문장, 90자 이내, 사실표의 숫자만 사용, 건물명·지번 금지, 과장·투자 권유 금지. 출력은 `{ caption, speech }` 두 형태(자막용 "2,890만 원", 낭독용 "2천8백90만 원"). 검증기 `validateScript(facts, script)`: 길이, 금지어, caption 속 숫자가 모두 사실표 숫자(만원·억 환산 포함)에 있는지. 실패하면 2회 재시도, 그래도 실패면 템플릿 문장으로 대체하고 보고. 결과 `tools/narration/scripts.json`(커밋, 사람이 읽고 고칠 수 있음).
- 템플릿 문장(Bedrock 없이 결정적): 무대 시작 인사, 펼치기 소개("25개 구를 ㎡당 가격순으로 펼쳤습니다. 왼쪽이 가장 비쌉니다."), 지도로 돌아가기, 투표 안내 `vote-prompt-{gu}`("{gu} 보고 싶은 분, 손 들어 주세요."), 득표 결과 `vote-result-{gu}-{n}`(n 0~6, "{n}표로 {gu}가 뽑혔습니다."), 전원 0표 `vote-none-{gu}`.
- `synth.mjs`: 각 문장을 Polly `Seoyeon` generative(실패 시 neural)로 MP3 합성, `frontend/public/narration/{month}/{id}.mp3`와 `frontend/public/narration/manifest.json` `{ v:1, voice, engine, items: { [id]: { file, caption, ms? } } }`. 이미 같은 문장으로 만든 파일은 건너뛴다(문장 해시 캐시). MP3는 커밋한다(배포 재현성, 수 MB).
- 규모: 구 해설 75 + 투표 안내 25 + 득표 결과 175 + 0표 25 + 고정 약 6 = 약 306클립. Polly 비용은 1달러 미만, Bedrock 호출 75회.

재생(`narrator.ts`): manifest를 읽고 id로 재생. 큐 규칙: 새 행동의 해설은 진행 중 해설을 끊고 재생(최신 우선), 투표 안내는 끊지 않는다. 자막은 재생과 함께 표시하고 끝나면 1.5초 뒤 사라짐. 파일이 없으면 자막만 보이고 조용히 넘어간다. `HTMLAudioElement` 주입으로 테스트.

### 5.7 실시간 (`/seoul/stage` 채널)

```ts
interface StageMessage { v: 1; type: "stage"; mode: "map" | "spread"; lifted: string | null; ts: number; }
interface VoteMessage  { v: 1; type: "vote"; round: number; phase: "counting" | "result";
                         candidates: string[]; counts: (number | null)[]; winner: string | null; ts: number; }
```

- 구 focus는 본체 `StateMessage`(`/seoul/state`)로 보낸다. 폰의 기존 따라가기 규칙이 그대로 적용된다.
- `isStageMessage`, `isVoteMessage` 런타임 검사(테스트 대상). 페이로드 허용 키 목록 밖의 키가 있으면 publish 전에 실패(손 좌표 유출 방지 테스트).
- 본체 `RealtimeClient`는 채널 하나(`/seoul/state`)만 다룬다. 이 작업은 `createAppSyncRealtime`과 mock에 채널 인자를 받는 생성 방식을 더한다(본체 Task 4 커밋 후, 기존 호출은 기본값으로 동작). 
- 폰 쪽(본체 Task 4 커밋 후): 뷰어가 `/seoul/stage`를 구독해 따라가기 중이면 `setLayout`과 `lift`를 반영하고, `VoteMessage` result를 바텀시트 위 한 줄("투표 결과 강남구 2표 · 마포구 1표 · 노원구 0표")로 6초 보인다.
- 무대 중 AR 폰(내 결정): `#/stage`가 프로젝터를 차지하면 화면에 마커 그림이 없어 `#/ar`는 추적을 잃는다. 무대 화면에 마커를 넣지 않고, `#/ar` 뷰가 `StageMessage`를 받으면 "무대 진행 중 · 3D로 따라가기" 배너(한 번 탭하면 `#/3d`, 따라가기 유지)를 띄운다. 무대 장면은 `#/3d`에서 따라간다. 펼치기 배치는 마커 폭에 맞출 필요가 없다.
- 발행 권한(내 결정): 본체 Task 8(Lambda 권한 부여자 + 발표자 암호)이 들어오면 `#/stage`도 `#/host`와 같은 발표자 자격 모듈을 쓴다. 계획에 "본체 세션에 권한 부여자가 `seoul` 네임스페이스 전체(`/seoul/state`, `/seoul/stage`) 발행을 허용하도록 요청" 단계를 넣고, 무대 시작 화면에 암호 입력 자리를 둔다(Task 8 전에는 숨김). 발행 실패는 상단 연결 표시를 빨간색 "발행 실패"로 바꿔 조용히 실패하지 않게 한다.

### 5.8 정적 자산과 빌드

- `frontend/scripts/copy-mediapipe.mjs`: `node_modules/@mediapipe/tasks-vision/wasm/*` → `frontend/public/mediapipe/wasm/`. `predev`, `prebuild`에 연결.
- `frontend/scripts/check-assets.mjs`(prebuild): 모델 파일이 있고 zip 시그니처(`PK`)인지 확인. 없으면 경고만 하고 빌드는 계속(무대가 마우스 모드로 동작). 
- `.gitignore`에 `frontend/public/models/`, `frontend/public/mediapipe/` 추가.
- 배포는 본체 CDK `BucketDeployment` 그대로. `.wasm`이 `application/wasm`으로 올라가는지 배포 검증 항목에 넣는다(아니면 `Source.asset` 분리로 content-type 지정).
- 코드 분할: `#/stage` 진입 시에만 MediaPipe 모듈을 동적 import(관객 폰 번들에 안 들어감).

### 5.9 디자인

- 본체 토큰 그대로(`#0b1020` 바탕, 순차 램프, 시스템 한글 산세리프). 프로젝터용으로 크게: 자막 40px/600, 모드·월 표시 22px, 안내 줄 18px. 명도 대비 4.5:1.
- 커서: 지름 56px 링, hover 시 링이 구 색으로, 주먹이면 링이 채워지며 살짝 줄어듦. 손이 안 보이면 커서가 흐려짐.
- 투표 집계: 카드가 아니라 가로 막대 세 줄과 큰 숫자. 진행 중인 후보만 밝게, 남은 시간은 원형 진행 표시.
- 금지: 카드 남발, 같은 그림자 반복, ALL CAPS, 섹션 페이드인.

### 5.10 시험

- 순수 모듈 vitest: `oneEuro`, `cursorMap`, `gestureMachine`(확정·쿨다운·release 타임아웃, 합성 프레임 시퀀스), `voteCounter`(500ms 안정 구간, 상한, 순간 튐 무시, 안정 구간 없으면 null), `stageState` 리듀서와 `diffEffects`(직접 선택 방식은 타이머 없이 대기, 카메라 null이면 awaitManual, 직접 값이 카메라 값보다 우선, review 수정 시 자동 확정 정지, 0~6 밖 값 거절, 확정 전에는 publish·해설 없음), `mouseInput` 키 매핑, `spreadLayout`(정렬, 값 없는 구 뒤, 호 범위 안), `isStageMessage`/`isVoteMessage`/허용 키 검사, `narrator` 큐(끊기 규칙, 파일 없음), `facts`, `validateScript`, 템플릿 id 생성(306개, 중복 없음), manifest 생성.
- 통합: `#/stage`가 mock 실시간 + 마우스 입력으로 publish 순서가 맞는지(StateMessage → StageMessage), 페이로드에 좌표·이미지 키가 없는지.
- 브라우저 확인(카메라, GPU 위임, 오디오 재생, 프로젝터 화면)은 이 머신에서 불가. 보고서에 "미확인"으로 적고 사용자 리허설 체크리스트로 넘긴다. 헤드리스 크로미움이 가능하면 마우스 모드 스크린샷까지.

## 6. 빌더에게 맡기는 것

- One Euro 필터 계수, 제스처 점수 임계(0.6)와 프레임 수(6)의 미세 조정, 커서 가장자리 매핑 비율.
- 펼치기 호의 정확한 반지름·각도, 라벨 크기, 카메라 각도 미세값.
- Bedrock 프롬프트 문구(5.6 규칙 준수), 낭독용 숫자 표기 변환 규칙의 세부.
- 진단 표시의 배치.

## 7. 데모 운영 메모

- 발표 전: 노트북 웹캠 앞 0.5~1m, 손 뒤 배경은 단색, 역광 피하기. `D`로 FPS 20 이상 확인. 주먹·두 손 펴기·브이 각 3회 리허설. 투표는 손 0, 1, 2개로 리허설.
- 카메라가 안 잡히면 `G`로 마우스 모드(투표는 자동으로 직접 선택). 카메라가 엉뚱하게 세면 패널 숫자를 누르거나 숫자키로 고치고, 집계 확인에서 한 번 더 고칠 수 있다.
- 발표 중 순서 예: 무대 시작 → 손 펼쳐 가격순 → 다시 펼쳐 지도 → 주먹으로 강남구 → 브이 → `V` 투표 → 결과 구 해설.
