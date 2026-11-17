// 배포된 사이트 버킷의 data/ 스냅샷을 저장소(frontend/public/data/)로 가져온다.
//
//   node tools/data/pull-deployed.mjs --stack SeoulArStack --out frontend/public/data [--region us-east-1] [--dry-run]
//
// - AWS 는 읽기만 한다: CloudFormation DescribeStacks(출력 BucketName), S3 ListObjectsV2(접두사 data/, 페이지 넘김), GetObject.
//   자격 증명은 SDK 기본 체인(이 EC2 의 인스턴스 역할 등).
// - data/jobs/ (작업 기록·잠금)는 목록에만 보이고 받지 않는다.
// - 받을 수 있는 경로는 data/index.json, data/YYYYMM/{구}.json, data/YYYYMM/narration.json 뿐이다. 그 밖의 경로가 있으면 중단한다.
// - 모든 파일을 먼저 받아 검사한다(크기, UTF-8, 금지 문자열, JSON, CONTRACTS 2절 키, narration 모양, index 의 달 = 폴더).
//   하나라도 걸리면 이유를 출력하고 아무것도 쓰지 않는다(exit 1). --dry-run 은 목록·검사만 하고 쓰지 않는다.
// - 통과하면 받은 바이트 그대로 --out 아래 같은 상대 경로에 쓴다. 로컬에만 있는 파일은 지우지 않고 알리기만 한다.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GU_ORDER } from "./gu.mjs";

export const PREFIX = "data/";
/** 출력 어디에도(키·값 모두) 나오면 안 되는 문자열 (CONTRACTS 0절: 본번·부번·건물명). 대소문자 구분. */
export const FORBIDDEN = ["MNO", "SNO", "BLDG_NM", "bldgNm", "본번", "부번"];
export const NARRATION_ALL = "서울 전체";
export const NARRATION_KEYS = [NARRATION_ALL, ...GU_ORDER];

const GU_SET = new Set(GU_ORDER);
const NARRATION_KEY_SET = new Set(NARRATION_KEYS);

// CONTRACTS 2.1 / 2.2 의 키(모두 있어야 하고 그 밖의 키는 없어야 한다)
const GU_TOP_KEYS = ["v", "month", "gu", "generatedAt", "total", "dongs"];
const STAT_KEYS = ["n", "cancelled", "medPerM2", "medAmt", "maxAmt", "truncated"];
const DONG_KEYS = ["name", "n", "cancelled", "nApt", "medPerM2", "medPerM2Apt", "medAmt", "maxAmt", "usage"];
const INDEX_KEYS = ["v", "generatedAt", "source", "months", "gus", "summary"];
// CONTRACTS 12.1 + frontend/src/data/narration.ts. source 는 작업자가 항목마다 "model" | "template" 로 쓰는 선택 필드
// (infra/README 7절, 프론트는 무시).
const NARRATION_REQUIRED = ["v", "month", "generatedAt", "model", "items"];
const NARRATION_ALLOWED = [...NARRATION_REQUIRED, "source"];
const NARRATION_SOURCES = new Set(["model", "template"]);

export function isMonth(s) {
  return typeof s === "string" && /^\d{4}(0[1-9]|1[0-2])$/.test(s);
}

/**
 * S3 키 → 무엇인지. kind: "index" | "gu" | "narration" | "jobs"(받지 않음) | "dir"(0바이트 폴더 표시, 받지 않음) | "unknown"(중단 사유).
 * rel 은 data/ 뒤 상대 경로(= --out 아래 경로).
 */
export function classifyKey(key, size) {
  if (typeof key !== "string" || !key.startsWith(PREFIX)) return { kind: "unknown", key };
  const rel = key.slice(PREFIX.length);
  if (rel.startsWith("jobs/")) return { kind: "jobs", key };
  if ((rel === "" || rel.endsWith("/")) && size === 0) return { kind: "dir", key };
  if (rel === "index.json") return { kind: "index", key, rel };
  const m = /^(\d{6})\/([^/]+)\.json$/.exec(rel);
  if (m && isMonth(m[1])) {
    if (m[2] === "narration") return { kind: "narration", key, rel, month: m[1] };
    if (GU_SET.has(m[2])) return { kind: "gu", key, rel, month: m[1], gu: m[2] };
  }
  return { kind: "unknown", key, rel };
}

