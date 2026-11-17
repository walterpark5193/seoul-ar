import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyKey, planObjects, listAll, scanFile, scanSet, safeTarget, pullDeployed, NARRATION_ALL,
} from "./pull-deployed.mjs";
import { GU_ORDER } from "./gu.mjs";

// ---- 픽스처 (실제 AWS 없음) ----

const AT = "2026-11-17T07:00:00.000Z";
const stat = (over = {}) => ({ n: 3, cancelled: 1, medPerM2: 1200, medAmt: 50000, maxAmt: 90000, truncated: false, ...over });
const dong = (over = {}) => ({
  name: "대치동", n: 3, cancelled: 1, nApt: 2, medPerM2: 1200, medPerM2Apt: 1300, medAmt: 50000, maxAmt: 90000,
  usage: { 아파트: 2, 오피스텔: 1 }, ...over,
});
const guData = (month, gu, over = {}) => ({ v: 1, month, gu, generatedAt: AT, total: stat(), dongs: [dong()], ...over });
const narration = (month, over = {}) => ({
  v: 1, month, generatedAt: AT, model: "us.anthropic.claude-haiku-5-5",
  items: { [NARRATION_ALL]: "서울 매매 1,014건입니다.", 강남구: "강남구: ㎡당 중앙값 1,564만원." },
  source: { [NARRATION_ALL]: "model", 강남구: "template" },
  ...over,
});
const index = (months, over = {}) => ({
  v: 1, generatedAt: AT, source: "서울 열린데이터광장 부동산 실거래가(tbLnOpendataRtmsV)",
  months: [...months], gus: [...GU_ORDER],
  summary: Object.fromEntries(months.map((m) => [m, Object.fromEntries(GU_ORDER.map((g) => [g, stat()]))])),
  ...over,
});
const enc = (obj) => Buffer.from(JSON.stringify(obj));

/** 키 → 바이트. 달마다 25구 + narration, index, 그리고 받으면 안 되는 data/jobs/*. */
function goodBucket(months = ["202610", "202611"]) {
  const objs = new Map();
  for (const m of months) {
    for (const g of GU_ORDER) objs.set(`data/${m}/${g}.json`, enc(guData(m, g)));
    objs.set(`data/${m}/narration.json`, enc(narration(m)));
  }
  objs.set("data/index.json", enc(index(months)));
  objs.set("data/jobs/lock.json", enc({ jobId: "x", MNO: "0316" }));
  objs.set("data/jobs/fetch-202611-1.json", enc({ state: "done" }));
  objs.set("data/jobs/_auth/abc.json", enc({ tries: 3 }));
  return objs;
}

/** 가짜 api. getBytes 호출 키를 기록하고, 목록은 pageSize 개씩 페이지로 나눈다. */
function fakeApi(objs, { pageSize = 7, sizes = {} } = {}) {
  const calls = { get: [], pages: 0 };
  const keys = [...objs.keys()].sort();
  return {
    calls,
    async bucketName(stack) {
      expect(stack).toBe("SeoulArStack");
      return "seoul-bucket";
    },
    async listPage(bucket, { Prefix, ContinuationToken }) {
      expect(bucket).toBe("seoul-bucket");
      calls.pages++;
      const all = keys.filter((k) => k.startsWith(Prefix));
      const start = ContinuationToken ? Number(ContinuationToken) : 0;
      const chunk = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return {
        Contents: chunk.map((k) => ({ Key: k, Size: sizes[k] ?? objs.get(k).length })),
        IsTruncated: more,
        ...(more ? { NextContinuationToken: String(start + pageSize) } : {}),
      };
    },
    async getBytes(bucket, key) {
      calls.get.push(key);
      return new Uint8Array(objs.get(key));
    },
  };
}

const reasonsOf = (entry, obj) => scanFile(entry, typeof obj === "string" ? Buffer.from(obj) : enc(obj)).reasons;
const GU_ENTRY = { kind: "gu", key: "data/202611/강남구.json", rel: "202611/강남구.json", month: "202611", gu: "강남구" };
const NAR_ENTRY = { kind: "narration", key: "data/202611/narration.json", rel: "202611/narration.json", month: "202611" };
const IDX_ENTRY = { kind: "index", key: "data/index.json", rel: "index.json" };

// ---- 경로 ----

