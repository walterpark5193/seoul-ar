import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, stat } from "node:fs/promises";
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
    await writeFile(p, Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), Buffer.alloc(20)]));
    const r = await checkModel(p);
    expect(r).toEqual({ ok: true, reason: null, bytes: 26 });
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

// 최소 zip: 빈 아카이브 = EOCD 22바이트(PK\x05\x06 + 0 18바이트)
const EOCD = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

describe("checkModel zip 판별(EOCD)", () => {
  async function tmpFile(content) {
    const dir = await mkdtemp(join(tmpdir(), "assets-"));
    const p = join(dir, "m.task");
    await writeFile(p, content);
    return p;
  }
  it("앞에 데이터가 붙은 zip(00 00 시작)은 ok", async () => {
    const buf = Buffer.concat([Buffer.alloc(100), Buffer.from("payload"), EOCD]);
    const r = await checkModel(await tmpFile(buf));
    expect(r).toEqual({ ok: true, reason: null, bytes: buf.length });
  });
  it("EOCD 뒤에 최대 길이 주석이 있어도 ok", async () => {
    const buf = Buffer.concat([Buffer.alloc(200), EOCD, Buffer.alloc(65535)]);
    expect((await checkModel(await tmpFile(buf))).ok).toBe(true);
  });
  it("PK로 시작하는 일반 zip은 ok", async () => {
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(30), EOCD]);
    expect((await checkModel(await tmpFile(buf))).ok).toBe(true);
  });
  it("무작위 바이트는 not-zip", async () => {
    const buf = Buffer.alloc(5000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 131 + 7) % 251;
    expect((await checkModel(await tmpFile(buf))).reason).toBe("not-zip");
  });
  it("HTML 텍스트는 not-zip", async () => {
    expect((await checkModel(await tmpFile("<!doctype html><html>404</html>"))).reason).toBe("not-zip");
  });
  it("22바이트보다 짧으면 not-zip", async () => {
    const r = await checkModel(await tmpFile(Buffer.alloc(21)));
    expect(r).toEqual({ ok: false, reason: "not-zip", bytes: 21 });
  });
  it("실제 모델 파일이 있으면 ok", async (ctx) => {
    const real = fileURLToPath(new URL("../public/models/gesture_recognizer.task", import.meta.url));
    try {
      if (!(await stat(real)).isFile()) return ctx.skip();
    } catch {
      return ctx.skip();
    }
    expect((await checkModel(real)).ok).toBe(true);
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
