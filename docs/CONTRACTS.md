# 모듈 계약서 (CONTRACTS)

모든 작업자가 읽는 단일 기준. 여기 적힌 이름, 경로, 스키마, 시그니처를 그대로 쓴다. 바꿔야 하면 바꾸지 말고 보고서에 "계약 변경 제안"으로 적는다.

설계 문서: `docs/superpowers/specs/2026-11-17-seoul-ar-design.md`

## 0. 공통 규칙

- Node 24, ESM(`"type": "module"`) in `tools/` and `frontend/`. `infra/`만 CommonJS(CDK, showcase 패턴).
- 테스트: `tools/`와 `frontend/`는 vitest, `infra/`는 `node --test`.
- 명령문(Bash)에 `http://`, `https://`, `wss://` 문자열을 넣지 않는다(세션 가드가 차단). 파일 내용에는 써도 된다.
- 외부 CDN, 외부 폰트 금지. 런타임 외부 호출은 AWS 엔드포인트만.
- 출력 데이터에 본번(MNO), 부번(SNO), 건물명(BLDG_NM), 행 단위 거래가 들어가면 실패.
- 금액은 만원 정수, 면적은 ㎡, ㎡당 가격은 만원/㎡ 정수.
- 커밋은 컨트롤러가 한다. 작업자는 `git add`/`git commit`을 하지 않는다.
- `frontend/package.json`과 `tools/package.json`의 의존성은 이미 설치돼 있다. 추가가 꼭 필요하면 `npm install <pkg>`로 넣고 보고서에 적는다.

## 1. 자치구 목록과 순서 (고정)

```ts
export const GU_ORDER = [
  "종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구",
  "노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구",
  "관악구","서초구","강남구","송파구","강동구",
] as const;
export const GU_CODE: Record<string, string> = { 종로구:"11110", 중구:"11140", 용산구:"11170", 성동구:"11200", 광진구:"11215", 동대문구:"11230", 중랑구:"11260", 성북구:"11290", 강북구:"11305", 도봉구:"11320", 노원구:"11350", 은평구:"11380", 서대문구:"11410", 마포구:"11440", 양천구:"11470", 강서구:"11500", 구로구:"11530", 금천구:"11545", 영등포구:"11560", 동작구:"11590", 관악구:"11620", 서초구:"11650", 강남구:"11680", 송파구:"11710", 강동구:"11740" };
```

파일: `frontend/src/data/gu.ts` (프론트), `tools/data/gu.mjs` (도구, 같은 내용).

## 2. 데이터 파일 (frontend/public/data/)

원자료 행(서울 API tbLnOpendataRtmsV, MCP `search_trades` 응답 그대로)의 쓰는 필드:
`CGG_NM`(구), `STDG_NM`(법정동), `CTRT_DAY`(YYYYMMDD), `THING_AMT`(문자열, 만원), `ARCH_AREA`(숫자, ㎡), `BLDG_USG`(아파트/연립다세대/오피스텔/단독다가구 등), `RTRCN_DAY`(취소일, 비어 있으면 유효).
쓰지 않는 필드: `MNO`, `SNO`, `BLDG_NM` 등 나머지 전부.

원자료 저장: `tools/data/raw/{yyyymm}/{gu}.json` = 행 배열(JSON). git 제외.

### 2.1 `data/index.json`

```json
{
  "v": 1,
  "generatedAt": "2026-11-17T07:00:00.000Z",
  "source": "서울 열린데이터광장 부동산 실거래가(tbLnOpendataRtmsV)",
  "months": ["202609", "202610", "202611"],
  "gus": ["종로구", "...25개, GU_ORDER 순서"],
  "summary": {
    "202611": {
      "강남구": { "n": 34, "cancelled": 2, "medPerM2": 2890, "medAmt": 180000, "maxAmt": 526000, "truncated": false }
    }
  }
}
```

### 2.2 `data/{yyyymm}/{gu}.json`

```json
{
  "v": 1,
  "month": "202611",
  "gu": "강남구",
  "generatedAt": "2026-11-17T07:00:00.000Z",
  "total": { "n": 34, "cancelled": 2, "medPerM2": 2890, "medAmt": 180000, "maxAmt": 526000, "truncated": false },
  "dongs": [
    { "name": "대치동", "n": 7, "cancelled": 0, "nApt": 5, "medPerM2": 3300, "medPerM2Apt": 3500, "medAmt": 250000, "maxAmt": 400000, "usage": { "아파트": 5, "오피스텔": 2 } }
  ]
}
```

