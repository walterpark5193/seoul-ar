import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateYear, expectedMonths, bucketByMonth, isGuComplete, yearJobMonth, MIN_YEAR } from "./yearly.mjs";
import { row } from "./fakes.mjs";

const NOW = Date.UTC(2026, 10, 17, 3, 0, 0); // 2026-11-17 12:00 KST

describe("validateYear", () => {
  test("YYYY, 2006 ~ 한국 시간 올해", () => {
    assert.equal(MIN_YEAR, "2006");
    for (const ok of ["2006", "2024", "2025", "2026"]) assert.equal(validateYear(ok, NOW).ok, true, ok);
    for (const bad of ["2005", "2027", "24", "20245", "abcd", "", null, 2024, undefined]) {
      const v = validateYear(bad, NOW);
      assert.equal(v.ok, false, String(bad));
      assert.ok(v.message.length > 0);
    }
    // UTC 로는 2026-12-31 15:30 이지만 한국은 2027-01-01 00:30
    assert.equal(validateYear("2027", Date.UTC(2026, 11, 31, 15, 30)).ok, true);
  });
});

describe("expectedMonths", () => {
  test("지난해는 12개월, 올해는 한국 시간 이번 달까지", () => {
    assert.deepEqual(expectedMonths("2024", NOW), ["202401", "202402", "202403", "202404", "202405", "202406", "202407", "202408", "202409", "202410", "202411", "202412"]);
    assert.deepEqual(expectedMonths("2026", NOW), ["202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610", "202611"]);
  });
});

describe("bucketByMonth", () => {
  test("계약 연월로 나누고 다른 해(전년 12월 등)와 기대 밖 달은 버린다", () => {
    const rows = [
      row({ CTRT_DAY: "20240105" }), row({ CTRT_DAY: "20240131" }),
      row({ CTRT_DAY: "20240310" }),
      row({ CTRT_DAY: "20231228" }), // 전년 12월 계약, 1월 신고
      row({ CTRT_DAY: "20241201" }),
      row({ CTRT_DAY: "" }), row({ CTRT_DAY: undefined }), row({ CTRT_DAY: "20241301" }),
    ];
    const b = bucketByMonth(rows, "2024", expectedMonths("2024", NOW));
    assert.deepEqual([...b.keys()].sort(), ["202401", "202403", "202412"]);
    assert.equal(b.get("202401").length, 2);
    assert.ok(![...b.values()].flat().some((r) => r.CTRT_DAY.startsWith("2023")));
  });

  test("올해는 이번 달 뒤의 달을 버린다", () => {
    const b = bucketByMonth([row({ CTRT_DAY: "20261110" }), row({ CTRT_DAY: "20261205" })], "2026", expectedMonths("2026", NOW));
    assert.deepEqual([...b.keys()], ["202611"]);
  });
});

describe("isGuComplete / yearJobMonth", () => {
  test("기대한 달 파일이 모두 있어야 완료", () => {
    const months = expectedMonths("2024", NOW);
    const all = new Set(months.map((m) => `data/${m}/강남구.json`));
    assert.equal(isGuComplete(all, "강남구", months), true);
    all.delete("data/202407/강남구.json");
    assert.equal(isGuComplete(all, "강남구", months), false);
    assert.equal(isGuComplete(new Set(), "강남구", months), false);
  });

  test("연도 작업의 month 필드는 YYYY00", () => {
    assert.equal(yearJobMonth("2024"), "202400");
  });
});
