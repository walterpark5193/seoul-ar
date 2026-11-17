// 작업 잠금, 작업 기록, index 병합 (CONTRACTS 10.2 ~ 10.4).
// 저장소(store)는 { get(key) → {text, etag} | null, put(key, text, opts) → {etag} } 이다(aws.mjs 의 s3Store, 테스트는 fakes.mjs).
// put 의 opts: { contentType, cacheControl, ifMatch, ifNoneMatch }. 조건이 어긋나면 PreconditionFailed 를 던진다.
// list(prefix) → 키 배열 (index 재구성에서만 쓴다).
import { buildIndex } from "./aggregate.mjs";
import { GU_ORDER } from "./gu.mjs";

export const LOCK_KEY = "data/jobs/lock.json";
export const INDEX_KEY = "data/index.json";
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const JSON_PUT = Object.freeze({ contentType: "application/json; charset=utf-8", cacheControl: "no-cache" });

export const jobKey = (jobId) => `data/jobs/${jobId}.json`;
export const guKey = (month, gu) => `data/${month}/${gu}.json`;

/** 조건부 쓰기(IfMatch / IfNoneMatch)가 어긋남. */
export class PreconditionFailed extends Error {
  constructor() {
    super("조건부 쓰기 실패");
    this.name = "PreconditionFailed";
  }
}

export function isPrecondition(e) {
  if (e instanceof PreconditionFailed) return true;
  const status = e?.$metadata?.httpStatusCode;
  return e?.name === "PreconditionFailed" || e?.name === "ConditionalRequestConflict" || status === 412 || status === 409;
}

/** 사용자에게 그대로 보여 줄 수 있는 작업 오류(한국어 한 문장, 키·URL 없음). */
export class JobError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobError";
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 해제되지 않았고 10분이 지나지 않은 잠금이면 true. */
export function isLockFresh(lock, nowMs) {
  if (!lock || typeof lock !== "object" || lock.released) return false;
  if (typeof lock.ts !== "number" || !Number.isFinite(lock.ts)) return false;
  return Math.abs(nowMs - lock.ts) < LOCK_STALE_MS;
}

function lockText({ jobId, month, nowMs, kind }) {
  const lock = { v: 1, jobId, month, ts: nowMs, startedAt: new Date(nowMs).toISOString() };
  if (kind) lock.kind = kind; // "narration" 이면 409 문구가 "해설을 만드는 중"
  return JSON.stringify(lock);
}

/**
 * 잠금을 잡는다. 없으면 IfNoneMatch "*", 있으면 읽어서 stale/해제면 IfMatch(etag) 로 덮어쓴다.
 * 두 요청이 겹쳐도 조건부 쓰기 하나만 성공한다.
 * @returns {{ok: true} | {ok: false, holder: {jobId, month, kind} | null}}
 */
export async function acquireLock(store, { jobId, month, nowMs, kind }) {
  const text = lockText({ jobId, month, nowMs, kind });
  try {
    await store.put(LOCK_KEY, text, { ...JSON_PUT, ifNoneMatch: "*" });
    return { ok: true };
  } catch (e) {
    if (!isPrecondition(e)) throw e;
  }
  const cur = await store.get(LOCK_KEY);
  if (!cur) return { ok: false, holder: null }; // 사이에 지워졌다: 다음 요청에 맡긴다
  const lock = parseJson(cur.text);
  if (isLockFresh(lock, nowMs)) {
    return {
      ok: false,
      holder: { jobId: String(lock.jobId ?? ""), month: typeof lock.month === "string" ? lock.month : null, kind: typeof lock.kind === "string" ? lock.kind : null },
    };
  }
  try {
    await store.put(LOCK_KEY, text, { ...JSON_PUT, ifMatch: cur.etag });
    return { ok: true };
  } catch (e) {
    if (isPrecondition(e)) return { ok: false, holder: null };
    throw e;
  }
}

/**
 * 자기 잠금이면 해제 표시로 덮어쓴다(IAM 은 Get/Put 만 있으므로 지우지 않는다).
 * 다른 작업이 stale 잠금을 넘겨받은 뒤라면 건드리지 않는다.
 */
