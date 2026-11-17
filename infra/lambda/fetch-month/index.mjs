// 월 실시간 수집 Lambda (CONTRACTS 10). 두 가지 이벤트를 받는다.
//
// 1) HTTP (Function URL, CloudFront /api/* 뒤): POST /api/fetch-month {"month":"YYYYMM"}, 헤더 x-presenter-key
//    경로 → 메서드 → 암호(401) → 본문·월(400) → 잠금(409) → 작업 기록(running 0/25) → 작업자 Event 호출 → 202 {jobId, month}
// 2) 작업자 (Lambda Event 호출, 페이로드 {jobId, month}):
//    25구 수집·집계 → data/{month}/{gu}.json 25개 → data/index.json 병합 → CloudFront /data/* 무효화 → done
//    구 하나 끝날 때마다 running 발행, 실패하면 error 발행. 잠금은 finally 에서 항상 해제.
//    수집이 끝나면(BEDROCK_MODEL_ID 가 있을 때) 같은 호출 안에서 AI 해설을 만든다(jobId "{jobId}-narration", kind "narration").
// 2b) 해설 작업자 (페이로드 {action: "narrate", jobId, month}, POST /api/narrate-month 가 부른다): 이미 있는 달의 해설만 만든다.
// 3) index 재구성 (Lambda 호출, 페이로드 {action: "rebuild-index"}, 배포마다 CDK 커스텀 리소스가 부른다):
//    S3 data/YYYYMM/{gu}.json 의 total 로 data/index.json 을 다시 만든다(저장소 스냅샷 index 가 Lambda 가 가져온 달을 가리지 않게).
//
// 모든 I/O 는 deps 로 주입한다(createHandler). 런타임 기본값은 aws.mjs 의 makeDefaultDeps.
import { createHash, timingSafeEqual } from "node:crypto";
import { GU_ORDER } from "./gu.mjs";
import { aggregateRows } from "./aggregate.mjs";
import { fetchMonthRows, SeoulApiError } from "./seoulApi.mjs";
import {
  acquireLock, releaseLock, writeJobRecord, mergeIndex, rebuildIndexFromStore, mapPool, JobError, INDEX_KEY, JSON_PUT, guKey,
} from "./job.mjs";
import { jobMessage, createReporter } from "./publish.mjs";
import { generateNarration, narrationKey, NARRATION_KEYS } from "./narrate.mjs";
import { clientIp, authKey, registerAttempt, clearAttempts } from "./auth.mjs";

export const MIN_MONTH = "200601";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// CloudFront 경유 경로와 Function URL 직접 경로 → 작업 종류
const ROUTES = new Map([
  ["/api/fetch-month", "fetch"], ["/fetch-month", "fetch"],
  ["/api/narrate-month", "narration"], ["/narrate-month", "narration"],
]);
const JOB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const DEFAULT_CONCURRENCY = 4;
// 남은 실행 시간이 이만큼 남으면 멈추고 error 를 알린다(페이지 한 번 + 재시도 60초, 쓰기·발행 여유).
// 10분 잠금 stale 시간보다 먼저 끝나므로 다음 작업과 겹치지 않는다.
const DEADLINE_MARGIN_MS = 90_000;
const PASSCODE_TTL_MS = 60_000; // 발표자 암호 메모리 캐시(SSM 을 바꾸면 길어야 1분 뒤 반영)
const TOTAL = GU_ORDER.length;
const NARR_TOTAL = NARRATION_KEYS.length;

/** 한국 시간(UTC+9) 기준 이번 달 YYYYMM. */
export function currentMonthKst(nowMs) {
  const d = new Date(nowMs + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month) {
  return `${month.slice(0, 4)}년 ${Number(month.slice(4))}월`;
}

/** YYYYMM, 01~12월, 200601 이상, 한국 시간 이번 달 이하. */
export function validateMonth(month, nowMs) {
  if (typeof month !== "string" || !/^\d{6}$/.test(month)) {
    return { ok: false, message: "월은 YYYYMM 형식(예: 202610)으로 보내 주세요." };
  }
  const mm = Number(month.slice(4));
  if (mm < 1 || mm > 12) return { ok: false, message: "월은 YYYYMM 형식이고 01월부터 12월 사이여야 합니다." };
  if (month < MIN_MONTH) return { ok: false, message: "2006년 1월(200601)부터 가져올 수 있습니다." };
  const current = currentMonthKst(nowMs);
  if (month > current) return { ok: false, message: `이번 달(${monthLabel(current)})까지만 가져올 수 있습니다.` };
  return { ok: true };
}

/** 발표자 암호 비교: 두 값의 sha256 다이제스트(같은 길이)를 timingSafeEqual 로 비교한다. */
export function passcodeMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || given.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const JSON_HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });

function respond(statusCode, body, headers = {}) {
  return { statusCode, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) };
}

function fail(statusCode, error, message, extra = {}, headers = {}) {
  return respond(statusCode, { error, message, ...extra }, headers);
}

async function readPasscode(deps, cache) {
  const nowMs = deps.now();
  if (cache.value !== null && nowMs - cache.at < PASSCODE_TTL_MS) return cache.value;
  const value = await deps.getParameter(deps.env.SSM_PASSCODE_NAME); // 실패는 캐시하지 않는다
  cache.value = value;
  cache.at = nowMs;
  return value;
}

function header(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  if (name in headers) return headers[name];
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

function parseBody(event) {
  if (typeof event.body !== "string" || event.body === "") return null;
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** 로그용 오류 요약. 비밀 값과 URL 은 지운다. */
function errFields(e, ...secrets) {
  let message = String(e?.message ?? "");
  for (const s of secrets) if (typeof s === "string" && s.length > 0) message = message.split(s).join("***");
  message = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 300);
  return { error: String(e?.name ?? "Error"), code: e?.code, message };
}

/** HMAC 비밀(서버 쪽 임의 값)을 컨테이너마다 한 번 읽는다. 실패는 캐시하지 않는다. */
async function readAuthSecret(deps, cache) {
  if (cache.value !== null) return cache.value;
  const value = await deps.getAuthSecret(deps.env.AUTH_SECRET_ARN);
  if (typeof value !== "string" || value.length === 0) throw new Error("인증 비밀 값이 비어 있음");
  cache.value = value;
  return value;
}

async function handleHttp(event, deps, caches) {
  const { env, store, log } = deps;
  const method = event.requestContext.http.method;
  const path = event.rawPath ?? event.requestContext.http.path;
  const kind = ROUTES.get(path);
  if (!kind) return fail(404, "not_found", "알 수 없는 경로입니다.");
  if (method !== "POST") return fail(405, "method_not_allowed", "POST 요청만 받습니다.");

  // IP(IPv6 는 /64) 별 시도 셈: 비교 전에 비공개 인증 상태 버킷에 ETag 조건부 쓰기로 센다. 10분 창에 10번 → 10분 429.
  // 키는 HMAC(ip, 서버 쪽 임의 비밀). 비밀을 못 읽거나 셈을 기록하지 못하면 비교하지 않고 거절한다(fail-closed).
  let attempt;
  let attemptKey;
  try {
    attemptKey = authKey(clientIp(event), await readAuthSecret(deps, caches.authSecret));
    attempt = await registerAttempt(deps.authStore, attemptKey, deps.now());
  } catch (e) {
    log("warn", "암호 시도를 기록하지 못해 거절(비교하지 않음)", errFields(e));
    return fail(401, "unauthorized", "암호를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (!attempt.ok) {
    return fail(429, "too_many_attempts", "잠시 후 다시 시도해 주세요.", {}, { "retry-after": String(Math.ceil(attempt.lockedMs / 1000)) });
  }

  let expected;
  try {
    expected = await readPasscode(deps, caches.passcode);
  } catch (e) {
    log("error", "발표자 암호 파라미터를 읽지 못함", errFields(e));
    return fail(500, "config", "서버 설정을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  if (!passcodeMatches(header(event.headers, "x-presenter-key"), expected)) {
    if (attempt.record.lockedUntil) log("warn", "암호 실패가 많아 이 접속을 10분 잠근다", { count: attempt.record.count });
    return fail(401, "unauthorized", "발표자 암호가 맞지 않습니다.");
  }
  try {
    await clearAttempts(deps.authStore, attemptKey, attempt.etag);
  } catch (e) {
    log("warn", "암호 시도 기록을 초기화하지 못함", errFields(e));
  }

  const body = parseBody(event);
  if (!body) return fail(400, "bad_request", "요청 본문은 {\"month\": \"YYYYMM\"} 형식의 JSON 이어야 합니다.");
  const nowMs = deps.now();
  const check = validateMonth(body.month, nowMs);
  if (!check.ok) return fail(400, "bad_month", check.message);
  const month = body.month;
  if (kind === "narration" && !(await monthExists(deps, month))) {
    return fail(400, "no_data", "아직 가져오지 않은 달입니다. 먼저 월을 가져와 주세요.");
  }
  const jobId = deps.randomId();
  const jobKind = kind === "narration" ? { kind: "narration" } : {};
  const total = kind === "narration" ? NARR_TOTAL : TOTAL;

  let lock;
  try {
    lock = await acquireLock(store, { jobId, month, nowMs, ...(kind === "narration" ? { kind: "narration" } : {}) });
  } catch (e) {
    log("error", "잠금 확인 실패", errFields(e));
    return fail(500, "lock", "작업 잠금을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  if (!lock.ok) {
    const holder = lock.holder;
    const label = holder?.month && /^\d{6}$/.test(holder.month) ? monthLabel(holder.month) : null;
    const message = !label
      ? "다른 달을 가져오는 중입니다. 잠시 뒤 다시 시도해 주세요."
      : holder.kind === "narration"
        ? `${label} 해설을 만드는 중입니다. 끝난 뒤 다시 시도해 주세요.`
        : `${label} 데이터를 가져오는 중입니다. 끝난 뒤 다시 시도해 주세요.`;
    return fail(409, "busy", message, holder?.jobId && holder.month ? { jobId: holder.jobId, month: holder.month } : {});
  }

  try {
    await writeJobRecord(store, jobMessage({ ...jobKind, jobId, month, state: "running", done: 0, total, ts: nowMs }));
    const payload = kind === "narration" ? { action: "narrate", jobId, month } : { jobId, month };
    await deps.invoke({ functionName: env.SELF_FUNCTION_NAME, payload });
  } catch (e) {
    log("error", "작업자 호출 실패", errFields(e));
    const message = "수집 작업을 시작하지 못했습니다.";
    await writeJobRecord(store, jobMessage({ ...jobKind, jobId, month, state: "error", done: 0, total, message, ts: deps.now() }))
      .catch((err) => log("warn", "작업 기록 쓰기 실패", errFields(err)));
    await releaseLock(store, { jobId, nowMs: deps.now() }).catch((err) => log("error", "잠금 해제 실패", errFields(err)));
    return fail(500, "start_failed", `${message} 잠시 뒤 다시 시도해 주세요.`);
  }
  log("info", "작업 시작", { jobId, month, kind });
  return respond(202, { jobId, month });
}

/** narrate-month 의 동기 확인: index 에 그 달이 있나. index 를 못 읽으면 작업자에게 맡긴다(true). */
async function monthExists(deps, month) {
  try {
    const cur = await deps.store.get(INDEX_KEY);
    if (!cur) return false;
    const idx = JSON.parse(cur.text);
    return Array.isArray(idx?.months) ? idx.months.includes(month) : true;
  } catch (e) {
    deps.log("warn", "index.json 확인 실패: 작업자가 다시 확인한다", errFields(e));
    return true;
  }
}

function makeDeadline(deps, context) {
  const remaining = typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : null;
  const deadline = remaining === null ? Infinity : deps.now() + remaining - DEADLINE_MARGIN_MS;
  return () => {
    if (deps.now() > deadline) throw new JobError("제한 시간 안에 작업을 끝내지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  };
}

function missingNote(missing) {
  if (missing.length === 0) return {};
  const names = missing.slice(0, 5).join(", ") + (missing.length > 5 ? ` 외 ${missing.length - 5}곳` : "");
  return { message: `일부 해설은 만들지 못해 비워 두었습니다: ${names}` };
}

/**
 * 해설 생성 → data/{month}/narration.json → /data/{month}/narration.json 무효화. 진행은 send 로(kind narration).
 * 실패는 사용자용 JobError 로 정리해 던진다.
 */
async function produceNarration({ deps, jobId, month, perGu, send, checkDeadline, skip = [] }) {
  const { env, store, log } = deps;
  if (!env.BEDROCK_MODEL_ID || typeof deps.converse !== "function") {
    throw new JobError("AI 해설 설정(BEDROCK_MODEL_ID)이 없어 해설을 만들지 못했습니다.");
  }
  let result;
  try {
    result = await generateNarration({
      converse: deps.converse,
      modelId: env.BEDROCK_MODEL_ID,
      month,
      perGu,
      skip,
      generatedAt: new Date(deps.now()).toISOString(),
      beforeCall: checkDeadline,
      log,
      onProgress: ({ done, key }) => { void send({ state: "running", done, ...(key ? { gu: key } : {}) }); },
    });
  } catch (e) {
    if (e instanceof JobError) throw e;
    log("error", "Bedrock 호출 실패", errFields(e));
    throw new JobError("AI 해설을 만들지 못했습니다(Bedrock 모델 접근 권한과 모델 ID 를 확인해 주세요).");
  }
  if (Object.keys(result.narration.items).length === 0) {
    throw new JobError("AI 해설을 하나도 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  try {
    await store.put(narrationKey(month), JSON.stringify(result.narration, null, 2) + "\n", JSON_PUT);
  } catch (e) {
    log("error", "narration.json 저장 실패", errFields(e));
    throw new JobError("해설 파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  if (env.DISTRIBUTION_ID) {
    try {
      await deps.invalidate({ distributionId: env.DISTRIBUTION_ID, paths: [`/data/${month}/narration.json`], callerReference: jobId });
    } catch (e) {
      log("warn", "CloudFront 무효화 실패", errFields(e));
    }
  }
  if (result.stoppedEarly) log("warn", "마감에 걸려 지금까지 만든 해설만 저장", { jobId, month, missing: result.missing });
  log("info", "해설 완료", { jobId, month, calls: result.calls, missing: result.missing, model: result.narration.model });
  return result;
}

function narrationSender(deps, jobId, month) {
  const report = createReporter({ publish: deps.publish, record: (m) => writeJobRecord(deps.store, m), log: deps.log });
  return (fields) => report(jobMessage({ kind: "narration", jobId, month, total: NARR_TOTAL, ...fields, ts: deps.now() }));
}

/**
 * 수집 끝 자동 해설. {jobId}-narration 으로 잠금을 잡는다(그동안 "해설 생성" 버튼은 409).
 * 잠금이 잡혀 있으면 건너뛴다. 어떤 경우에도 던지지 않는다(수집 결과는 이미 done).
 */
async function autoNarrate({ deps, jobId, month, perGu, checkDeadline }) {
  let lock;
  try {
    lock = await acquireLock(deps.store, { jobId, month, nowMs: deps.now(), kind: "narration" });
  } catch (e) {
    deps.log("warn", "자동 해설 잠금을 확인하지 못해 건너뜀", errFields(e));
    return;
  }
  if (!lock.ok) {
    deps.log("info", "다른 작업이 잠금을 잡고 있어 자동 해설을 건너뜀", { holder: lock.holder?.jobId ?? null });
    return;
  }
  const send = narrationSender(deps, jobId, month);
  let terminal;
  try {
    const result = await produceNarration({ deps, jobId, month, perGu, send, checkDeadline });
    terminal = { state: "done", done: NARR_TOTAL, ...missingNote(result.missing) };
  } catch (e) {
    const message = e instanceof JobError ? e.message : "알 수 없는 오류로 AI 해설을 만들지 못했습니다.";
    if (!(e instanceof JobError)) deps.log("error", "자동 해설 실패", errFields(e));
    terminal = { state: "error", done: 0, message };
  } finally {
    await safeRelease(deps, jobId);
  }
  await send(terminal);
}

/** 이미 있는 달의 해설 작업(POST /api/narrate-month). 잠금은 API 가 잡았고 여기서 finally 로 푼다. */
async function runNarrateJob(event, deps, context) {
  const { store, log } = deps;
  const { jobId } = event;
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    log("error", "해설 작업 입력 오류: jobId 형식", {});
    return { ok: false };
  }
  const month = typeof event.month === "string" ? event.month.slice(0, 6) : "";
  const send = narrationSender(deps, jobId, month);
  const checkDeadline = makeDeadline(deps, context);
  let terminal;
  try {
    if (!validateMonth(event.month, deps.now()).ok) throw new JobError("요청한 월이 올바르지 않아 해설을 만들지 않았습니다.");
    let index = null;
    try {
      const cur = await store.get(INDEX_KEY);
      index = cur ? JSON.parse(cur.text) : null;
    } catch (e) {
      log("error", "index.json 읽기 실패", errFields(e));
    }
    if (!Array.isArray(index?.months) || !index.months.includes(month)) {
      throw new JobError("이 달의 데이터가 없어 해설을 만들 수 없습니다. 먼저 월을 가져와 주세요.");
    }
    // 읽지 못한(없거나 깨진) 구 파일은 "거래 없음"으로 지어내지 않고 그 키를 뺀다(그러면 서울 전체도 뺀다).
    const unreadable = [];
    const perGu = (await mapPool(GU_ORDER, 8, async (gu) => {
      const cur = await store.get(guKey(month, gu)).catch((e) => { log("warn", "구 파일 읽기 실패", { gu, ...errFields(e) }); return null; });
      let data = null;
      try { data = cur ? JSON.parse(cur.text) : null; } catch { data = null; }
      if (!data?.total || !Array.isArray(data.dongs)) {
        unreadable.push(gu);
        log("warn", "구 파일을 읽지 못해 그 해설을 뺀다", { gu });
        return null;
      }
      return { ...data, gu, month };
    })).filter(Boolean);
    if (perGu.length === 0) throw new JobError("이 달의 구 파일을 읽지 못해 해설을 만들 수 없습니다.");
    const result = await produceNarration({ deps, jobId, month, perGu, send, checkDeadline, skip: unreadable });
    terminal = { state: "done", done: NARR_TOTAL, ...missingNote(result.missing) };
  } catch (e) {
    const message = e instanceof JobError ? e.message : "알 수 없는 오류로 AI 해설을 만들지 못했습니다.";
    if (!(e instanceof JobError)) log("error", "해설 작업 실패", errFields(e));
    terminal = { state: "error", done: 0, message };
  } finally {
    await safeRelease(deps, jobId);
  }
  // 잠금을 푼 뒤에 마지막 상태를 알린다(받자마자 다음 작업을 눌러도 409 가 나지 않게)
  await send(terminal);
  return { ok: terminal.state === "done" };
}

async function safeRelease(deps, jobId) {
  try {
    await releaseLock(deps.store, { jobId, nowMs: deps.now() });
  } catch (e) {
    deps.log("error", "잠금 해제 실패(10분 뒤 stale 로 풀림)", errFields(e));
  }
}

/** 수집 done 에 붙일 안내: 페이지 상한에 닿은 구, 11·12월의 다음 해 신고. 없으면 {}. */
function fetchDoneNote(month, cappedGus) {
  const parts = [];
  if (cappedGus.length > 0) parts.push(`일부 구는 거래가 많아 끝까지 받지 못했습니다: ${cappedGus.join(", ")}`);
  if (month.endsWith("11") || month.endsWith("12")) parts.push("11·12월은 다음 해에 신고된 거래가 빠질 수 있습니다");
  return parts.length > 0 ? { message: parts.join(". ") + "." } : {};
}

async function runWorker(event, deps, context) {
  const { env, store, log } = deps;
  const { jobId } = event;
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    log("error", "작업 입력 오류: jobId 형식", {});
    return { ok: false };
  }
  const month = typeof event.month === "string" ? event.month.slice(0, 6) : "";
  const report = createReporter({ publish: deps.publish, record: (m) => writeJobRecord(store, m), log });
  const send = (fields) => report(jobMessage({ jobId, month, total: TOTAL, ...fields, ts: deps.now() }));
  let done = 0;
  let apiKey = "";
  const checkDeadline = makeDeadline(deps, context);
  // 한 구가 실패하면 다른 구도 다음 페이지를 부르지 않는다(첫 오류만 알린다)
  let poolFailed = false;
  const beforePage = () => {
    if (poolFailed) throw new JobError("다른 구에서 오류가 나 수집을 멈췄습니다.");
    checkDeadline();
  };
  let terminal;
  let perGu = null;

  try {
    if (!validateMonth(event.month, deps.now()).ok) throw new JobError("요청한 월이 올바르지 않아 수집하지 않았습니다.");

    try {
      apiKey = String(await deps.getParameter(env.SSM_API_KEY_NAME));
    } catch (e) {
      log("error", "서울 API 키 파라미터를 읽지 못함", errFields(e));
      throw new JobError("서울 API 키를 읽지 못했습니다. SSM 파라미터 설정을 확인해 주세요.");
    }

    const generatedAt = new Date(deps.now()).toISOString();
    const capped = new Set();
    perGu = await mapPool(GU_ORDER, deps.concurrency ?? DEFAULT_CONCURRENCY, async (gu) => {
      try {
        let fetched;
        try {
          fetched = await fetchMonthRows({ fetch: deps.fetch, key: apiKey, gu, month, sleep: deps.sleep, beforePage });
        } catch (e) {
          if (e instanceof JobError) throw e;
          log("error", "서울 API 호출 실패", { gu, ...errFields(e, apiKey) });
          const reason = e instanceof SeoulApiError ? e.message : "알 수 없는 오류";
          throw new JobError(`${gu} 거래를 가져오지 못했습니다(${reason}).`);
        }
        const data = aggregateRows(fetched.rows, { month, gu, generatedAt }, {
          onMalformed: (info) => log("warn", "금액을 읽을 수 없는 행 제외", info),
        });
        // truncated = 페이지 상한에 닿아 그 달을 끝까지 받지 못함(집계 모듈의 "1000건 이상" 대신, 9a fix 결정).
        // index 의 summary[month][gu] 는 이 total 을 그대로 쓰므로 같이 맞는다.
        data.total.truncated = fetched.capped;
        if (fetched.capped) {
          capped.add(gu);
          log("warn", "페이지 상한에 닿음: 그 달 앞부분이 빠졌을 수 있음", { gu, month, pages: fetched.pages });
        }
        done += 1;
        await send({ state: "running", done, gu });
        return data;
      } catch (e) {
        poolFailed = true;
        throw e;
      }
    });

    // 수집이 끝났으면 마감 여유(90초) 안에서 쓰기를 마친다(쓰기 26건 + 무효화는 몇 초).
    try {
      await Promise.all(perGu.map((d) => store.put(guKey(month, d.gu), JSON.stringify(d) + "\n", JSON_PUT)));
    } catch (e) {
      log("error", "구 파일 저장 실패", errFields(e));
      throw new JobError("집계 파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    }

    let existing = null;
    try {
      const cur = await store.get(INDEX_KEY);
      if (cur) existing = JSON.parse(cur.text);
    } catch (e) {
      log("error", "index.json 읽기 실패", errFields(e));
      throw new JobError("기존 월 목록(index.json)을 읽지 못해 갱신하지 않았습니다.");
    }
    const merged = mergeIndex(existing, perGu, { month, generatedAt });
    try {
      await store.put(INDEX_KEY, JSON.stringify(merged, null, 2) + "\n", JSON_PUT);
    } catch (e) {
      log("error", "index.json 저장 실패", errFields(e));
      throw new JobError("월 목록(index.json)을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    }

    if (env.DISTRIBUTION_ID) {
      try {
        await deps.invalidate({ distributionId: env.DISTRIBUTION_ID, paths: ["/data/*"], callerReference: jobId });
      } catch (e) {
        // 데이터는 Cache-Control: no-cache 라 무효화가 없어도 곧 보인다. 작업은 성공으로 친다.
        log("warn", "CloudFront 무효화 실패", errFields(e));
      }
    } else {
      log("warn", "DISTRIBUTION_ID 없음: 무효화를 건너뜀", {});
    }

    const cappedGus = GU_ORDER.filter((gu) => capped.has(gu));
    terminal = { state: "done", done: TOTAL, ...fetchDoneNote(month, cappedGus) };
  } catch (e) {
    const message = e instanceof JobError ? e.message : "알 수 없는 오류로 수집을 마치지 못했습니다.";
    if (!(e instanceof JobError)) log("error", "작업 실패", errFields(e, apiKey));
    terminal = { state: "error", done, message };
  } finally {
    await safeRelease(deps, jobId);
  }
  // 잠금을 푼 뒤에 마지막 상태를 알린다(받자마자 다음 달을 눌러도 409 가 나지 않게)
  await send(terminal);
  if (terminal.state !== "done") return { ok: false };
  log("info", "작업 완료", { jobId, month });
  // 자동 해설은 잠금 없이 돈다(narration.json 만 쓰고 index 는 건드리지 않는다)
  if (env.BEDROCK_MODEL_ID) await autoNarrate({ deps, jobId: `${jobId}-narration`, month, perGu, checkDeadline });
  else log("info", "BEDROCK_MODEL_ID 없음: 자동 해설을 건너뜀", {});
  return { ok: true };
}

/**
 * 배포 뒤 index 재구성. 잠금이 비어 있으면 잡아서 그동안 새 수집이 시작되지 않게 하고(409),
 * 수집 작업이 잡고 있으면 경고만 남기고 그대로 진행한다. 실패해도 던지지 않는다(배포를 깨지 않게).
 */
async function rebuildIndex(deps) {
  const { env, store, log } = deps;
  const nowMs = deps.now();
  const lockId = `rebuild-${deps.randomId()}`;
  let locked = false;
  try {
    locked = (await acquireLock(store, { jobId: lockId, month: null, nowMs })).ok;
    if (!locked) log("warn", "수집 작업이 잠금을 잡고 있음: 잠금 없이 index 를 다시 만든다", {});
  } catch (e) {
    log("warn", "잠금 확인 실패: 잠금 없이 index 를 다시 만든다", errFields(e));
  }
  try {
    const index = await rebuildIndexFromStore(store, { generatedAt: new Date(nowMs).toISOString(), log });
    if (!index) {
      log("error", "index 재구성 실패: 읽을 수 있는 구 파일이 없어 index 를 그대로 둔다", {});
      return { ok: false, months: [] };
    }
    await store.put(INDEX_KEY, JSON.stringify(index, null, 2) + "\n", JSON_PUT);
    if (env.DISTRIBUTION_ID) {
      try {
        await deps.invalidate({ distributionId: env.DISTRIBUTION_ID, paths: ["/data/index.json"], callerReference: lockId });
      } catch (e) {
        log("warn", "CloudFront 무효화 실패", errFields(e));
      }
    }
    log("info", "index 재구성 완료", { months: index.months });
    return { ok: true, months: index.months };
  } catch (e) {
    log("error", "index 재구성 실패: S3 오류로 index 를 그대로 둔다", errFields(e));
    return { ok: false, months: [] };
  } finally {
    if (locked) {
      await releaseLock(store, { jobId: lockId, nowMs: deps.now() }).catch((e) => log("error", "잠금 해제 실패", errFields(e)));
    }
  }
}

/** deps: { env, fetch, store, getParameter, invoke, invalidate, publish, converse, now, sleep, randomId, log, concurrency? } */
export function createHandler(deps) {
  const caches = { passcode: { value: null, at: 0 }, authSecret: { value: null } };
  return async function handle(event, context) {
    if (event?.requestContext?.http) return handleHttp(event, deps, caches);
    if (event?.action === "rebuild-index") return rebuildIndex(deps);
    if (event?.action === "narrate") return runNarrateJob(event, deps, context);
    if (event && typeof event === "object" && "jobId" in event) return runWorker(event, deps, context);
    deps.log("warn", "알 수 없는 이벤트 형식", {});
    return { ok: false };
  };
}

let runtimeHandler = null;

/** Lambda 진입점. 런타임 내장 AWS SDK 는 처음 호출 때 불러온다(테스트는 createHandler 만 쓴다). */
export async function handler(event, context) {
  if (!runtimeHandler) {
    const { makeDefaultDeps } = await import("./aws.mjs");
    runtimeHandler = createHandler(await makeDefaultDeps(process.env));
  }
  return runtimeHandler(event, context);
}
