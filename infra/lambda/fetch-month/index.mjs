// 월 실시간 수집 Lambda (CONTRACTS 10). 두 가지 이벤트를 받는다.
//
// 1) HTTP (Function URL, CloudFront /api/* 뒤): POST /api/fetch-month {"month":"YYYYMM"}, 헤더 x-presenter-key
//    경로 → 메서드 → 암호(401) → 본문·월(400) → 잠금(409) → 작업 기록(running 0/25) → 작업자 Event 호출 → 202 {jobId, month}
// 2) 작업자 (Lambda Event 호출, 페이로드 {jobId, month}):
//    25구 수집·집계 → data/{month}/{gu}.json 25개 → data/index.json 병합 → CloudFront /data/* 무효화 → done
//    구 하나 끝날 때마다 running 발행, 실패하면 error 발행. 잠금은 finally 에서 항상 해제.
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

export const MIN_MONTH = "200601";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ROUTES = new Set(["/api/fetch-month", "/fetch-month"]); // CloudFront 경유, Function URL 직접
const JOB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const DEFAULT_CONCURRENCY = 4;
// 남은 실행 시간이 이만큼 남으면 멈추고 error 를 알린다(페이지 한 번 + 재시도 60초, 쓰기·발행 여유).
// 10분 잠금 stale 시간보다 먼저 끝나므로 다음 작업과 겹치지 않는다.
const DEADLINE_MARGIN_MS = 90_000;
const TOTAL = GU_ORDER.length;

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

