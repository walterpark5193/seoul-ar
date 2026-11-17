import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findUsageLogging, USAGE_LOGGING_PATTERNS } from "./check-bundle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "check-bundle.mjs");
const tmp = (p) => mkdtemp(join(tmpdir(), p));

describe("findUsageLogging", () => {
  it("js 안의 사용 통계 엔드포인트를 찾는다", async () => {
    const dir = await tmp("bundle-");
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "vision.js"), 'fetch({url:"https://odml.pa.googleapis.com/v1/log"})');
    await writeFile(join(dir, "assets", "ok.js"), "console.log(1)");
    const hits = await findUsageLogging(dir);
    expect(hits.map((h) => h.file)).toEqual([join("assets", "vision.js")]);
    expect(hits[0].patterns.length).toBeGreaterThanOrEqual(2);
  });
  it("wasm 로더의 로거 export 이름도 잡는다", async () => {
    const dir = await tmp("bundle-");
    await writeFile(join(dir, "loader.js"), "Module._mediapipeLoggerGetEncodedApiKey=1");
    expect((await findUsageLogging(dir)).map((h) => h.file)).toEqual(["loader.js"]);
  });
  it("/v1/logs 같은 다른 경로는 오탐하지 않는다", async () => {
    const dir = await tmp("bundle-");
    await writeFile(join(dir, "a.js"), 'const p="/v1/logs"; const q="/v1/login";');
    expect(await findUsageLogging(dir)).toEqual([]);
  });
  it("js·html만 본다(이미지·wasm 바이너리는 건너뜀)", async () => {
    const dir = await tmp("bundle-");
    await writeFile(join(dir, "a.png"), "odml.pa.googleapis.com/v1/log");
    await writeFile(join(dir, "index.html"), "<script>odml.pa.googleapis.com</script>");
    expect((await findUsageLogging(dir)).map((h) => h.file)).toEqual(["index.html"]);
  });
  it("패턴 목록에 엔드포인트 호스트와 경로가 있다", () => {
    const src = USAGE_LOGGING_PATTERNS.map(String).join(" ");
    expect(src).toContain("odml");
    expect(src).toContain("v1");
  });
});

describe("check-bundle CLI", () => {
  const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  it("엔드포인트가 있으면 exit 1", async () => {
    const dir = await tmp("bundle-");
    await writeFile(join(dir, "x.js"), "odml.pa.googleapis.com/v1/log");
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("x.js");
  });
  it("깨끗하면 exit 0", async () => {
    const dir = await tmp("bundle-");
    await writeFile(join(dir, "x.js"), "console.log(1)");
    expect(run(dir).status).toBe(0);
  });
  it("dist가 없으면 exit 1", async () => {
    const dir = join(await tmp("bundle-"), "none");
    expect(run(dir).status).toBe(1);
  });
});

describe("설치된 MediaPipe", () => {
  it("@mediapipe/tasks-vision 패키지에 사용 통계 송신 코드가 없다", async () => {
    expect(await findUsageLogging(join(root, "node_modules", "@mediapipe", "tasks-vision"))).toEqual([]);
  });
  it("package.json은 tasks-vision을 정확한 판으로 고정하고 postbuild로 번들을 검사한다", async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.dependencies["@mediapipe/tasks-vision"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.scripts.postbuild).toBe("node scripts/check-bundle.mjs");
  });
});
