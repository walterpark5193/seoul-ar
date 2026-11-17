import { describe, it, expect } from "vitest";
import { median, aggregateRows, buildIndex, expandRows } from "./aggregate.mjs";
import { GU_ORDER } from "./gu.mjs";

// 원자료 행을 만드는 도우미. 출력에 들어가면 안 되는 필드(MNO, SNO, BLDG_NM)도 실제처럼 채운다.
function row(over = {}) {
  return {
    RCPT_YR: "2026", CGG_CD: "11680", CGG_NM: "강남구", STDG_CD: "10300", STDG_NM: "대치동",
    LOTNO_SE: "1", LOTNO_SE_NM: "대지", MNO: "0316", SNO: "0001", BLDG_NM: "현대14차(테스트)",
    CTRT_DAY: "20261105", THING_AMT: "200000", ARCH_AREA: 80, LAND_AREA: 0, FLR: 10,
    RGHT_SE: "", RTRCN_DAY: "", ARCH_YR: "1990", BLDG_USG: "아파트", DCLR_SE: "중개거래",
    OPBIZ_RESTAGNT_SGG_NM: "서울 강남구",
    ...over,
  };
}

const META = { month: "202611", gu: "강남구", generatedAt: "2026-11-17T07:00:00.000Z" };

describe("median", () => {
  it("빈 배열은 null", () => expect(median([])).toBeNull());
  it("홀수 개수는 가운데 값", () => expect(median([1, 3, 2])).toBe(2));
  it("짝수 개수는 두 가운데 값의 평균을 Math.round (2.5 → 3)", () => expect(median([1, 2, 3, 4])).toBe(3));
});

