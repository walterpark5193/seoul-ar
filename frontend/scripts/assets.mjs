import { open, stat, mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";

export function isZipMagic(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

// EOCD 레코드(22바이트) + 최대 주석(65,535바이트)
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

// 공식 .task 모델은 앞에 데이터가 붙은 zip(00 00 시작)이라 파일 끝의 EOCD(PK\x05\x06)로 판별한다.
export function hasEocd(tail) {
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) return true;
  }
  return false;
}

export async function checkModel(path) {
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, reason: "missing", bytes: 0 };
    throw e;
  }
  if (!st.isFile()) return { ok: false, reason: "not-file", bytes: 0 };
  const size = st.size;
  if (size < EOCD_MIN) return { ok: false, reason: "not-zip", bytes: size };
  const fh = await open(path, "r");
  try {
    const head = new Uint8Array(2);
    const h = await fh.read(head, 0, 2, 0);
    let ok = isZipMagic(head.subarray(0, h.bytesRead));
    if (!ok) {
      const len = Math.min(size, EOCD_SEARCH);
      const tail = new Uint8Array(len);
      const t = await fh.read(tail, 0, len, size - len);
      ok = hasEocd(tail.subarray(0, t.bytesRead));
    }
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

// @mediapipe/tasks-vision 0.10.35: forVisionTasks(path)는 WebAssembly SIMD 지원 여부에 따라
// vision_wasm_internal 또는 vision_wasm_nosimd_internal을 고른다. module 변형은 지금 쓰지 않지만 함께 복사·확인한다.
export const REQUIRED_WASM = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
];

export async function missingFiles(dir, names = REQUIRED_WASM) {
  const missing = [];
  for (const n of names) {
    try {
      if (!(await stat(join(dir, n))).isFile()) missing.push(n);
    } catch (e) {
      if (e && e.code === "ENOENT") missing.push(n);
      else throw e;
    }
  }
  return missing;
}