정의
- 유효 거래: `RTRCN_DAY`가 빈 문자열. `cancelled` = 비어 있지 않은 행 수. 통계는 유효 거래만.
- `perM2` = round(Number(THING_AMT) / ARCH_AREA), `ARCH_AREA > 0`인 유효 거래만.
- `medPerM2`: perM2 중앙값(짝수면 두 값 평균을 round). 대상 0건이면 `null`.
- `medPerM2Apt`: `BLDG_USG === "아파트"`만. 0건이면 `null`.
- `medAmt`: THING_AMT 중앙값(만원). `maxAmt`: 최대 THING_AMT. 유효 거래 0건이면 둘 다 `null`, `n: 0`.
- `nApt`: 유효 거래 중 아파트 수. `usage`: 유효 거래의 BLDG_USG별 건수.
- `dongs` 정렬: `medPerM2` 내림차순, null은 뒤, 같으면 `n` 내림차순, 같으면 이름 오름차순.
- `truncated`: 원자료 행 수가 1000이면 true.
- `total`은 구 전체(법정동 합산이 아니라 행 전체로 다시 계산).

TypeScript 타입 (`frontend/src/data/types.ts`):

```ts
export interface Stat { n: number; cancelled: number; medPerM2: number | null; medAmt: number | null; maxAmt: number | null; truncated: boolean; }
export interface DongStat { name: string; n: number; cancelled: number; nApt: number; medPerM2: number | null; medPerM2Apt: number | null; medAmt: number | null; maxAmt: number | null; usage: Record<string, number>; }
export interface GuData { v: 1; month: string; gu: string; generatedAt: string; total: Stat; dongs: DongStat[]; }
export interface DataIndex { v: 1; generatedAt: string; source: string; months: string[]; gus: string[]; summary: Record<string, Record<string, Stat>>; }
export type Metric = "price" | "count";
```

로더 (`frontend/src/data/loader.ts`):

```ts
export async function loadIndex(base?: string): Promise<DataIndex>;            // fetch(`${base ?? ""}/data/index.json`)
export async function loadGu(month: string, gu: string, base?: string): Promise<GuData>; // fetch(`${base ?? ""}/data/${month}/${encodeURIComponent(gu)}.json`), 메모리 캐시
```

## 3. 지오 (frontend/src/geo/)

```ts
// frontend/src/geo/types.ts
export interface GuShape { name: string; code: string; centroid: [number, number]; rings: [number, number][][]; }
export interface Geo { v: 1; crs: "unit-square" | "tile"; gus: GuShape[]; }
```

- 좌표 `[x, z]`: x는 동쪽 양수, z는 남쪽 양수(북쪽이 -z). 도시 전체 경계 상자가 `[-0.5, 0.5]²` 안에 들어가고 종횡비를 유지한다(긴 축이 1.0).
- `rings`: 각 링은 닫히지 않은 점 목록(첫 점 반복 금지), 바깥 링만. MultiPolygon은 링 여러 개. 링당 최대 400점.
- `gus`는 GU_ORDER 순서로 25개 전부.
- 생성 파일: `frontend/src/geo/seoul-gu.json` (`Geo` 형식). 도구가 만든다. 원본 GeoJSON이 없으면 타일 버전(`crs: "tile"`)을 같은 경로에 쓴다.
- 타일 폴백: `frontend/src/geo/tiles.ts`가 `export function tileGeo(): Geo`를 낸다. 25구를 서울 지리에 가깝게 배치한 정사각 타일(한 변 0.16, 간격 0.02).

도구 (`tools/geo/convert.mjs`):

```
node tools/geo/convert.mjs [--in tools/geo/raw/seoul_municipalities_geo_simple.json] [--out frontend/src/geo/seoul-gu.json]
```
- 입력 GeoJSON FeatureCollection. 구 이름은 `properties.name` 또는 `properties.SIG_KOR_NM` 또는 `properties.SGG_NM` 중 있는 것. 코드는 GU_CODE에서 채운다.
- 투영: 경도 x = (lon - lon0) * cos(lat0), 위도 z = -(lat - lat0). lon0, lat0은 전체 경계 상자 중심. 그 뒤 긴 축이 1.0이 되도록 균일 스케일.
- 순수 함수 `export function convertGeoJson(fc: object): Geo` (테스트 대상), CLI는 이를 감싼다.

## 4. 3D 씬 (frontend/src/scene/)

