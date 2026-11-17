// 발표자 암호 무차별 대입 방어 (9a fix S2, 11a 강화, security round).
// 접속(IP, IPv6 는 /64)마다 시도 횟수를 **비공개 인증 상태 버킷**(AUTH_BUCKET, 사이트와 따로, 공개 경로 없음)의
// attempts/<HMAC-SHA256(ip, 서버 쪽 임의 비밀)>.json 에 둔다.
//   - 비밀은 CDK 가 만든 임의 값(AUTH_SECRET_ARN)이다. 발표자 암호에서는 아무것도 유도하지 않는다
//     (암호에서 유도하면 공개된 기록 이름으로 암호를 오프라인 대입할 수 있었다). 원래 주소는 어디에도 쓰지 않는다.
//   - 시도는 암호를 비교하기 "전에" 센다(ETag 조건부 쓰기: 처음 IfNoneMatch "*", 갱신 IfMatch). 경합이면 3번까지 다시.
//     기록하지 못하면 비교하지 않고 거절한다(fail-closed). 맞히면 셈을 지운다.
//   - 첫 시도부터 10분 창 안에 10번째 시도에서 잠그고, 그 시도도 틀리면 10분 동안 429.
import { createHmac } from "node:crypto";
import { isPrecondition } from "./job.mjs";

export const AUTH_PREFIX = "attempts/";
export const AUTH_MAX_FAILS = 10;
export const AUTH_WINDOW_MS = 10 * 60 * 1000;
export const AUTH_LOCK_MS = 10 * 60 * 1000;
export const AUTH_WRITE_TRIES = 3;
const AUTH_PUT = Object.freeze({ contentType: "application/json; charset=utf-8", cacheControl: "no-store" });

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  if (name in headers) return headers[name];
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/**
 * 접속한 사람의 IP. CloudFront 가 붙이는 CloudFront-Viewer-Address("ip:port", IPv6 는 "addr:port" 또는 "[addr]:port")를
 * 먼저 쓴다(ALL_VIEWER_EXCEPT_HOST_HEADER 가 넘긴다). CloudFront 뒤에서 sourceIp 는 엣지 주소라 대체값으로만 쓴다.
 */
export function clientIp(event) {
  const viewer = headerValue(event?.headers, "cloudfront-viewer-address");
  if (typeof viewer === "string" && viewer.trim() !== "") {
    const v = viewer.trim();
    const bracket = /^\[([^\]]+)\]/.exec(v);
    return bracket ? bracket[1] : v.replace(/:\d+$/, "");
  }
  const ip = event?.requestContext?.http?.sourceIp;
  return typeof ip === "string" && ip !== "" ? ip : "unknown";
}

function expandIpv6(ip) {
  const [head, tail = null] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail === null ? [] : tail ? tail.split(":") : [];
  const fill = tail === null ? [] : new Array(Math.max(0, 8 - a.length - b.length)).fill("0");
  const groups = [...a, ...fill, ...b];
  return groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups : null;
}

/** 셈의 단위: IPv4 는 그대로, IPv6 는 /64 접두사(한 사람이 보통 /64 하나를 쓴다), IPv4-mapped 는 IPv4. */
export function keyMaterial(ip) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** 인증 상태 버킷 안의 키. secret 은 서버 쪽 임의 비밀(발표자 암호와 무관). */
export const authKey = (ip, secret) => `${AUTH_PREFIX}${createHmac("sha256", secret).update(keyMaterial(ip), "utf8").digest("hex")}.json`;

/**
 * 기록 읽기 → { record, etag }. 없으면 record null.
 * API 역할에는 s3:ListBucket 이 없어서 없는 키를 읽으면 S3 가 404 대신 403 을 준다. 이 접두사의 403 은 "없음"이다.
 */
export async function loadAuth(store, key) {
  let cur;
  try {
    cur = await store.get(key);
  } catch (e) {
    if (e?.name === "AccessDenied" || e?.$metadata?.httpStatusCode === 403) return { record: null, etag: null };
    throw e;
  }
  if (!cur) return { record: null, etag: null };
  let record = null;
  try {
    record = JSON.parse(cur.text);
  } catch {
    record = null;
  }
  return { record: record && typeof record === "object" ? record : null, etag: cur.etag ?? null };
}

/** 잠겨 있으면 남은 ms, 아니면 0. */
export function lockRemainingMs(record, nowMs) {
  const until = record?.lockedUntil;
  return typeof until === "number" && until > nowMs ? until - nowMs : 0;
}

function writeOpts(etag) {
  return etag ? { ...AUTH_PUT, ifMatch: etag } : { ...AUTH_PUT, ifNoneMatch: "*" };
}

/**
 * 비교 전에 시도 하나를 센다. 잠겨 있으면 { ok: false, lockedMs }, 기록했으면 { ok: true, record, etag }.
 * 조건부 쓰기가 AUTH_WRITE_TRIES 번 모두 어긋나거나 저장소 오류면 던진다(호출자는 비교 없이 거절).
 */
export async function registerAttempt(store, key, nowMs) {
  for (let i = 0; i < AUTH_WRITE_TRIES; i++) {
    const { record, etag } = await loadAuth(store, key);
    const lockedMs = lockRemainingMs(record, nowMs);
    if (lockedMs > 0) return { ok: false, lockedMs };
    const fresh = typeof record?.windowStart === "number" && typeof record?.count === "number" && record.count > 0
      && nowMs - record.windowStart < AUTH_WINDOW_MS;
    const windowStart = fresh ? record.windowStart : nowMs;
    const count = (fresh ? record.count : 0) + 1;
    const next = { v: 1, windowStart, count, lockedUntil: count >= AUTH_MAX_FAILS ? nowMs + AUTH_LOCK_MS : 0 };
    try {
      const out = await store.put(key, JSON.stringify(next), writeOpts(etag));
      return { ok: true, record: next, etag: out?.etag ?? null };
    } catch (e) {
      if (!isPrecondition(e)) throw e;
    }
  }
  throw new Error("암호 시도 기록 경합: 조건부 쓰기가 계속 어긋남");
}

/** 맞히면 셈을 지운다. 방금 쓴 etag 로 시작하고, 어긋나면 다시 읽어 3번까지. */
export async function clearAttempts(store, key, etag) {
  let tag = etag;
  for (let i = 0; i < AUTH_WRITE_TRIES; i++) {
    try {
      await store.put(key, JSON.stringify({ v: 1, windowStart: 0, count: 0, lockedUntil: 0 }), writeOpts(tag));
      return;
    } catch (e) {
      if (!isPrecondition(e)) throw e;
      tag = (await loadAuth(store, key)).etag;
    }
  }
  throw new Error("암호 시도 기록 경합: 초기화 실패");
}
