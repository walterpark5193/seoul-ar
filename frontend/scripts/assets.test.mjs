import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isZipMagic, checkModel, copyWasm, missingFiles, REQUIRED_WASM } from "./assets.mjs";

describe("isZipMagic", () => {
  it("PK로 시작하면 참", () => {
    expect(isZipMagic(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true);
  });
  it("빈 배열은 거짓", () => {
    expect(isZipMagic(new Uint8Array([]))).toBe(false);
  });
  it("HTML은 거짓", () => {
    expect(isZipMagic(new TextEncoder().encode("<!doctype html>"))).toBe(false);
  });
});

describe("checkModel", () => {
  it("없는 경로는 missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const r = await checkModel(join(dir, "none.task"));
    expect(r).toEqual({ ok: false, reason: "missing", bytes: 0 });
  });
  it("PK 파일은 ok", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const p = join(dir, "m.task");
    await writeFile(p, Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
    const r = await checkModel(p);
    expect(r).toEqual({ ok: true, reason: null, bytes: 6 });
  });
  it("텍스트 파일은 not-zip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const p = join(dir, "m.task");
    await writeFile(p, "<html>404</html>");
    const r = await checkModel(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-zip");
  });
});

describe("copyWasm", () => {
  it("두 파일을 복사하고 이름을 돌려준다", async () => {
    const src = await mkdtemp(join(tmpdir(), "src-"));
    const dst = join(await mkdtemp(join(tmpdir(), "dst-")), "nested", "wasm");
    await writeFile(join(src, "a.wasm"), "aa");
    await writeFile(join(src, "b.js"), "bb");
    const names = await copyWasm(src, dst);
    expect(names.sort()).toEqual(["a.wasm", "b.js"]);
    expect((await readdir(dst)).sort()).toEqual(["a.wasm", "b.js"]);
  });
});

describe("checkModel 오류 구분", () => {
  it("디렉터리는 not-file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const d = join(dir, "m.task");
    await mkdir(d);
    expect((await checkModel(d)).reason).toBe("not-file");
  });
  it("ENOENT가 아닌 stat 오류는 missing으로 뭉개지 않고 던진다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const f = join(dir, "plain");
    await writeFile(f, "x");
    await expect(checkModel(join(f, "child.task"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("REQUIRED_WASM", () => {
  it("forVisionTasks가 고를 수 있는 SIMD·non-SIMD 변형이 모두 들어 있다", () => {
    for (const n of ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"]) {
      expect(REQUIRED_WASM).toContain(n);
    }
  });
  it("설치된 @mediapipe/tasks-vision의 wasm 폴더에 전부 있다", async () => {
    const wasm = fileURLToPath(new URL("../node_modules/@mediapipe/tasks-vision/wasm", import.meta.url));
    expect(await missingFiles(wasm)).toEqual([]);
  });
});

describe("missingFiles", () => {
  it("필수 wasm이 없으면 이름을 알려준다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "w-"));
    await writeFile(join(dir, REQUIRED_WASM[0]), "x");
    const m = await missingFiles(dir);
    expect(m).toEqual(REQUIRED_WASM.slice(1));
  });
  it("전부 있으면 빈 배열", async () => {
    const dir = await mkdtemp(join(tmpdir(), "w-"));
    for (const n of REQUIRED_WASM) await writeFile(join(dir, n), "x");
    expect(await missingFiles(dir)).toEqual([]);
  });
  it("빈 디렉터리 복사 결과는 전부 없음으로 보인다", async () => {
    const src = await mkdtemp(join(tmpdir(), "s-"));
    const dst = join(await mkdtemp(join(tmpdir(), "d-")), "w");
    expect(await copyWasm(src, dst)).toEqual([]);
    expect((await missingFiles(dst)).length).toBe(REQUIRED_WASM.length);
  });
});
