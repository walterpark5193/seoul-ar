import { open, stat, mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";

export function isZipMagic(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function checkModel(path) {
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    return { ok: false, reason: "missing", bytes: 0 };
  }
  const fh = await open(path, "r");
  try {
    const buf = new Uint8Array(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    const ok = isZipMagic(buf.subarray(0, bytesRead));
    return { ok, reason: ok ? null : "not-zip", bytes: size };
  } finally {
    await fh.close();
  }
}

export async function copyWasm(srcDir, dstDir) {
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  const names = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    await copyFile(join(srcDir, e.name), join(dstDir, e.name));
    names.push(e.name);
  }
  return names;
}