describe("aggregateRows", () => {
  it("basic: 법정동별 n, nApt, medPerM2, 취소 분리, total", () => {
    const rows = [
      row({ STDG_NM: "대치동", BLDG_USG: "아파트", THING_AMT: "200000", ARCH_AREA: 80 }),
      row({ STDG_NM: "대치동", BLDG_USG: "오피스텔", THING_AMT: "30000", ARCH_AREA: 25.0 }),
      row({ STDG_NM: "논현동", BLDG_USG: "연립다세대", THING_AMT: "50000", ARCH_AREA: 50, RTRCN_DAY: "20261112" }),
    ];
    const out = aggregateRows(rows, META);
    expect(out.v).toBe(1);
    expect(out.month).toBe("202611");
    expect(out.gu).toBe("강남구");
    expect(out.generatedAt).toBe(META.generatedAt);
    expect(out.dongs).toHaveLength(2);

    const daechi = out.dongs.find((d) => d.name === "대치동");
    expect(daechi.n).toBe(2);
    expect(daechi.cancelled).toBe(0);
    expect(daechi.nApt).toBe(1);
    expect(daechi.medPerM2).toBe(1850); // round(mean(2500, 1200))
    expect(daechi.medPerM2Apt).toBe(2500);
    expect(daechi.medAmt).toBe(115000); // round(mean(200000, 30000))
    expect(daechi.maxAmt).toBe(200000);
    expect(daechi.usage).toEqual({ 아파트: 1, 오피스텔: 1 });

    const nonhyeon = out.dongs.find((d) => d.name === "논현동");
    expect(nonhyeon.n).toBe(0);
    expect(nonhyeon.cancelled).toBe(1);
    expect(nonhyeon.medPerM2).toBeNull();
    expect(nonhyeon.medPerM2Apt).toBeNull();
    expect(nonhyeon.medAmt).toBeNull();
    expect(nonhyeon.maxAmt).toBeNull();
    expect(nonhyeon.nApt).toBe(0);
    expect(nonhyeon.usage).toEqual({});

    expect(out.total).toEqual({ n: 2, cancelled: 1, medPerM2: 1850, medAmt: 115000, maxAmt: 200000, truncated: false });
  });

  it("empty rows: total n 0, 중앙값 null, dongs []", () => {
    const out = aggregateRows([], META);
    expect(out.total).toEqual({ n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null, truncated: false });
    expect(out.dongs).toEqual([]);
  });

  it("area zero excluded from perM2 only: n과 medAmt에는 포함", () => {
    const rows = [
      row({ STDG_NM: "대치동", BLDG_USG: "단독다가구", THING_AMT: "300000", ARCH_AREA: 0 }),
      row({ STDG_NM: "대치동", BLDG_USG: "아파트", THING_AMT: "100000", ARCH_AREA: 50 }),
    ];
    const out = aggregateRows(rows, META);
    const d = out.dongs[0];
    expect(d.n).toBe(2);
    expect(d.medAmt).toBe(200000); // round(mean(300000, 100000))
    expect(d.maxAmt).toBe(300000);
    expect(d.medPerM2).toBe(2000); // 면적 0 행은 ㎡당 통계에서 제외
    expect(out.total.n).toBe(2);
    expect(out.total.medPerM2).toBe(2000);
  });

  it("ARCH_AREA 누락(undefined)도 면적 0처럼 ㎡당 통계에서만 제외", () => {
    const r = row({ THING_AMT: "80000" });
    delete r.ARCH_AREA;
    const out = aggregateRows([r], META);
    expect(out.total.n).toBe(1);
    expect(out.total.medAmt).toBe(80000);
    expect(out.total.medPerM2).toBeNull();
  });

  it("RTRCN_DAY 가 undefined/null 이면 유효 거래로 본다", () => {
    const a = row({ THING_AMT: "10000", ARCH_AREA: 10 });
    delete a.RTRCN_DAY;
    const b = row({ THING_AMT: "20000", ARCH_AREA: 10, RTRCN_DAY: null });
    const out = aggregateRows([a, b], META);
    expect(out.total.n).toBe(2);
    expect(out.total.cancelled).toBe(0);
  });

  it("output has no forbidden fields", () => {
    const rows = [row({ BLDG_NM: "현대14차(203,204,205,206동)", MNO: "0447", SNO: "0000" })];
    const text = JSON.stringify(aggregateRows(rows, META));
    for (const bad of ["MNO", "SNO", "BLDG_NM", "현대14차", "0447", "LOTNO", "CTRT_DAY", "FLR"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("truncated when 1000 rows", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row({ THING_AMT: String(10000 + i), ARCH_AREA: 10 }));
    expect(aggregateRows(rows, META).total.truncated).toBe(true);
    expect(aggregateRows(rows.slice(0, 999), META).total.truncated).toBe(false);
  });

  it("dongs sort: medPerM2 내림차순, null 뒤, 동률 n 내림차순, 이름 오름차순", () => {
    const rows = [
      row({ STDG_NM: "가동", THING_AMT: "1000", ARCH_AREA: 1 }), // perM2 1000, n 1
      row({ STDG_NM: "나동", THING_AMT: "3000", ARCH_AREA: 1 }), // perM2 3000, n 1
      row({ STDG_NM: "다동", THING_AMT: "1000", ARCH_AREA: 1 }), // perM2 1000, n 2
      row({ STDG_NM: "다동", THING_AMT: "1000", ARCH_AREA: 1 }),
      row({ STDG_NM: "라동", THING_AMT: "5000", ARCH_AREA: 0 }), // perM2 null
      row({ STDG_NM: "마동", THING_AMT: "5000", ARCH_AREA: 0, RTRCN_DAY: "20261101" }), // n 0, null
    ];
    const names = aggregateRows(rows, META).dongs.map((d) => d.name);
    expect(names).toEqual(["나동", "다동", "가동", "라동", "마동"]);
  });
});

describe("expandRows", () => {
  it("행 객체 배열은 그대로", () => {
    const rows = [row()];
    expect(expandRows(rows)).toBe(rows);
  });
  it("압축형 {fields, rows} 를 행 객체로 푼다", () => {
    const compact = {
      fields: ["STDG_NM", "THING_AMT", "ARCH_AREA", "BLDG_USG", "RTRCN_DAY"],
      rows: [["대치동", "200000", 80, "아파트", ""], ["논현동", "50000", 50, "연립다세대", "20261112"]],
    };
    const rows = expandRows(compact);
    expect(rows).toEqual([
      { STDG_NM: "대치동", THING_AMT: "200000", ARCH_AREA: 80, BLDG_USG: "아파트", RTRCN_DAY: "" },
      { STDG_NM: "논현동", THING_AMT: "50000", ARCH_AREA: 50, BLDG_USG: "연립다세대", RTRCN_DAY: "20261112" },
    ]);
    const out = aggregateRows(rows, META);
    expect(out.total).toEqual({ n: 1, cancelled: 1, medPerM2: 2500, medAmt: 200000, maxAmt: 200000, truncated: false });
  });
  it("그 밖의 형식은 오류", () => {
    expect(() => expandRows({ foo: 1 })).toThrow();
    expect(() => expandRows("x")).toThrow();
  });
});

describe("buildIndex", () => {
  it("months, gus(GU_ORDER 25), summary[month][gu] = total", () => {
    const months = ["202610", "202611"];
    const generatedAt = "2026-11-17T07:00:00.000Z";
    const perGu = months.map((month) =>
      GU_ORDER.map((gu) => aggregateRows(gu === "강남구" ? [row({ CGG_NM: gu })] : [], { month, gu, generatedAt })),
    );
    const idx = buildIndex(perGu, { months, generatedAt });
    expect(idx.v).toBe(1);
    expect(idx.generatedAt).toBe(generatedAt);
    expect(typeof idx.source).toBe("string");
    expect(idx.months).toEqual(months);
    expect(idx.gus).toEqual([...GU_ORDER]);
    expect(idx.gus).toHaveLength(25);
    expect(Object.keys(idx.summary)).toEqual(months);
    expect(Object.keys(idx.summary["202611"])).toEqual([...GU_ORDER]);
    expect(idx.summary["202611"]["강남구"]).toEqual({ n: 1, cancelled: 0, medPerM2: 2500, medAmt: 200000, maxAmt: 200000, truncated: false });
    expect(idx.summary["202610"]["종로구"]).toEqual({ n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null, truncated: false });
  });
});