describe("classifyKey / planObjects", () => {
  it("index, 구 파일, narration 은 받고 rel 은 data/ 뒤 경로", () => {
    expect(classifyKey("data/index.json", 10)).toMatchObject({ kind: "index", rel: "index.json" });
    expect(classifyKey("data/202401/강남구.json", 10)).toMatchObject({ kind: "gu", rel: "202401/강남구.json", month: "202401", gu: "강남구" });
    expect(classifyKey("data/202611/narration.json", 10)).toMatchObject({ kind: "narration", month: "202611" });
  });

  it("data/jobs/ 아래는 전부 jobs(받지 않음), 0바이트 폴더 표시는 dir", () => {
    for (const k of ["data/jobs/lock.json", "data/jobs/x-narration.json", "data/jobs/_auth/a.json"]) expect(classifyKey(k, 5).kind).toBe("jobs");
    expect(classifyKey("data/", 0).kind).toBe("dir");
    expect(classifyKey("data/202611/", 0).kind).toBe("dir");
  });

  it("그 밖의 경로는 unknown", () => {
    for (const k of [
      "data/202613/강남구.json", // 없는 달
      "data/202611/강남.json", // 없는 구
      "data/202611/sub/강남구.json",
      "data/202611/../index.json",
      "data/202611/강남구.json.bak",
      "data/jobs", // 슬래시 없음
      "data/notes.txt",
      "config.json",
      "data/202611/", // 0바이트가 아닌 폴더 키
    ]) expect(classifyKey(k, 3).kind, k).toBe("unknown");
  });

  it("planObjects: jobs 는 세기만 하고 받을 목록에 넣지 않는다", () => {
    const plan = planObjects([
      { key: "data/index.json", size: 1 },
      { key: "data/jobs/lock.json", size: 1 },
      { key: "data/jobs/a.json", size: 1 },
      { key: "data/202611/중구.json", size: 1 },
      { key: "data/x.txt", size: 1 },
    ]);
    expect(plan.pull.map((e) => e.key)).toEqual(["data/index.json", "data/202611/중구.json"]);
    expect(plan.skipped).toEqual({ jobs: 2, dir: 0 });
    expect(plan.unknown).toEqual(["data/x.txt"]);
  });

  it("listAll: ContinuationToken 으로 끝까지 넘기고, 토큰 없는 IsTruncated 는 오류", async () => {
    const api = fakeApi(goodBucket(["202611"]), { pageSize: 5 });
    const all = await listAll((p) => api.listPage("seoul-bucket", p));
    expect(all).toHaveLength(26 + 1 + 3);
    expect(api.calls.pages).toBe(6);
    await expect(listAll(async () => ({ Contents: [], IsTruncated: true }))).rejects.toThrow(/NextContinuationToken/);
  });

  it("safeTarget: 출력 폴더 안만 허용", () => {
    expect(safeTarget("/tmp/out", "202611/강남구.json")).toBe(path.join("/tmp/out", "202611", "강남구.json"));
    expect(() => safeTarget("/tmp/out", "../escape.json")).toThrow(/밖/);
    expect(() => safeTarget("/tmp/out", "202611/../../x.json")).toThrow(/밖/);
    expect(() => safeTarget("/tmp/out", "")).toThrow(/밖/);
  });
});

// ---- 파일 검사 ----