/** 목록 [{key, size}] → 받을 것, 건너뛴 수, 모르는 키. */
export function planObjects(objects) {
  const pull = [];
  const unknown = [];
  const skipped = { jobs: 0, dir: 0 };
  for (const { key, size } of objects) {
    const c = classifyKey(key, size);
    if (c.kind === "jobs" || c.kind === "dir") skipped[c.kind]++;
    else if (c.kind === "unknown") unknown.push(key);
    else pull.push({ ...c, size });
  }
  return { pull, skipped, unknown };
}

/** ListObjectsV2 페이지를 끝까지 넘긴다. listPage(params) 는 SDK 응답 모양({Contents, IsTruncated, NextContinuationToken})을 돌려준다. */
export async function listAll(listPage, prefix = PREFIX) {
  const out = [];
  let token;
  for (;;) {
    const page = await listPage({ Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) });
    for (const o of page.Contents ?? []) out.push({ key: o.Key, size: o.Size });
    if (!page.IsTruncated) return out;
    if (!page.NextContinuationToken) throw new Error("ListObjectsV2: IsTruncated 인데 NextContinuationToken 이 없습니다");
    token = page.NextContinuationToken;
  }
}

// ---- 모양 검사 (문제 문장 배열을 돌려준다. 빈 배열이면 통과) ----

function isPlainObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
const isCount = (x) => Number.isInteger(x) && x >= 0;
const isIntOrNull = (x) => x === null || Number.isInteger(x);

function keyProblems(obj, allowed, required, where) {
  if (!isPlainObject(obj)) return [`${where}: 객체가 아님`];
  const out = [];
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(obj)) if (!allowedSet.has(k)) out.push(`${where}: 모르는 키 "${k}"`);
  for (const k of required) if (!Object.hasOwn(obj, k)) out.push(`${where}: 키 "${k}" 없음`);
  return out;
}

export function checkStat(s, where) {
  const out = keyProblems(s, STAT_KEYS, STAT_KEYS, where);
  if (!isPlainObject(s)) return out;
  for (const k of ["n", "cancelled"]) if (Object.hasOwn(s, k) && !isCount(s[k])) out.push(`${where}.${k}: 0 이상 정수가 아님`);
  for (const k of ["medPerM2", "medAmt", "maxAmt"]) if (Object.hasOwn(s, k) && !isIntOrNull(s[k])) out.push(`${where}.${k}: 정수나 null 이 아님`);
  if (Object.hasOwn(s, "truncated") && typeof s.truncated !== "boolean") out.push(`${where}.truncated: boolean 이 아님`);
  return out;
}

/** data/YYYYMM/{구}.json (CONTRACTS 2.2). */
export function checkGuData(d, { month, gu }) {
  const out = keyProblems(d, GU_TOP_KEYS, GU_TOP_KEYS, "최상위");
  if (!isPlainObject(d)) return out;
  if (d.v !== 1) out.push("v 가 1 이 아님");
  if (d.month !== month) out.push(`month "${d.month}" 가 폴더 ${month} 와 다름`);
  if (d.gu !== gu) out.push(`gu "${d.gu}" 가 파일 이름 ${gu} 와 다름`);
  if (typeof d.generatedAt !== "string") out.push("generatedAt 이 문자열이 아님");
  if (Object.hasOwn(d, "total")) out.push(...checkStat(d.total, "total"));
  if (!Array.isArray(d.dongs)) {
    if (Object.hasOwn(d, "dongs")) out.push("dongs 가 배열이 아님");
    return out;
  }
  d.dongs.forEach((x, i) => {
    const where = `dongs[${i}]`;
    out.push(...keyProblems(x, DONG_KEYS, DONG_KEYS, where));
    if (!isPlainObject(x)) return;
    if (typeof x.name !== "string" || x.name.length === 0) out.push(`${where}.name: 빈 문자열이거나 문자열이 아님`);
    for (const k of ["n", "cancelled", "nApt"]) if (Object.hasOwn(x, k) && !isCount(x[k])) out.push(`${where}.${k}: 0 이상 정수가 아님`);
    for (const k of ["medPerM2", "medPerM2Apt", "medAmt", "maxAmt"]) {
      if (Object.hasOwn(x, k) && !isIntOrNull(x[k])) out.push(`${where}.${k}: 정수나 null 이 아님`);
    }
    if (Object.hasOwn(x, "usage")) {
      if (!isPlainObject(x.usage)) out.push(`${where}.usage: 객체가 아님`);
      else for (const [k, v] of Object.entries(x.usage)) if (!isCount(v)) out.push(`${where}.usage["${k}"]: 0 이상 정수가 아님`);
    }
  });
  return out;
}