```ts
// frontend/src/scene/seoulScene.ts
import type { Group, Camera } from "three";
import type { Geo } from "../geo/types";
import type { Stat, DongStat, GuData, Metric } from "../data/types";

export interface SeoulScene {
  group: Group;                                                    // 부모(AR 앵커 또는 월드)에 add
  setOverview(summary: Record<string, Stat>, metric: Metric): void; // 25구 색 갱신(전체 보기)
  focus(gu: string | null, data: GuData | null, metric: Metric): void; // 구 상승 + 법정동 막대. null이면 전체 보기
  setMetric(metric: Metric): void;                                  // 현재 focus/overview를 새 지표로 다시 그림
  update(dt: number, camera: Camera): void;                         // 매 프레임: 애니메이션, 라벨 빌보드
  dispose(): void;
}
export interface SceneOptions { reducedMotion?: boolean; makeTextTexture?: (text: string, color: string) => import("three").Texture | null; }
export function createSeoulScene(geo: Geo, opts?: SceneOptions): SeoulScene;
```

순수 함수 (`frontend/src/scene/layout.ts`, 테스트 대상):

```ts
export interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number; }
export interface BarPlacement { name: string; x: number; z: number; size: number; height: number; value: number | null; }
export function boundsOf(rings: [number, number][][]): Bounds;
export function metricValue(d: DongStat, metric: Metric): number | null;   // price → medPerM2, count → n
export function heightFor(value: number | null, max: number): number;      // null→0.02, 그 외 0.02 + 0.33*(value/max), max<=0이면 0.02
export function layoutBars(dongs: DongStat[], bounds: Bounds, metric: Metric): BarPlacement[];
// 격자: cols = ceil(sqrt(n)), rows = ceil(n/cols). 셀 크기 = min(폭/cols, 깊이/rows). 막대 한 변 = 셀 * 0.72.
// 정렬: metricValue 내림차순(null 뒤). 왼쪽 위(minX, minZ)부터 행 우선 배치, 격자 전체를 경계 상자 중앙에 맞춤.
```

색 (`frontend/src/scene/colors.ts`, 테스트 대상):

```ts
export const PALETTE = { bg: "#0b1020", guBase: "#1b2340", guDim: "#121833", ramp: ["#1e3a8a", "#2563eb", "#38bdf8", "#fbbf24", "#f97316"], noData: "#4b5563", text: "#e5e7eb" } as const;
export function colorFor(t: number): string; // t∈[0,1], ramp 선형 보간, NaN이면 noData
export function normalize(values: (number | null)[]): (number | null)[]; // 최소~최대를 0~1로, 전부 같으면 0.5
```

치수: 구 돌출 두께 0.02, 선택 구 상승 y 0.03, 막대 높이 0.02~0.35, 성장 애니메이션 0.6초 ease-out(reducedMotion이면 즉시). 라벨: 선택 구 이름과 상위 5 법정동. 글꼴은 시스템 한글 산세리프.

## 5. AR 세션 (frontend/src/ar/)

```ts
// frontend/src/ar/session.ts
import type { Group, Scene, Camera, WebGLRenderer } from "three";
export interface ArSession {
  anchor: Group;              // 타깃 위에 붙는 그룹. 여기 seoulScene.group을 add
  scene: Scene; camera: Camera; renderer: WebGLRenderer;
  start(): Promise<void>;     // 카메라 시작. 사용자 제스처 안에서 호출
  stop(): void;
  onFound(cb: () => void): void;
  onLost(cb: () => void): void;
  onFrame(cb: (dt: number) => void): void; // 렌더 루프 틱
}
export interface ArSessionOptions { container: HTMLElement; targetSrc: string; /* "/marker/target.mind" */ }
export function createArSession(opts: ArSessionOptions): ArSession;
export function arSupported(): boolean;    // navigator.mediaDevices?.getUserMedia 존재 + WebGL 가능
```

좌표계 주의(2026-11-17 보강): MindAR의 `anchor.group`은 타깃 그림을 자기 XY 평면에 놓고 z가 카메라 쪽이다. 씬(4절)은 XZ 평면에 y 위다. 따라서 `ArSession.anchor`는 MindAR `anchor.group`에 직접 넣은 **내부 Group**이고, `inner.rotation.x = Math.PI / 2`로 돌려 둔다(씬의 y가 그림에서 솟아오르고, 씬의 z(남)가 그림의 아래가 된다). 뷰는 이 `anchor`에 `seoulScene.group`을 그대로 add 한다.

안정화와 고정(2026-11-17 추가, 사용자 폰 시험 피드백 "너무 흔들려서 값을 읽기 힘듦"):

