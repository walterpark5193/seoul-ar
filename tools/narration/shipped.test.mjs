// 저장소에 실린 해설 생성물(scripts.json, manifest.json, mp3)이 현재 데이터·서로와 맞는지 확인한다.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { templateLines } from "./templates.mjs";
import { speechHash } from "./synth.mjs";
import { mp3DurationMs } from "./mp3.mjs";

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