/** data/YYYYMM/narration.json (CONTRACTS 12.1, narration.ts isNarration 보다 엄격). */
export function checkNarration(n, { month }) {
  const out = keyProblems(n, NARRATION_ALLOWED, NARRATION_REQUIRED, "최상위");
  if (!isPlainObject(n)) return out;
  if (n.v !== 1) out.push("v 가 1 이 아님");
  if (n.month !== month) out.push(`month "${n.month}" 가 폴더 ${month} 와 다름`);
  if (typeof n.generatedAt !== "string") out.push("generatedAt 이 문자열이 아님");
  if (typeof n.model !== "string") out.push("model 이 문자열이 아님");
  if (Object.hasOwn(n, "items")) {
    if (!isPlainObject(n.items)) out.push("items 가 객체가 아님");
    else {
      for (const [k, v] of Object.entries(n.items)) {
        if (!NARRATION_KEY_SET.has(k)) out.push(`items: 모르는 키 "${k}"`);
        if (typeof v !== "string") out.push(`items["${k}"]: 문자열이 아님`);
      }
    }
  }
  if (Object.hasOwn(n, "source")) {
    if (!isPlainObject(n.source)) out.push("source 가 객체가 아님");
    else {
      for (const [k, v] of Object.entries(n.source)) {
        if (!NARRATION_KEY_SET.has(k)) out.push(`source: 모르는 키 "${k}"`);
        if (!NARRATION_SOURCES.has(v)) out.push(`source["${k}"]: "model" 이나 "template" 이 아님`);
      }
    }
  }
  return out;
}

/** data/index.json (CONTRACTS 2.1). 폴더와의 대조는 scanSet 에서 한다. */
export function checkIndex(x) {
  const out = keyProblems(x, INDEX_KEYS, INDEX_KEYS, "최상위");
  if (!isPlainObject(x)) return out;
  if (x.v !== 1) out.push("v 가 1 이 아님");
  if (typeof x.generatedAt !== "string") out.push("generatedAt 이 문자열이 아님");
  if (typeof x.source !== "string") out.push("source 가 문자열이 아님");
  const months = Array.isArray(x.months) ? x.months : null;
  if (!months) out.push("months 가 배열이 아님");
  else {
    if (!months.every(isMonth)) out.push("months 에 YYYYMM 이 아닌 값이 있음");
    else if (new Set(months).size !== months.length) out.push("months 에 중복이 있음");
    else if (months.some((m, i) => i > 0 && months[i - 1] >= m)) out.push("months 가 오름차순이 아님");
  }
  if (!Array.isArray(x.gus) || x.gus.length !== GU_ORDER.length || x.gus.some((g, i) => g !== GU_ORDER[i])) {
    out.push("gus 가 GU_ORDER 25개(순서 포함)와 다름");
  }
  if (!isPlainObject(x.summary)) {
    if (Object.hasOwn(x, "summary")) out.push("summary 가 객체가 아님");
    return out;
  }
  const monthSet = new Set(months ?? []);
  for (const m of Object.keys(x.summary)) if (!monthSet.has(m)) out.push(`summary: months 에 없는 달 "${m}"`);
  for (const m of monthSet) if (!Object.hasOwn(x.summary, m)) out.push(`summary: ${m} 없음`);
  for (const [m, byGu] of Object.entries(x.summary)) {
    out.push(...keyProblems(byGu, GU_ORDER, GU_ORDER, `summary.${m}`));
    if (!isPlainObject(byGu)) continue;
    for (const [g, s] of Object.entries(byGu)) if (GU_SET.has(g)) out.push(...checkStat(s, `summary.${m}.${g}`));
  }
  return out;
}