```ts
export interface ArSmoothing { positionAlpha?: number; /* 0.18 */ rotationAlpha?: number; /* 0.18 */ deadbandPos?: number; /* 0.004 (타깃 폭 단위) */ deadbandRotRad?: number; /* 0.01 */ holdMs?: number; /* 800: 타깃 유실 뒤 마지막 포즈 유지 시간 */ }
export interface ArSessionOptions {
  container: HTMLElement; targetSrc: string;
  smoothing?: ArSmoothing;                 // 기본값 위 주석
  filterMinCF?: number;                    // MindAR One-Euro 필터, 기본 0.0001 (작을수록 덜 흔들리고 더 느림)
  filterBeta?: number;                     // MindAR One-Euro 필터, 기본 0.01 (작을수록 덜 흔들림)
  warmupTolerance?: number;                // 기본 5
  missTolerance?: number;                  // 기본 10 (잠깐 놓쳐도 lost 로 깜빡이지 않게)
}
export interface ArSession {
  // ...기존 멤버...
  freeze(): void;                          // 카메라 영상(video.pause())과 포즈 갱신을 멈추고 마지막 포즈를 유지. 렌더 루프는 계속 돈다
  unfreeze(): void;                        // 영상·포즈 갱신 재개
  readonly frozen: boolean;
  onFreeze(cb: (frozen: boolean) => void): () => void;
}
```

- `anchor`는 이제 MindAR `anchor.group`의 직계 자식이 아니라 `scene` 바로 아래의 **추종 그룹**이다. 매 프레임 MindAR `anchor.group`의 월드 변환을 읽어 위치는 `positionAlpha`로 lerp, 회전은 `rotationAlpha`로 slerp 하되, 변화량이 `deadbandPos`/`deadbandRotRad` 미만이면 무시한다(정지 상태에서 미세 떨림 제거). 타깃을 잃으면 `holdMs` 동안 마지막 포즈로 보이게 두고 그 뒤 숨긴다. 추종 그룹 안에 `rotation.x = +π/2` 내부 그룹이 있고 뷰는 그 내부 그룹(=`anchor`)에 씬을 add 한다(좌표계 규칙 동일).
- `freeze()` 동안 `onFound/onLost`는 발화하지 않는다.

바텀시트(8절 보강): `renderSheet`는 현재 지표 기준 법정동 상위 5개(이름, 값, 건수)를 목록으로 포함한다. 3D 라벨이 흔들려도 숫자는 2D에서 읽을 수 있어야 한다. AR 뷰에는 "화면 고정" 토글 버튼(44px 이상)이 있고 고정 중에는 "고정됨" 상태와 "다시 추적" 버튼을 보여 준다.

마커 파일: `frontend/public/marker/target.png`(정사각 1024), `frontend/public/marker/target.mind`.
도구: `node tools/marker/make-slide.mjs` (target.png와 `frontend/public/marker/slide.png` 1920×1080 생성), `node tools/marker/compile-target.mjs` (target.mind 생성).

## 6. 실시간 (frontend/src/realtime/)

```ts
// frontend/src/realtime/types.ts
export interface StateMessage { v: 1; type: "state"; month: string; gu: string | null; metric: "price" | "count"; ts: number; }
export type ConnStatus = "idle" | "connecting" | "open" | "error" | "closed";
export interface RealtimeClient {
  connect(): Promise<void>;
  subscribe(handler: (msg: StateMessage) => void): () => void;
  publish(msg: StateMessage): Promise<void>;
  readonly status: ConnStatus;
  onStatus(cb: (s: ConnStatus) => void): () => void;
  close(): void;
}
export function isStateMessage(x: unknown): x is StateMessage;   // 런타임 검사(테스트 대상)
```

- 채널: `/seoul/state` (네임스페이스 `seoul`).
- `frontend/src/realtime/appsync.ts`: `export function createAppSyncRealtime(cfg: EventsConfig): RealtimeClient` — aws-amplify `events`(`import { Amplify } from "aws-amplify"; import { events } from "aws-amplify/data";`). `Amplify.configure({ API: { Events: { endpoint: cfg.httpEndpoint, region: cfg.region, defaultAuthMode: "apiKey", apiKey: cfg.apiKey } } })`.
- `frontend/src/realtime/mock.ts`: `export function createMockRealtime(): RealtimeClient` — 같은 탭 내 즉시 전달 + `BroadcastChannel("seoul-ar")`로 탭 간 전달(존재할 때만).

