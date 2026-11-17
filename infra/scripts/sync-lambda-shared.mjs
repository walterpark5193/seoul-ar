#!/usr/bin/env node
// tools/data 의 집계 코드(aggregate.mjs, gu.mjs)를 Lambda 디렉터리로 그대로 복사한다.
// Lambda 는 의존성 없이 배포되므로 tools/ 를 import 할 수 없다. 복사본이 원본과 바이트 단위로 같은지는
// infra/lambda/fetch-month/shared.test.mjs 가 검사한다.
//
//   node infra/scripts/sync-lambda-shared.mjs          # 복사
//   node infra/scripts/sync-lambda-shared.mjs --check  # 다르면 exit 1 (복사하지 않음)
import { copyFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

export const SHARED_FILES = ["aggregate.mjs", "gu.mjs"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(root, "tools", "data");
const DEST = join(root, "infra", "lambda", "fetch-month");

function same(a, b) {
  return existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

const check = process.argv.includes("--check");
let drift = 0;
for (const name of SHARED_FILES) {
  const from = join(SRC, name);
  const to = join(DEST, name);
  if (same(from, to)) {
    console.log(`같음   ${relative(root, to)}`);
    continue;
  }
  drift++;
  if (check) {
    console.error(`다름   ${relative(root, to)} ≠ ${relative(root, from)}`);
  } else {
    copyFileSync(from, to);
    console.log(`복사   ${relative(root, from)} → ${relative(root, to)}`);
  }
}
if (check && drift > 0) {
  console.error("node infra/scripts/sync-lambda-shared.mjs 로 맞춘다");
  process.exit(1);
}