/** 파일 하나: UTF-8 → 금지 문자열(원문 전체) → JSON → 종류별 모양. { reasons, value } */
export function scanFile(entry, bytes) {
  const reasons = [];
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { reasons: ["UTF-8 로 읽을 수 없음"], value: undefined };
  }
  for (const s of FORBIDDEN) if (text.includes(s)) reasons.push(`금지 문자열 "${s}"`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    reasons.push(`JSON 파싱 실패: ${e.message}`);
    return { reasons, value: undefined };
  }
  if (entry.kind === "gu") reasons.push(...checkGuData(value, entry));
  else if (entry.kind === "narration") reasons.push(...checkNarration(value, entry));
  else if (entry.kind === "index") reasons.push(...checkIndex(value));
  else reasons.push(`받을 종류가 아님(${entry.kind})`);
  return { reasons, value };
}

/**
 * 받은 파일 전체 검사. files: [{entry, bytes}], unknown: 모르는 키 목록.
 * 파일별 검사 + 크기 대조 + index.json 하나 + index.months = 달 폴더 + 폴더마다 25구.
 * @returns {{ problems: {key: string, reason: string}[], months: string[], narrations: number, bytes: number }}
 */
export function scanSet(files, unknown = []) {
  const problems = [];
  const add = (key, reason) => problems.push({ key, reason });
  for (const key of unknown) add(key, "받을 수 없는 경로(허용: data/index.json, data/YYYYMM/{구}.json, data/YYYYMM/narration.json)");

  let index;
  let indexCount = 0;
  const guByMonth = new Map();
  let narrations = 0;
  let bytes = 0;
  for (const { entry, bytes: b } of files) {
    bytes += b.length;
    if (typeof entry.size === "number" && entry.size !== b.length) add(entry.key, `크기 불일치(목록 ${entry.size}, 받음 ${b.length})`);
    const { reasons, value } = scanFile(entry, b);
    for (const r of reasons) add(entry.key, r);
    if (entry.kind === "index") {
      indexCount++;
      if (reasons.length === 0) index = value;
    } else {
      if (!guByMonth.has(entry.month)) guByMonth.set(entry.month, new Set());
      if (entry.kind === "gu") guByMonth.get(entry.month).add(entry.gu);
      else narrations++;
    }
  }

  const folders = [...guByMonth.keys()].sort();
  for (const m of folders) {
    const missing = GU_ORDER.filter((g) => !guByMonth.get(m).has(g));
    if (missing.length) add(`${PREFIX}${m}/`, `구 파일 ${missing.length}개 없음: ${missing.join(", ")}`);
  }
  if (indexCount === 0) add(`${PREFIX}index.json`, "없음");
  if (index) {
    const listed = new Set(index.months);
    for (const m of folders) if (!listed.has(m)) add(`${PREFIX}index.json`, `폴더 ${m} 가 months 에 없음`);
    for (const m of index.months) if (!guByMonth.has(m)) add(`${PREFIX}index.json`, `months 의 ${m} 폴더가 없음`);
  }
  return { problems, months: folders, narrations, bytes };
}

