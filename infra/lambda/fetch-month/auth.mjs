// 발표자 암호 무차별 대입 방어 (9a fix round 1, S2).
// 접속 IP 마다 실패 횟수를 data/jobs/_auth/<sha256(ip)>.json 에 둔다(Cache-Control: no-store, 원래 IP 는 쓰지 않는다).
// 첫 실패부터 10분 창 안에 10번 틀리면 그때부터 10분 동안 429. 맞히면 초기화.
// 저장소 오류는 통과시킨다(fail-open): S3 가 잠깐 안 되면 발표자가 막히지 않게. 호출자가 warn 을 남긴다.
import { createHash } from "node:crypto";

export const AUTH_PREFIX = "data/jobs/_auth/";
export const AUTH_MAX_FAILS = 10;
export const AUTH_WINDOW_MS = 10 * 60 * 1000;
export const AUTH_LOCK_MS = 10 * 60 * 1000;
const AUTH_PUT = Object.freeze({ contentType: "application/json; charset=utf-8", cacheControl: "no-store" });

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  if (name in headers) return headers[name];
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/**
 * 접속한 사람의 IP. CloudFront 가 붙이는 CloudFront-Viewer-Address("ip:port", ALL_VIEWER_EXCEPT_HOST_HEADER 가 넘긴다)를
 * 먼저 쓴다. CloudFront 뒤에서 requestContext.http.sourceIp 는 CloudFront 엣지 주소라서 대체값으로만 쓴다.
 */
export function clientIp(event) {
  const viewer = headerValue(event?.headers, "cloudfront-viewer-address");
  if (typeof viewer === "string" && viewer.trim() !== "") return viewer.trim().replace(/:\d+$/, "");
  const ip = event?.requestContext?.http?.sourceIp;
  return typeof ip === "string" && ip !== "" ? ip : "unknown";
}

export const authKey = (ip) => `${AUTH_PREFIX}${createHash("sha256").update(ip, "utf8").digest("hex")}.json`;

/**
 * 기록 읽기. 없으면 null. API 역할에는 s3:ListBucket 이 없어서 없는 키를 읽으면 S3 가 404 대신 403 을 준다.
 * data/jobs/* GetObject 는 허용돼 있으므로 이 접두사의 403 은 "없음"으로 본다.
 */
export async function loadAuth(store, ip) {
  const key = authKey(ip);
  let cur;
  try {
    cur = await store.get(key);
  } catch (e) {
    if (e?.name === "AccessDenied" || e?.$metadata?.httpStatusCode === 403) return { key, record: null };
    throw e;
  }
  let record = null;
  try {
    record = cur ? JSON.parse(cur.text) : null;
  } catch {
    record = null;
  }
  return { key, record: record && typeof record === "object" ? record : null };
}

/** 잠겨 있으면 남은 ms, 아니면 0. */
export function lockRemainingMs(record, nowMs) {
  const until = record?.lockedUntil;
  return typeof until === "number" && until > nowMs ? until - nowMs : 0;
}

/** 실패 한 번을 센다. 창(첫 실패부터 10분)이 지났으면 새로 센다. 10번째에서 잠근다. */
export async function noteFailure(store, { key, record }, nowMs) {
  const fresh = typeof record?.windowStart === "number" && typeof record?.count === "number" && nowMs - record.windowStart < AUTH_WINDOW_MS;
  const windowStart = fresh ? record.windowStart : nowMs;
  const count = (fresh ? record.count : 0) + 1;
  const lockedUntil = count >= AUTH_MAX_FAILS ? nowMs + AUTH_LOCK_MS : 0;
  const next = { v: 1, windowStart, count, lockedUntil };
  await store.put(key, JSON.stringify(next), AUTH_PUT);
  return next;
}

/** 맞히면 초기화(셀 것이 있을 때만 쓴다). */
export async function noteSuccess(store, { key, record }) {
  if (!record || (!record.count && !record.lockedUntil)) return;
  await store.put(key, JSON.stringify({ v: 1, windowStart: 0, count: 0, lockedUntil: 0 }), AUTH_PUT);
}
