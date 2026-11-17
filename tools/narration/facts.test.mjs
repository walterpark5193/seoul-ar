import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFacts, TOP_DONG_MIN_N } from "./facts.mjs";
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
    expect(f.topDongBasis).toBeNull();
    expect(f.maxAmt).toBeNull();
    expect(JSON.stringify(f)).not.toMatch(/NaN|undefined/);
  });

  it("구 데이터가 없으면 index 요약만으로 만든다", () => {
    const { index } = load();
    const facts = buildFacts(index, {}, MONTH);
    expect(facts).toHaveLength(25);
    expect(facts.every((f) => f.topDong === null)).toBe(true);
    expect(facts.every((f) => f.topDongBasis === null)).toBe(true);
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
    expect(f.topDongBasis).toBe("min3");
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
    expect(f.topDongBasis).toBe("maxN");
  });

  it("기준 건수는 3, 실데이터(2026년 11월) 종로구는 maxN(3건 이상 동 없음), 서초구는 min3", () => {
    expect(TOP_DONG_MIN_N).toBe(3);
    const { index, byName } = load();
    const facts = buildFacts(index, byName, MONTH);
    const by = Object.fromEntries(facts.map((f) => [f.gu, f]));
    expect(by["종로구"].topDongBasis).toBe("maxN");
    expect(by["서초구"]).toMatchObject({ topDong: "방배동", topDongBasis: "min3" });
    for (const f of facts) expect(["min3", "maxN", null]).toContain(f.topDongBasis);
  });

  it("topDongIsMax: 고른 동이 구 전체(거래 1건 동 포함) ㎡당 중위 최대인지", () => {
    const { index } = load();
    const mk = (dongs) => buildFacts(index, { 강남구: { total: { n: 20, cancelled: 0, medPerM2: 1000, maxAmt: 2 }, dongs } }, MONTH).find((x) => x.gu === "강남구");
    expect(mk([{ name: "비싼동", n: 2, medPerM2: 9000 }, { name: "표본동", n: 3, medPerM2: 1200 }]).topDongIsMax).toBe(false);
    expect(mk([{ name: "싼동", n: 1, medPerM2: 900 }, { name: "표본동", n: 3, medPerM2: 1200 }]).topDongIsMax).toBe(true);
    expect(mk([{ name: "가동", n: 1, medPerM2: 9000 }, { name: "나동", n: 2, medPerM2: 500 }]).topDongIsMax).toBe(false);
    expect(mk([]).topDongIsMax).toBe(false);
  });

  it("실데이터(2026년 11월): 서초구는 잠원동(1건)이 더 비싸 false, 성동구 옥수동은 true", () => {
    const { index, byName } = load();
    const by = Object.fromEntries(buildFacts(index, byName, MONTH).map((f) => [f.gu, f]));
    expect(by["서초구"].topDongIsMax).toBe(false);
    expect(by["성동구"]).toMatchObject({ topDong: "옥수동", topDongBasis: "min3", topDongIsMax: true });
    for (const f of Object.values(by)) expect(typeof f.topDongIsMax).toBe("boolean");
  });
});