export async function releaseLock(store, { jobId, nowMs }) {
  const cur = await store.get(LOCK_KEY);
  if (!cur) return false;
  const lock = parseJson(cur.text);
  if (!lock || lock.jobId !== jobId || lock.released) return false;
  const text = JSON.stringify({ ...lock, released: true, releasedAt: new Date(nowMs).toISOString() });
  try {
    await store.put(LOCK_KEY, text, { ...JSON_PUT, ifMatch: cur.etag });
    return true;
  } catch (e) {
    if (isPrecondition(e)) return false;
    throw e;
  }
}

/** 폴링 폴백: data/jobs/{jobId}.json 에 마지막 JobMessage 를 그대로 쓴다. */
export async function writeJobRecord(store, msg) {
  await store.put(jobKey(msg.jobId), JSON.stringify(msg), JSON_PUT);
}

function isIndexLike(x) {
  return x && typeof x === "object" && x.v === 1 && Array.isArray(x.months) && x.months.every((m) => typeof m === "string")
    && x.summary && typeof x.summary === "object" && !Array.isArray(x.summary);
}

/**
 * 기존 DataIndex 에 한 달을 넣는다. summary[month] 는 aggregate.mjs 의 buildIndex 로 만든 것으로 교체하고
 * 다른 달은 그대로 둔다. months 는 중복 없이 정렬, generatedAt 은 새 값. 기존 객체는 바꾸지 않는다.
 * existing 이 null 이면 그 달 하나짜리 새 index. 형식이 깨졌으면 덮어쓰지 않고 JobError.
 */
export function mergeIndex(existing, monthData, { month, generatedAt }) {
  const fresh = buildIndex([monthData], { months: [month], generatedAt });
  if (existing === null || existing === undefined) return fresh;
  if (!isIndexLike(existing)) throw new JobError("기존 월 목록(index.json) 형식이 올바르지 않아 갱신하지 않았습니다.");
  const months = [...new Set([...existing.months, month])].sort();
  const keys = [...new Set([...Object.keys(existing.summary), month])].sort();
  const summary = {};
  for (const m of keys) summary[m] = m === month ? fresh.summary[month] : existing.summary[m];
  return { ...fresh, months, summary };
}

/** items 를 최대 limit 개씩 동시에 처리한다. 하나라도 실패하면 새 항목을 시작하지 않고, 진행 중인 것을 기다린 뒤 첫 오류를 던진다. */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  async function lane() {
    while (failed === null && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (failed === null) failed = e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed !== null) throw failed;
  return results;
}

const GU_FILE_RE = /^data\/(\d{6})\/([^/]+)\.json$/;
const GU_SET = new Set(GU_ORDER);

/**
 * S3 의 data/YYYYMM/{gu}.json 을 모두 읽어 buildIndex 로 index 를 다시 만든다(배포 뒤 재구성).
 * months 는 오름차순, 빠진 구와 깨진 구 파일은 buildIndex 처럼 빈 Stat, 읽을 수 있는 구 파일이 없는 달은 뺀다.
 * 기존 index 의 source 문자열은 지킨다. 구 파일이 하나도 없으면 null(호출자가 덮어쓰지 않게).
 */
export async function rebuildIndexFromStore(store, { generatedAt, log, concurrency = 8 }) {
  const files = [];
  for (const key of await store.list("data/")) {
    const m = GU_FILE_RE.exec(key);
    if (!m || !GU_SET.has(m[2])) continue; // data/jobs/*, narration.json 등은 건너뛴다
    const mm = Number(m[1].slice(4));
    if (mm >= 1 && mm <= 12) files.push({ month: m[1], gu: m[2] });
  }
  const read = await mapPool(files, concurrency, async ({ month, gu }) => {
    const cur = await store.get(guKey(month, gu));
    const data = cur ? parseJson(cur.text) : null;
    const total = data?.total;
    if (!total || typeof total !== "object" || typeof total.n !== "number") {
      log("warn", "구 파일을 읽지 못해 빈 통계로 둔다", { month, gu });
      return null;
    }
    return { month, gu, total };
  });
  const byMonth = new Map();
  for (const g of read) {
    if (!g) continue;
    if (!byMonth.has(g.month)) byMonth.set(g.month, []);
    byMonth.get(g.month).push(g);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return null;
  const index = buildIndex(months.map((m) => byMonth.get(m)), { months, generatedAt });
  const prev = await store.get(INDEX_KEY).catch(() => null);
  const prevSource = prev ? parseJson(prev.text)?.source : null;
  if (typeof prevSource === "string" && prevSource.trim() !== "") index.source = prevSource;
  return index;
}