function respond(statusCode, body) {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

function fail(statusCode, error, message, extra = {}) {
  return respond(statusCode, { error, message, ...extra });
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

async function handleHttp(event, deps) {
  const { env, store, log } = deps;
  const method = event.requestContext.http.method;
  const path = event.rawPath ?? event.requestContext.http.path;
  if (!ROUTES.has(path)) return fail(404, "not_found", "알 수 없는 경로입니다.");
  if (method !== "POST") return fail(405, "method_not_allowed", "POST 요청만 받습니다.");

  let expected;
  try {
    expected = await deps.getParameter(env.SSM_PASSCODE_NAME);
  } catch (e) {
    log("error", "발표자 암호 파라미터를 읽지 못함", errFields(e));
    return fail(500, "config", "서버 설정을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  if (!passcodeMatches(header(event.headers, "x-presenter-key"), expected)) {
    return fail(401, "unauthorized", "발표자 암호가 맞지 않습니다.");
  }

  const body = parseBody(event);
  if (!body) return fail(400, "bad_request", "요청 본문은 {\"month\": \"YYYYMM\"} 형식의 JSON 이어야 합니다.");
  const nowMs = deps.now();
  const check = validateMonth(body.month, nowMs);
  if (!check.ok) return fail(400, "bad_month", check.message);
  const month = body.month;
  const jobId = deps.randomId();

  let lock;
  try {
    lock = await acquireLock(store, { jobId, month, nowMs });
  } catch (e) {
    log("error", "잠금 확인 실패", errFields(e));
    return fail(500, "lock", "작업 잠금을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
  if (!lock.ok) {
    const holder = lock.holder;
    const message = holder?.month && /^\d{6}$/.test(holder.month)
      ? `${monthLabel(holder.month)} 데이터를 가져오는 중입니다. 끝난 뒤 다시 시도해 주세요.`
      : "다른 달을 가져오는 중입니다. 잠시 뒤 다시 시도해 주세요.";
    return fail(409, "busy", message, holder?.jobId && holder.month ? { jobId: holder.jobId, month: holder.month } : {});
  }

  try {
    await writeJobRecord(store, jobMessage({ jobId, month, state: "running", done: 0, total: TOTAL, ts: nowMs }));
    await deps.invoke({ functionName: env.SELF_FUNCTION_NAME, payload: { jobId, month } });
  } catch (e) {
    log("error", "작업자 호출 실패", errFields(e));
    const message = "수집 작업을 시작하지 못했습니다.";
    await writeJobRecord(store, jobMessage({ jobId, month, state: "error", done: 0, total: TOTAL, message, ts: deps.now() }))
      .catch((err) => log("warn", "작업 기록 쓰기 실패", errFields(err)));
    await releaseLock(store, { jobId, nowMs: deps.now() }).catch((err) => log("error", "잠금 해제 실패", errFields(err)));
    return fail(500, "start_failed", `${message} 잠시 뒤 다시 시도해 주세요.`);
  }
  log("info", "작업 시작", { jobId, month });
  return respond(202, { jobId, month });
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
  const remaining = typeof context?.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : null;
  const deadline = remaining === null ? Infinity : deps.now() + remaining - DEADLINE_MARGIN_MS;
  const checkDeadline = () => {
    if (deps.now() > deadline) throw new JobError("제한 시간 안에 수집을 끝내지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  };

  try {
    if (!validateMonth(event.month, deps.now()).ok) throw new JobError("요청한 월이 올바르지 않아 수집하지 않았습니다.");

    try {
      apiKey = String(await deps.getParameter(env.SSM_API_KEY_NAME));
    } catch (e) {
      log("error", "서울 API 키 파라미터를 읽지 못함", errFields(e));
      throw new JobError("서울 API 키를 읽지 못했습니다. SSM 파라미터 설정을 확인해 주세요.");
    }

    const generatedAt = new Date(deps.now()).toISOString();
    const perGu = await mapPool(GU_ORDER, deps.concurrency ?? DEFAULT_CONCURRENCY, async (gu) => {
      let fetched;
      try {
        fetched = await fetchMonthRows({ fetch: deps.fetch, key: apiKey, gu, month, beforePage: checkDeadline });
      } catch (e) {
        if (e instanceof JobError) throw e;
        log("error", "서울 API 호출 실패", { gu, ...errFields(e, apiKey) });
        const reason = e instanceof SeoulApiError ? e.message : "알 수 없는 오류";
        throw new JobError(`${gu} 거래를 가져오지 못했습니다(${reason}).`);
      }
      if (fetched.capped) log("warn", "페이지 상한에 닿음: 그 달 앞부분이 빠졌을 수 있음", { gu, month, pages: fetched.pages });
      const data = aggregateRows(fetched.rows, { month, gu, generatedAt }, {
        onMalformed: (info) => log("warn", "금액을 읽을 수 없는 행 제외", info),
      });
      done += 1;
      await send({ state: "running", done, gu });
      return data;
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

    await send({ state: "done", done: TOTAL });
    log("info", "작업 완료", { jobId, month });
    return { ok: true };
  } catch (e) {
    const message = e instanceof JobError ? e.message : "알 수 없는 오류로 수집을 마치지 못했습니다.";
    if (!(e instanceof JobError)) log("error", "작업 실패", errFields(e, apiKey));
    await send({ state: "error", done, message });
    return { ok: false };
  } finally {
    try {
      await releaseLock(store, { jobId, nowMs: deps.now() });
    } catch (e) {
      log("error", "잠금 해제 실패(10분 뒤 stale 로 풀림)", errFields(e));
    }
  }
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
      log("warn", "읽을 수 있는 구 파일이 없어 index 를 그대로 둔다", {});
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
    log("error", "index 재구성 실패", errFields(e));
    return { ok: false, months: [] };
  } finally {
    if (locked) {
      await releaseLock(store, { jobId: lockId, nowMs: deps.now() }).catch((e) => log("error", "잠금 해제 실패", errFields(e)));
    }
  }
}

/** deps: { env, fetch, store, getParameter, invoke, invalidate, publish, now, randomId, log, concurrency? } */
export function createHandler(deps) {
  return async function handle(event, context) {
    if (event?.requestContext?.http) return handleHttp(event, deps);
    if (event?.action === "rebuild-index") return rebuildIndex(deps);
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