## 7. 설정 (frontend/public/config.json, 배포 시 CDK가 생성)

```json
{
  "v": 1,
  "appUrl": "https://dxxxx.cloudfront.net",
  "events": {
    "httpEndpoint": "https://xxxx.appsync-api.us-east-1.amazonaws.com/event",
    "realtimeEndpoint": "wss://xxxx.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime",
    "region": "us-east-1",
    "apiKey": "da2-xxxx"
  }
}
```

```ts
// frontend/src/config.ts
export interface EventsConfig { httpEndpoint: string; realtimeEndpoint: string; region: string; apiKey: string; }
export interface AppConfig { v: 1; appUrl: string | null; events: EventsConfig | null; }
export async function loadConfig(): Promise<AppConfig>; // fetch("/config.json", {cache:"no-store"}); 실패나 404면 { v:1, appUrl:null, events:null }
```

개발용 기본 파일 `frontend/public/config.json` = `{ "v": 1, "appUrl": null, "events": null }` (events null이면 mock 실시간).

## 8. 앱 상태와 라우트 (frontend/src/state/, frontend/src/router.ts)

```ts
export interface AppState { month: string; gu: string | null; metric: Metric; follow: boolean; conn: ConnStatus; }
export type Action =
  | { type: "remote"; msg: StateMessage }         // follow가 true일 때만 month/gu/metric 반영
  | { type: "local"; month?: string; gu?: string | null; metric?: Metric } // follow=false로 전환
  | { type: "follow" }                             // follow=true, 마지막 remote 상태 복원
  | { type: "conn"; status: ConnStatus };
export function reduce(state: AppState, action: Action, lastRemote: StateMessage | null): AppState;
export const INITIAL_STATE: AppState; // month: index.months의 마지막, gu: null, metric: "price", follow: true, conn: "idle"
```

라우트(해시): `#/` 랜딩, `#/ar`, `#/3d`, `#/host`. 알 수 없으면 `#/`.
호스트는 변경마다 `publish({v:1,type:"state",month,gu,metric,ts:Date.now()})`. 뷰어는 `remote`로 반영.

## 9. 인프라 출력 (infra/)

스택 이름 `SeoulArStack`, 리전 us-east-1. CfnOutput: `CloudFrontUrl`, `EventsHttpEndpoint`, `EventsRealtimeEndpoint`, `BucketName`. 배포 명령은 `infra/`에서 `npx cdk deploy --require-approval never --outputs-file cdk-outputs.json`. 프론트 빌드 결과 `frontend/dist`가 있어야 synth 된다.

## 10. 월 실시간 수집 (Task 9, 2026-11-17 추가)

사용자 요청: "지금은 2026.11만 있는데 월별 리포트를 실시간으로 가져올 수 있는 버튼". 발표자 화면에서 월을 고르면 Lambda가 서울 API를 호출해 그 달의 25구 집계 JSON을 S3에 쓰고, 진행 상황을 AppSync Events로 알린다. 서울 API 키는 AWS 안(SSM)에만 있고 코드·저장소·브라우저에는 없다.

### 10.1 SSM 파라미터 (us-east-1, 사용자가 만든다. CDK는 이름만 참조)
- `/seoul-ar/seoul-api-key` SecureString: 서울 열린데이터광장 인증키
- `/seoul-ar/presenter-passcode` SecureString: 발표자 암호(수집 버튼 보호. 뒤에 AppSync publish 잠금에도 재사용)

### 10.2 HTTP API
`POST /api/fetch-month` (CloudFront 추가 동작 `/api/*` → Lambda Function URL 오리진, 캐시 없음). 요청 JSON `{ "month": "202610" }`, 헤더 `x-presenter-key: <암호>`.
- 202 `{ "jobId": "...", "month": "202610" }` 시작됨 (비동기: 핸들러가 자기 자신을 Event 로 재호출하고 바로 응답)
- 400 월 형식 오류(YYYYMM, 200601 ≤ month ≤ 이번 달)
- 401 암호 불일치(sha256 다이제스트 timingSafeEqual 비교)
- 409 다른 작업 진행 중(`data/jobs/lock.json`, 10분 지나면 stale 로 무시)
- Function URL 직접 호출도 같은 검사를 거친다(CloudFront 우회 방어는 암호).