describe("scanFile", () => {
  it("좋은 구 파일·narration·index 는 통과", () => {
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구"))).toEqual([]);
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { total: stat({ n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null }), dongs: [] }))).toEqual([]);
    expect(reasonsOf(NAR_ENTRY, narration("202611"))).toEqual([]);
    const { source, ...noSource } = narration("202611");
    expect(source).toBeDefined();
    expect(reasonsOf(NAR_ENTRY, noSource)).toEqual([]); // source 는 선택
    expect(reasonsOf(IDX_ENTRY, index(["202610", "202611"]))).toEqual([]);
  });

  it("금지 필드(MNO·SNO·BLDG_NM·bldgNm)는 어디에 있어도 거부", () => {
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { dongs: [{ ...dong(), MNO: "0316" }] }))).toEqual(
      expect.arrayContaining(['금지 문자열 "MNO"', 'dongs[0]: 모르는 키 "MNO"']),
    );
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { SNO: "1" }))).toContain('금지 문자열 "SNO"');
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { dongs: [dong({ usage: { BLDG_NM: 1 } })] }))).toContain('금지 문자열 "BLDG_NM"');
    expect(reasonsOf(IDX_ENTRY, { ...index(["202611"]), bldgNm: "x" })).toContain('금지 문자열 "bldgNm"');
  });

  it("narration 문장에 본번·부번이 있으면 거부", () => {
    const bad = narration("202611", { items: { 강남구: "강남구 대치동 본번 316 거래가 가장 비쌌습니다." } });
    expect(reasonsOf(NAR_ENTRY, bad)).toContain('금지 문자열 "본번"');
    const bad2 = narration("202611", { items: { 중구: "부번 1" } });
    expect(reasonsOf(NAR_ENTRY, bad2)).toContain('금지 문자열 "부번"');
  });

  it("모르는 키 거부: 최상위, total, 법정동, narration, index", () => {
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { rows: [] }))).toContain('최상위: 모르는 키 "rows"');
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { total: { ...stat(), sumAmt: 1 } }))).toContain('total: 모르는 키 "sumAmt"');
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { dongs: [{ ...dong(), floor: 3 }] }))).toContain('dongs[0]: 모르는 키 "floor"');
    expect(reasonsOf(NAR_ENTRY, { ...narration("202611"), prompt: "..." })).toContain('최상위: 모르는 키 "prompt"');
    expect(reasonsOf(NAR_ENTRY, narration("202611", { items: { 강남: "x" } }))).toContain('items: 모르는 키 "강남"');
    expect(reasonsOf(NAR_ENTRY, narration("202611", { source: { 강남구: "human" } }))).toContain('source["강남구"]: "model" 이나 "template" 이 아님');
    expect(reasonsOf(IDX_ENTRY, { ...index(["202611"]), extra: 1 })).toContain('최상위: 모르는 키 "extra"');
  });

  it("빠진 키, 틀린 형식, 폴더와 다른 month/gu 거부", () => {
    const { dongs, ...noDongs } = guData("202611", "강남구");
    expect(dongs).toBeDefined();
    expect(reasonsOf(GU_ENTRY, noDongs)).toContain('최상위: 키 "dongs" 없음');
    expect(reasonsOf(GU_ENTRY, guData("202610", "강남구"))).toEqual([expect.stringMatching(/month "202610"/)]);
    expect(reasonsOf(GU_ENTRY, guData("202611", "서초구"))).toEqual([expect.stringMatching(/gu "서초구"/)]);
    expect(reasonsOf(GU_ENTRY, guData("202611", "강남구", { total: stat({ n: "3" }) }))).toContain("total.n: 0 이상 정수가 아님");
    expect(reasonsOf(NAR_ENTRY, narration("202611", { items: { 강남구: 3 } }))).toContain('items["강남구"]: 문자열이 아님');
    expect(reasonsOf(IDX_ENTRY, index(["202611", "202610"]))).toContain("months 가 오름차순이 아님");
  });

  it("깨진 JSON 과 UTF-8 이 아닌 바이트 거부", () => {
    expect(reasonsOf(GU_ENTRY, '{"v":1,')).toEqual([expect.stringMatching(/^JSON 파싱 실패/)]);
    expect(scanFile(GU_ENTRY, Buffer.from([0x7b, 0xff, 0x7d])).reasons).toEqual(["UTF-8 로 읽을 수 없음"]);
  });
});

describe("scanSet", () => {
  const filesOf = (objs) => planObjects([...objs].map(([key, b]) => ({ key, size: b.length }))).pull
    .map((entry) => ({ entry, bytes: objs.get(entry.key) }));

  it("좋은 묶음은 문제 없음, 달·narration·바이트 집계", () => {
    const objs = goodBucket(["202610", "202611"]);
    const r = scanSet(filesOf(objs));
    expect(r.problems).toEqual([]);
    expect(r.months).toEqual(["202610", "202611"]);
    expect(r.narrations).toBe(2);
  });

  it("index 의 달과 폴더가 다르면 거부(양쪽 방향)", () => {
    const objs = goodBucket(["202610", "202611"]);
    objs.set("data/index.json", enc(index(["202609", "202611"])));
    const reasons = scanSet(filesOf(objs)).problems.map((p) => p.reason);
    expect(reasons).toContain("폴더 202610 가 months 에 없음");
    expect(reasons).toContain("months 의 202609 폴더가 없음");
  });

  it("폴더에 구 파일이 빠지면, index 가 없으면, 모르는 경로가 있으면, 크기가 다르면 거부", () => {
    const objs = goodBucket(["202611"]);
    objs.delete("data/202611/중구.json");
    objs.delete("data/index.json");
    const files = filesOf(objs);
    files[0] = { ...files[0], entry: { ...files[0].entry, size: files[0].bytes.length + 1 } };
    const problems = scanSet(files, ["data/readme.txt"]).problems;
    expect(problems).toEqual(expect.arrayContaining([
      { key: "data/202611/", reason: "구 파일 1개 없음: 중구" },
      { key: "data/index.json", reason: "없음" },
      { key: "data/readme.txt", reason: expect.stringMatching(/받을 수 없는 경로/) },
      { key: files[0].entry.key, reason: expect.stringMatching(/크기 불일치/) },
    ]));
  });
});

