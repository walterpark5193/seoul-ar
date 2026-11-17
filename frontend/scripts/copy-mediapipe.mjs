import { fileURLToPath } from "node:url";
import { copyWasm } from "./assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}node_modules/@mediapipe/tasks-vision/wasm`;
const dst = `${root}public/mediapipe/wasm`;

try {
  const names = await copyWasm(src, dst);
  console.log(`[assets] MediaPipe wasm ${names.length}개 복사: ${names.join(", ")}`);
} catch (e) {
  console.error(`[assets] wasm 복사 실패: ${e.message}`);
  process.exit(1);
}