### 10.3 수집 알고리즘 (참고 구현: ~/claude-lab/capstone/seoul-realestate/server.py 의 _fetch_page/fetch_trades)
- 구마다: 서울 API `tbLnOpendataRtmsV` 를 접수연도 `RCPT_YR = month[:4]`, 자치구 `CGG_NM = gu` 로 1000건씩 페이지 호출. 결과는 최근 계약부터 오므로, 한 페이지가 1000건 미만이거나 페이지의 가장 오래된 `CTRT_DAY` 가 해당 월 1일보다 앞서면 멈춘다(최대 12페이지). `CTRT_DAY[:6] === month` 인 행만 남긴다.
- 집계는 `tools/data/aggregate.mjs` 의 `aggregateRows`/`buildIndex` 와 **같은 코드**를 쓴다. Lambda 디렉터리에 복사본을 두고(`infra/lambda/fetch-month/aggregate.mjs`), 두 파일이 바이트 단위로 같은지 테스트로 묶는다. 출력 스키마는 2절 그대로(금지 필드 없음).
- 쓰기: `data/{month}/{gu}.json` 25개, 그 뒤 `data/index.json` 갱신(기존 index 를 읽어 `months` 에 월 추가·정렬, `summary[month]` 교체, `generatedAt` 갱신). 모두 `Cache-Control: no-cache`. 끝나면 CloudFront 무효화 `/data/*`.
- 오류 응답 코드 `INFO-200`(데이터 없음)은 빈 결과로 처리. 그 외 오류는 작업 실패.
- 예외 메시지에 URL(키 포함)을 절대 넣지 않는다.

### 10.4 진행 이벤트
채널 `/seoul/jobs`. Lambda 가 AppSync Events HTTP 엔드포인트에 `x-api-key` 로 POST 한다(`{"channel":"/seoul/jobs","events":[<JSON 문자열>]}`).

```ts
export interface JobMessage { v: 1; type: "job"; jobId: string; month: string; state: "running" | "done" | "error"; done: number; total: number; gu?: string; message?: string; ts: number; }
export function isJobMessage(x: unknown): x is JobMessage;
```
- 구 하나 끝날 때마다 `running`(done 증가, gu 이름), 마지막에 `done` 또는 `error`(message 는 사용자용 한 문장, 키·URL 없음).
- 폴링 폴백: `data/jobs/{jobId}.json` 에 마지막 상태를 쓴다.

### 10.5 프론트
- `RealtimeClient` 에 `subscribeJobs(handler: (msg: JobMessage) => void): () => void` 추가(AppSync 구현은 `/seoul/jobs` 채널 연결, mock 은 메모리/BroadcastChannel).
- 호스트 화면 "월 가져오기" 구역: 월 입력(YYYYMM 또는 `<input type="month">`), "가져오기" 버튼, 처음 누를 때 발표자 암호 입력(세션 저장소 `seoul-ar.presenter`), 진행 표시 "2026년 10월 수집 중 12/25 · 강서구", 완료 시 index 를 다시 읽어(`no-store`) 월 토글에 새 달이 나타나고 토스트 "2026년 10월 데이터가 준비됐습니다". 401/409/400/네트워크 오류는 사용자용 문장으로 표시.
- 뷰어: 원격 상태의 `month` 가 자기 index 에 없으면 index 를 한 번 다시 읽은 뒤 적용한다(새 달이 생겼을 때 폰이 따라오게).

### 10.6 CDK
- `lambda.Function` Node.js 22, `Code.fromAsset("lambda/fetch-month")`(의존성 없음: 런타임 내장 AWS SDK v3 와 global fetch 만), memory 512, timeout 600s, env: `BUCKET`, `DISTRIBUTION_ID`, `EVENTS_HTTP_ENDPOINT`, `EVENTS_API_KEY`, `SSM_API_KEY_NAME`, `SSM_PASSCODE_NAME`, `SELF_FUNCTION_NAME`.
- IAM 최소 권한: 버킷의 `data/*` Get/Put, 해당 배포의 `cloudfront:CreateInvalidation`, 두 파라미터의 `ssm:GetParameter` + `kms:Decrypt`(aws/ssm 키), 자기 자신 `lambda:InvokeFunction`.
- Function URL(AuthType NONE) + CloudFront 추가 동작 `/api/*`: `FunctionUrlOrigin`, 캐시 비활성(`CACHING_DISABLED`), 오리진 요청 정책 `ALL_VIEWER_EXCEPT_HOST_HEADER`, 메서드 ALL, HTTPS 리다이렉트.
- 출력 `FetchMonthUrl`. 테스트: Lambda 핸들러 단위 테스트(`node --test`, fetch/S3/publish 주입), CDK assertions(동작·권한·env).