// ---- 전체 흐름 (가짜 api + 임시 폴더) ----

describe("pullDeployed", () => {
  let out;
  beforeEach(async () => { out = await mkdtemp(path.join(tmpdir(), "pull-deployed-")); });
  afterEach(async () => { await rm(out, { recursive: true, force: true }); });

  const run = (api, opts = {}) => pullDeployed({ api, stack: "SeoulArStack", outDir: out, concurrency: 3, ...opts });
  const listOut = async () => (await readdir(out, { recursive: true })).sort();

  it("좋은 묶음: jobs 는 받지 않고, 나머지를 바이트 그대로 쓰고, 새/바뀜/같음/로컬 전용을 알린다", async () => {
    const objs = goodBucket(["202610", "202611"]);
    // 저장소에 이미 있는 파일: 하나는 같고 하나는 옛 버전, 하나는 S3 에 없는 파일
    await mkdir(path.join(out, "202611"), { recursive: true });
    await writeFile(path.join(out, "202611", "중구.json"), objs.get("data/202611/중구.json"));
    await writeFile(path.join(out, "202611", "강남구.json"), "{}");
    await writeFile(path.join(out, "202611", "old.json"), "{}");
    // 바이트 그대로인지 보려고 들여쓰기·줄바꿈 있는 파일을 하나 둔다
    const pretty = Buffer.from(`${JSON.stringify(guData("202610", "종로구"), null, 2)}\n`);
    objs.set("data/202610/종로구.json", pretty);

    const api = fakeApi(objs);
    const r = await run(api);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(api.calls.get.some((k) => k.startsWith("data/jobs/"))).toBe(false);
    expect(api.calls.get).toHaveLength(2 * 26 + 1);
    expect(r.skipped.jobs).toBe(3);
    expect(r.months).toEqual(["202610", "202611"]);
    expect(r.written.changed).toEqual(["202611/강남구.json"]);
    expect(r.written.unchanged).toEqual(["202611/중구.json"]);
    expect(r.written.added).toHaveLength(2 * 26 + 1 - 2);
    expect(r.written.localOnly).toEqual(["202611/old.json"]);
    expect(Buffer.compare(await readFile(path.join(out, "202610", "종로구.json")), pretty)).toBe(0);
    expect(Buffer.compare(await readFile(path.join(out, "202611", "강남구.json")), objs.get("data/202611/강남구.json"))).toBe(0);
    expect((await listOut()).some((p) => p.startsWith("jobs"))).toBe(false);
  });

  it("하나라도 걸리면 아무것도 쓰지 않는다", async () => {
    const objs = goodBucket(["202611"]);
    objs.set("data/202611/송파구.json", enc(guData("202611", "송파구", { dongs: [{ ...dong(), BLDG_NM: "어느 아파트" }] })));
    const r = await run(fakeApi(objs));
    expect(r.ok).toBe(false);
    expect(r.written).toBeNull();
    expect(r.problems.filter((p) => p.key === "data/202611/송파구.json").map((p) => p.reason)).toEqual(
      expect.arrayContaining(['금지 문자열 "BLDG_NM"', 'dongs[0]: 모르는 키 "BLDG_NM"']),
    );
    expect(await listOut()).toEqual([]);
  });

  it("--dry-run 은 검사만 하고 쓰지 않는다", async () => {
    const r = await run(fakeApi(goodBucket(["202611"])), { dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, pulled: 27, written: null });
    expect(await listOut()).toEqual([]);
  });
});