/** --out 아래 rel 의 절대 경로. 밖으로 나가면 던진다. */
export function safeTarget(outDir, rel) {
  const base = path.resolve(outDir);
  const target = path.resolve(base, ...rel.split("/"));
  const r = path.relative(base, target);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) throw new Error(`출력 폴더 밖 경로: ${rel}`);
  return target;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function readOrNull(file) {
  try {
    return await readFile(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** 받은 바이트 그대로 쓴다(같으면 건드리지 않음). 로컬에만 있는 파일은 지우지 않고 돌려준다. */
export async function writeSnapshot(outDir, files) {
  const result = { added: [], changed: [], unchanged: [], localOnly: [] };
  const targets = files.map(({ entry }) => safeTarget(outDir, entry.rel)); // 쓰기 전에 전부 확인
  const base = path.resolve(outDir);
  await mkdir(base, { recursive: true });
  for (let i = 0; i < files.length; i++) {
    const { entry, bytes } = files[i];
    const prev = await readOrNull(targets[i]);
    if (prev && Buffer.compare(prev, bytes) === 0) {
      result.unchanged.push(entry.rel);
      continue;
    }
    await mkdir(path.dirname(targets[i]), { recursive: true });
    await writeFile(targets[i], bytes);
    (prev ? result.changed : result.added).push(entry.rel);
  }
  const pulled = new Set(files.map(({ entry }) => entry.rel));
  for (const e of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = path.relative(base, path.join(e.parentPath, e.name)).split(path.sep).join("/");
    if (!pulled.has(rel)) result.localOnly.push(rel);
  }
  result.localOnly.sort();
  return result;
}

/**
 * 전체 흐름. api 는 주입한다(테스트는 가짜, CLI 는 awsApi):
 *   bucketName(stack) → 이름, listPage(bucket, params) → ListObjectsV2 응답, getBytes(bucket, key) → Uint8Array
 */
export async function pullDeployed({ api, stack, outDir, dryRun = false, concurrency = 8 }) {
  const bucket = await api.bucketName(stack);
  const listed = await listAll((params) => api.listPage(bucket, params));
  const plan = planObjects(listed);
  const files = await mapPool(plan.pull, concurrency, async (entry) => ({
    entry,
    bytes: Buffer.from(await api.getBytes(bucket, entry.key)),
  }));
  const scan = scanSet(files, plan.unknown);
  const summary = {
    bucket,
    listed: listed.length,
    skipped: plan.skipped,
    pulled: files.length,
    bytes: scan.bytes,
    months: scan.months,
    narrations: scan.narrations,
    problems: scan.problems,
  };
  if (scan.problems.length || dryRun) return { ok: scan.problems.length === 0, dryRun, ...summary, written: null };
  const written = await writeSnapshot(outDir, files);
  return { ok: true, dryRun, ...summary, written };
}

/** 실제 AWS(SDK v3). 읽기 호출 셋만 쓴다. */
export async function awsApi(region) {
  const { CloudFormationClient, DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const cfn = new CloudFormationClient({ region });
  const s3 = new S3Client({ region });
  return {
    async bucketName(stack) {
      const res = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
      const out = res.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "BucketName");
      if (!out?.OutputValue) throw new Error(`스택 ${stack} 에 BucketName 출력이 없습니다`);
      return out.OutputValue;
    },
    listPage: (bucket, params) => s3.send(new ListObjectsV2Command({ Bucket: bucket, ...params })),
    async getBytes(bucket, key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body.transformToByteArray();
    },
  };
}

function report(r) {
  const lines = [];
  lines.push(`버킷 ${r.bucket}: data/ 아래 ${r.listed}개 나열, jobs ${r.skipped.jobs}개·폴더 표시 ${r.skipped.dir}개는 받지 않음`);
  lines.push(`받음 ${r.pulled}개, ${r.bytes.toLocaleString("en-US")} 바이트`);
  const m = r.months;
  lines.push(`달 ${m.length}개${m.length ? ` (${m[0]} … ${m.at(-1)})` : ""}, narration.json ${r.narrations}개`);
  if (r.problems.length) {
    lines.push(`검사 실패 ${r.problems.length}건 — 아무것도 쓰지 않았습니다:`);
    for (const p of r.problems) lines.push(`  ${p.key}: ${p.reason}`);
  } else {
    lines.push("검사 통과: JSON, CONTRACTS 2절 키, narration 모양, 금지 문자열 없음, index 의 달 = 폴더");
  }
  if (r.ok && r.dryRun) lines.push("--dry-run: 쓰지 않았습니다");
  if (r.written) {
    const w = r.written;
    lines.push(`썼음: 새 파일 ${w.added.length}, 바뀐 파일 ${w.changed.length}, 같음 ${w.unchanged.length}`);
    for (const f of w.changed) lines.push(`  바뀜 ${f}`);
    if (w.localOnly.length) lines.push(`로컬에만 있는 파일 ${w.localOnly.length}개(지우지 않음): ${w.localOnly.join(", ")}`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      stack: { type: "string" },
      out: { type: "string" },
      region: { type: "string", default: "us-east-1" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.stack || !values.out) {
    console.error("사용법: node tools/data/pull-deployed.mjs --stack SeoulArStack --out frontend/public/data [--region us-east-1] [--dry-run]");
    return 2;
  }
  const api = await awsApi(values.region);
  const r = await pullDeployed({ api, stack: values.stack, outDir: values.out, dryRun: values["dry-run"] });
  (r.ok ? console.log : console.error)(report(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(`실패: ${e.name ?? "Error"}: ${e.message}`); process.exitCode = 1; },
  );
}
