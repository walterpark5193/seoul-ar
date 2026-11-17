// 저장소에 실린 해설 생성물(scripts.json, manifest.json, mp3)이 현재 데이터·서로와 맞는지 확인한다.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { templateLines } from "./templates.mjs";
import { speechHash } from "./synth.mjs";
import { mp3DurationMs } from "./mp3.mjs";
import { buildFacts } from "./facts.mjs";
import { validateScript, speechFromCaption } from "./write.mjs";
import { GU_ORDER } from "../data/gu.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = join(repo, "frontend/public/data");
const narrDir = join(repo, "frontend/public/narration");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const index = readJson(join(dataDir, "index.json"));
const scripts = readJson(join(repo, "tools/narration/scripts.json"));
const manifest = readJson(join(narrDir, "manifest.json"));
const month = scripts.month;
const lines = [
  ...templateLines(index.gus, month),
  ...Object.entries(scripts.items).map(([id, s]) => ({ id, caption: s.caption, speech: s.speech })),
];

describe("실린 manifest", () => {
  it("id가 templateLines + scripts와 정확히 같다(229개)", () => {
    expect(Object.keys(manifest.items).sort()).toEqual(lines.map((l) => l.id).sort());
    expect(lines.length).toBe(229);
  });
  it("caption과 hash가 문장과 맞고 파일이 있다", () => {
    for (const l of lines) {
      const it = manifest.items[l.id];
      expect(it.file, l.id).toBe(`${l.id}.mp3`);
      expect(it.caption, l.id).toBe(l.caption);
      expect(it.hash, l.id).toBe(speechHash(l.speech, manifest.voice, manifest.engine));
      expect(existsSync(join(narrDir, it.file)), l.id).toBe(true);
    }
  });
  it("모든 항목에 ms가 있고 mp3 실제 길이와 같다", () => {
    for (const [id, it] of Object.entries(manifest.items)) {
      expect(Number.isInteger(it.ms) && it.ms > 0, id).toBe(true);
      expect(it.ms, id).toBe(mp3DurationMs(readFileSync(join(narrDir, it.file))));
    }
  });
});

describe("실린 scripts.json", () => {
  const byName = {};
  for (const gu of GU_ORDER) byName[gu] = readJson(join(dataDir, month, `${gu}.json`));
  const facts = Object.fromEntries(buildFacts(index, byName, month).map((f) => [f.gu, f]));
  const check = (gu, caption) => validateScript(facts[gu], { caption });

  it("25개 구 해설이 모두 있고, 현재 사실표로 validateScript를 통과한다", () => {
    expect(Object.keys(scripts.items).sort()).toEqual(GU_ORDER.map((gu) => `gu-${month}-${gu}`).sort());
    for (const gu of GU_ORDER) {
      const s = scripts.items[`gu-${month}-${gu}`];
      expect(validateScript(facts[gu], s), `${gu}: ${s.caption}`).toEqual({ ok: true, errors: [] });
    }
  });
  it("speech는 caption에서 유도한 것과 같다(자막과 음성이 어긋나지 않음)", () => {
    for (const [id, s] of Object.entries(scripts.items)) expect(s.speech, id).toBe(speechFromCaption(s.caption));
  });
  it("리뷰어 반례 4개는 모두 거절된다", () => {
    const bad = [
      ["서초구", "서초구 11월 거래는 20건, ㎡당 중위 1,220만 원으로 7위입니다. 방배동이 ㎡당 중위 2,704만 원으로 가장 높습니다."],
      ["중구", "중구는 11월 17건이 거래됐고 ㎡당 중위 1,327만 원으로 25개 구 중 1위입니다."],
      ["강남구", "강남구는 11월 32건이 거래됐고 최고 거래가는 25억 원이었습니다."],
      ["마포구", "마포구는 11월 25건이 거래됐고 ㎡당 중위 985만 원으로 서울에서 가장 비쌉니다."],
    ];
    for (const [gu, caption] of bad) expect(check(gu, caption).ok, `${gu}: ${caption}`).toBe(false);
  });
  it("반례를 사실대로 고치면 통과한다(검사가 과하지 않음)", () => {
    const good = [
      ["서초구", "서초구 11월 거래는 20건, ㎡당 중위 1,220만 원으로 7위입니다. 3건 이상 거래된 동 중 방배동이 ㎡당 중위 2,704만 원으로 가장 높습니다."],
      ["중구", "중구는 11월 17건이 거래됐고 ㎡당 중위 1,327만 원으로 25개 구 중 6위입니다."],
      ["강남구", "강남구는 11월 32건이 거래됐고 최고 거래가는 66.0억 원이었습니다."],
      ["마포구", "마포구는 11월 25건이 거래됐고 ㎡당 중위 985만 원으로 25개 구 중 17위입니다."],
    ];
    for (const [gu, caption] of good) expect(check(gu, caption), `${gu}: ${caption}`).toEqual({ ok: true, errors: [] });
  });
});
