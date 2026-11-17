import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFacts, isPartialMonth, TOP_DONG_MIN_N } from "./facts.mjs";
import { GU_ORDER } from "../data/gu.mjs";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/public/data");
const MONTH = "202611";

function load(month = MONTH) {
  const index = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
  const byName = {};
  for (const gu of GU_ORDER) byName[gu] = JSON.parse(fs.readFileSync(path.join(DATA, month, `${gu}.json`), "utf8"));
  return { index, byName };
}

describe("buildFacts", () => {
  it("실데이터 25개, GU_ORDER 순, rankPrice는 경쟁 순위(1 + 더 비싼 구 수)", () => {
    const { index, byName } = load();
    const facts = buildFacts(index, byName, MONTH);
    expect(facts).toHaveLength(25);
    expect(facts.map((f) => f.gu)).toEqual(GU_ORDER);
    const priced = facts.filter((f) => f.medPerM2 !== null);
    for (const f of priced) {
      expect(f.rankPrice, f.gu).toBe(1 + priced.filter((o) => o.medPerM2 > f.medPerM2).length);
      expect(f.rankTied, f.gu).toBe(priced.some((o) => o !== f && o.medPerM2 === f.medPerM2));
    }
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

  const withMed = (meds) => {
    const { index } = load();
    const byName = {};
    GU_ORDER.forEach((gu, i) => { byName[gu] = { generatedAt: "2026-11-17T07:00:00.000Z", total: { n: 10, cancelled: 0, medPerM2: meds[i] ?? 100, maxAmt: 1 }, dongs: [] }; });
    return Object.fromEntries(buildFacts(index, byName, "202610").map((f) => [f.gu, f]));
  };

  it("㎡당 중위가 같으면 같은 순위, 다음 순위는 건너뛴다(13, 13, 15)", () => {
    // 1위부터 12위까지 하나씩, 13~14번째 구가 같은 값, 15번째 구가 그다음
    const meds = GU_ORDER.map((_, i) => 3000 - i * 10);
    meds[13] = meds[12];
    const by = withMed(meds);
    const [a, b, c, d] = [GU_ORDER[11], GU_ORDER[12], GU_ORDER[13], GU_ORDER[14]].map((gu) => by[gu]);
    expect([a.rankPrice, b.rankPrice, c.rankPrice, d.rankPrice]).toEqual([12, 13, 13, 15]);
    expect([a.rankTied, b.rankTied, c.rankTied, d.rankTied]).toEqual([false, true, true, false]);
    // GU_ORDER 순서가 순위를 가르지 않는다(값을 바꿔 넣어도 같은 순위)
    const swapped = [...meds]; [swapped[12], swapped[13]] = [swapped[13], swapped[12]];
    expect(withMed(swapped)[GU_ORDER[13]].rankPrice).toBe(13);
  });

  it("세 구 공동 1위면 모두 1위, 다음은 4위", () => {
    const meds = GU_ORDER.map((_, i) => 3000 - i * 10);
    meds[1] = meds[0]; meds[2] = meds[0];
    const by = withMed(meds);
    expect(GU_ORDER.slice(0, 4).map((gu) => by[gu].rankPrice)).toEqual([1, 1, 1, 4]);
  });

  it("실데이터 공동 순위 6쌍: 같은 ㎡당 중위면 같은 순위(리뷰 C1)", () => {
    const pairs = [
      ["202401", "광진구", "서대문구", 13], ["202404", "노원구", "양천구", 15], ["202409", "중구", "강동구", 11],
      ["202412", "강북구", "은평구", 22], ["202603", "구로구", "관악구", 20], ["202605", "강서구", "구로구", 17],
    ];
    for (const [month, a, b, rank] of pairs) {
      const { index, byName } = load(month);
      const by = Object.fromEntries(buildFacts(index, byName, month).map((f) => [f.gu, f]));
      expect(by[a].medPerM2, `${month} ${a}/${b}`).toBe(by[b].medPerM2);
      expect([by[a].rankPrice, by[b].rankPrice], `${month} ${a}/${b}`).toEqual([rank, rank]);
      expect(by[a].rankTied && by[b].rankTied).toBe(true);
      expect(Object.values(by).some((f) => f.rankPrice === rank + 1), `${month}: ${rank + 1}위는 건너뛴다`).toBe(false);
    }
  });

  it("공동 최고 동: topDongIsMax false, topDongTiedWith에 같은 값의 3건 이상 동", () => {
    const { index } = load();
    const mk = (dongs) => buildFacts(index, { 강남구: { total: { n: 20, cancelled: 0, medPerM2: 1000, maxAmt: 2 }, dongs } }, MONTH).find((x) => x.gu === "강남구");
    const tied = mk([{ name: "가동", n: 5, medPerM2: 2000 }, { name: "나동", n: 4, medPerM2: 2000 }, { name: "다동", n: 9, medPerM2: 900 }]);
    expect(tied).toMatchObject({ topDong: "가동", topDongBasis: "min3", topDongIsMax: false, topDongTiedWith: ["나동"] });
    // 거래가 적은 동과 같은 값이어도 유일한 최대는 아니다(3건 이상 중에서는 단독)
    const thinTie = mk([{ name: "가동", n: 5, medPerM2: 2000 }, { name: "적은동", n: 1, medPerM2: 2000 }]);
    expect(thinTie).toMatchObject({ topDong: "가동", topDongIsMax: false, topDongTiedWith: [] });
    expect(mk([{ name: "가동", n: 5, medPerM2: 2000 }, { name: "다동", n: 9, medPerM2: 900 }])).toMatchObject({ topDongIsMax: true, topDongTiedWith: [] });
  });

  it("실데이터(2026년 3월) 성동구: 금호동3가와 행당동이 공동 최고(리뷰 M1)", () => {
    const { index, byName } = load("202603");
    const f = buildFacts(index, byName, "202603").find((x) => x.gu === "성동구");
    expect(f).toMatchObject({ topDong: "금호동3가", topDongMedPerM2: 2335, topDongBasis: "min3", topDongIsMax: false, topDongTiedWith: ["행당동"] });
  });

  it("isPartialMonth: 그 달이 끝나기 전(한국 시간)에 받은 데이터면 집계 중", () => {
    expect(isPartialMonth("202611", "2026-11-17T14:08:45.921Z")).toBe(true);
    expect(isPartialMonth("202610", "2026-11-17T14:08:45.921Z")).toBe(false);
    expect(isPartialMonth("202611", "2026-11-30T14:59:59.000Z")).toBe(true);   // 11-30 23:59 KST
    expect(isPartialMonth("202611", "2026-11-30T15:00:00.000Z")).toBe(false);  // 12-01 00:00 KST
    expect(isPartialMonth("202612", "2026-11-30T16:00:00.000Z")).toBe(true);   // 12-01 01:00 KST, 12월 진행 중
    expect(isPartialMonth("202611", undefined)).toBe(false);
    expect(isPartialMonth("202611", "아님")).toBe(false);
  });

  it("partial: 구 파일의 generatedAt 기준, 없으면 index.generatedAt", () => {
    const { index, byName } = load();
    expect(buildFacts(index, byName, MONTH).every((f) => f.partial === true)).toBe(true);
    const old = load("202610");
    expect(buildFacts(old.index, old.byName, "202610").every((f) => f.partial === false)).toBe(true);
    expect(buildFacts({ ...index, generatedAt: "2026-12-02T00:00:00.000Z" }, {}, MONTH).every((f) => f.partial === false)).toBe(true);
    expect(buildFacts({ ...index, generatedAt: "2026-11-20T00:00:00.000Z" }, {}, MONTH).every((f) => f.partial === true)).toBe(true);
  });

  it("실데이터에서 집계 중인 달은 2026년 11월뿐", () => {
    const { index } = load();
    const partial = index.months.filter((month) => {
      const { byName } = load(month);
      return buildFacts(index, byName, month).some((f) => f.partial);
    });
    expect(partial).toEqual(["202611"]);
  });
});
