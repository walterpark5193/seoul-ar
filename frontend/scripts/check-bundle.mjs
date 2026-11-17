// postbuild 검사: dist의 js·html에 MediaPipe 사용 통계 송신 코드가 있으면 빌드를 실패시킨다.
// @mediapipe/tasks-vision 1.x는 createFromOptions에서 로거를 조건 없이 만들고 1분마다
// odml.pa.googleapis.com/v1/log로 POST한다(끄는 옵션 없음). 그래서 로거가 없는 판(0.10.35)으로 고정했고,
// 실수로 올려도 여기서 막는다. 사용법: node scripts/check-bundle.mjs [dist 경로]
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const USAGE_LOGGING_PATTERNS = [
  /odml\.pa\.googleapis/,          // 사용 통계 엔드포인트 호스트
  /\/v1\/log\b/,                    // 그 경로(/v1/logs, /v1/login은 제외)
  /_mediapipeLogger/,               // wasm이 내보내는 로거 API 키 함수(로거가 있는 판의 표지)
];
const TEXT_EXT = /\.(m?js|cjs|html?)$/i;

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(p);
  }
  return out;
}

/** dir 아래 js·html 중 사용 통계 패턴이 있는 파일. → [{ file(상대 경로), patterns: string[] }] */
export async function findUsageLogging(dir) {
  const hits = [];
  for (const p of (await walk(dir)).sort()) {
    const text = await readFile(p, "utf8");
    const patterns = USAGE_LOGGING_PATTERNS.filter((re) => re.test(text)).map(String);
    if (patterns.length) hits.push({ file: relative(dir, p), patterns });
  }
  return hits;
}

async function main(argv) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dist = resolve(argv[0] ?? join(root, "dist"));
  try {
    if (!(await stat(dist)).isDirectory()) throw new Error("디렉터리가 아님");
  } catch (e) {
    console.error(`[bundle] ${dist}를 읽을 수 없습니다(${e.code ?? e.message}). 빌드 뒤에 실행하세요.`);
    process.exit(1);
  }
  const hits = await findUsageLogging(dist);
  if (hits.length) {
    console.error("[bundle] 빌드 산출물에 외부 사용 통계 송신 코드가 있습니다. 실행 중 외부 호출은 AWS뿐이어야 합니다.");
    for (const h of hits) console.error(`  ${h.file}: ${h.patterns.join(", ")}`);
    console.error("  @mediapipe/tasks-vision 판을 확인하세요(package.json은 0.10.35 고정).");
    process.exit(1);
  }
  console.log("[bundle] 외부 사용 통계 송신 코드 없음");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
