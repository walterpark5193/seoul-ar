// Lambda 의 집계 코드는 tools/data 원본의 복사본이어야 한다(CONTRACTS 10.3).
// 어긋나면: node infra/scripts/sync-lambda-shared.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = (name) => new URL(`./${name}`, import.meta.url);
const tools = (name) => new URL(`../../../tools/data/${name}`, import.meta.url);

for (const name of ["aggregate.mjs", "gu.mjs"]) {
  test(`${name} 는 tools/data/${name} 와 바이트 단위로 같다`, () => {
    const copy = readFileSync(here(name));
    const original = readFileSync(tools(name));
    assert.ok(original.length > 0);
    assert.ok(copy.equals(original), `infra/lambda/fetch-month/${name} 가 tools/data/${name} 와 다르다. node infra/scripts/sync-lambda-shared.mjs 로 맞춘다`);
  });
}
