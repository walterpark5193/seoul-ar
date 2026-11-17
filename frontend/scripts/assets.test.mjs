import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isZipMagic, checkModel, copyWasm } from "./assets.mjs";

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
