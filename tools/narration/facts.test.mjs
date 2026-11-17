import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFacts } from "./facts.mjs";
import { GU_ORDER } from "../data/gu.mjs";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/public/data");
const MONTH = "202611";

function load() {
  const index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
  const byName = {};
  for (const gu of GU_ORDER) byName[gu] = JSON.parse(fs.readFileSync(path.join(DATA, MONTH, `${gu}.json`), "utf8"));
  return { index, byName };
}

describe("buildFacts", () => {
  it("실데이터 25개, GU_ORDER 순, rankPrice 1~k 중복 없음", () => {
    const { index, byName } = load();
    const facts = buildFacts(index, byName, MONTH);
    expect(facts).toHaveLength(25);
    expect(facts.map((f) => f.gu)).toEqual(GU_ORDER);
    const ranks = facts.map((f) => f.rankPrice).filter((r) => r !== null).sort((a, b) => a - b);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const f of facts) {
      expect(f.totalGus).toBe(25);
      expect(f.month).toBe(MONTH);
    }
    const first = facts.find((f) => f.rankPrice === 1);
    for (const f of facts) if (f.medPerM2 !== null) expect(f.medPerM2).toBeLessThanOrEqual(first.medPerM2);
  });

  it("facts for empty gu", () => {
    const { index, byName } = load();
    const gu = "종로구";
    byName[gu] = { ...byName[gu], total: { n: 0, cancelled: 1, medPerM2: null, medAmt: null, maxAmt: null, truncated: false }, dongs: [] };
    const f = buildFacts(index, byName, MONTH).find((x) => x.gu === gu);
    expect(f.n).toBe(0);
    expect(f.medPerM2).toBeNull();
    expect(f.rankPrice).toBeNull();
    expect(f.topDong).toBeNull();
    expect(f.topDongMedPerM2).toBeNull();
    expect(f.maxAmt).toBeNull();
    expect(JSON.stringify(f)).not.toMatch(/NaN|undefined/);
  });

  it("구 데이터가 없으면 index 요약만으로 만든다", () => {
    const { index } = load();
    const facts = buildFacts(index, {}, MONTH);
    expect(facts).toHaveLength(25);
    expect(facts.every((f) => f.topDong === null)).toBe(true);
  });

  it("topDong prefers n>=3", () => {
    const { index } = load();
    const data = {
      total: { n: 20, cancelled: 0, medPerM2: 1000, medAmt: 1, maxAmt: 2, truncated: false },
      dongs: [
        { name: "비싼동", n: 2, medPerM2: 9000 },
        { name: "표본동", n: 3, medPerM2: 1200 },
        { name: "많은동", n: 15, medPerM2: 800 },
      ],
    };
    const f = buildFacts(index, { 강남구: data }, MONTH).find((x) => x.gu === "강남구");
    expect(f.topDong).toBe("표본동");
    expect(f.topDongMedPerM2).toBe(1200);
  });

  it("n>=3 동이 없으면 n 최대 동", () => {
    const { index } = load();
    const data = {
      total: { n: 4, cancelled: 0, medPerM2: 1000, medAmt: 1, maxAmt: 2, truncated: false },
      dongs: [
        { name: "가동", n: 1, medPerM2: 9000 },
        { name: "나동", n: 2, medPerM2: 500 },
      ],
    };
    const f = buildFacts(index, { 강남구: data }, MONTH).find((x) => x.gu === "강남구");
    expect(f.topDong).toBe("나동");
  });
});
