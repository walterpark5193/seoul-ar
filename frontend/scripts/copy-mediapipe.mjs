import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { copyWasm, missingFiles } from "./assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dst = join(root, "public", "mediapipe", "wasm");

try {
  const names = await copyWasm(src, dst);
  const missing = await missingFiles(dst);
  if (names.length === 0 || missing.length > 0) {
    console.error(`[assets] wasm 복사 불완전: 복사 ${names.length}개, 없는 파일 ${missing.join(", ") || "없음"}`);
    process.exit(1);
  }
  console.log(`[assets] MediaPipe wasm ${names.length}개 복사: ${names.join(", ")}`);
} catch (e) {
  console.error(`[assets] wasm 복사 실패: ${e.message}`);
  process.exit(1);
}
