// 서울 실거래 원자료(행 배열)를 구·월·법정동 통계로 집계한다 (CONTRACTS 2절).
// 출력에는 행 단위 데이터, 본번(MNO), 부번(SNO), 건물명(BLDG_NM)이 들어가지 않는다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GU_ORDER } from "./gu.mjs";

export const SOURCE = "서울 열린데이터광장 부동산 실거래가(tbLnOpendataRtmsV)";
const PAGE_SIZE = 1000; // MCP search_trades 가 한 번에 주는 최대 건수. 이 수에 닿으면 잘렸을 수 있다.

/** 중앙값. 빈 배열은 null, 짝수 개수는 두 가운데 값의 평균을 Math.round 한다 (2.5 → 3). */
export function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function isValid(row) {
  // 취소일이 비어 있으면 유효 거래. undefined/null 도 빈 것으로 본다.
  return String(row.RTRCN_DAY ?? "").trim() === "";
}

function amount(row) {
  return Number(row.THING_AMT);
}

function area(row) {
  const a = Number(row.ARCH_AREA);
  return Number.isFinite(a) ? a : 0;
}

function perM2(row) {
  return Math.round(amount(row) / area(row));
}

/** 유효·취소 행 묶음에서 공통 통계(n, cancelled, medPerM2, medAmt, maxAmt)를 낸다. */
function baseStats(rows) {
  const valid = rows.filter(isValid);
  const withArea = valid.filter((r) => area(r) > 0);
  const amounts = valid.map(amount);
  return {
    n: valid.length,
    cancelled: rows.length - valid.length,
    medPerM2: median(withArea.map(perM2)),
    medAmt: median(amounts),
    maxAmt: amounts.length ? Math.max(...amounts) : null,
  };
}

function dongStat(name, rows) {
  const valid = rows.filter(isValid);
  const apt = valid.filter((r) => r.BLDG_USG === "아파트");
  const aptWithArea = apt.filter((r) => area(r) > 0);
  const usage = {};
  for (const r of valid) usage[r.BLDG_USG] = (usage[r.BLDG_USG] ?? 0) + 1;
  const base = baseStats(rows);
  return {
    name,
    n: base.n,
    cancelled: base.cancelled,
    nApt: apt.length,
    medPerM2: base.medPerM2,
    medPerM2Apt: median(aptWithArea.map(perM2)),
    medAmt: base.medAmt,
    maxAmt: base.maxAmt,
    usage,
  };
}

/** medPerM2 내림차순(null 뒤) → n 내림차순 → 이름 오름차순 */
export function compareDongs(a, b) {
  if (a.medPerM2 === null && b.medPerM2 !== null) return 1;
  if (a.medPerM2 !== null && b.medPerM2 === null) return -1;
  if (a.medPerM2 !== null && b.medPerM2 !== null && a.medPerM2 !== b.medPerM2) return b.medPerM2 - a.medPerM2;
  if (a.n !== b.n) return b.n - a.n;
  return a.name.localeCompare(b.name, "ko");
}

/** 한 구·월의 원자료 행 배열 → GuData */
export function aggregateRows(rows, { month, gu, generatedAt }) {
  const byDong = new Map();
  for (const r of rows) {
    const name = String(r.STDG_NM ?? "").trim() || "(법정동 미상)";
    if (!byDong.has(name)) byDong.set(name, []);
    byDong.get(name).push(r);
  }
  const dongs = [...byDong.entries()].map(([name, rs]) => dongStat(name, rs)).sort(compareDongs);
  return {
    v: 1,
    month,
    gu,
    generatedAt,
    total: { ...baseStats(rows), truncated: rows.length >= PAGE_SIZE },
    dongs,
  };
}

/** 월별 × 구별 GuData 배열 → DataIndex */
export function buildIndex(perGu, { months, generatedAt }) {
  const summary = {};
  for (const month of months) summary[month] = {};
  for (const monthData of perGu) {
    for (const g of monthData) {
      if (!summary[g.month]) continue;
      summary[g.month][g.gu] = g.total;
    }
  }
  // 구 순서를 GU_ORDER 로 고정하고 빠진 구는 빈 통계로 채운다.
  for (const month of months) {
    const ordered = {};
    for (const gu of GU_ORDER) {
      ordered[gu] = summary[month][gu] ?? { n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null, truncated: false };
    }
    summary[month] = ordered;
  }
  return { v: 1, generatedAt, source: SOURCE, months: [...months], gus: [...GU_ORDER], summary };
}

/**
 * 원자료 파일 내용을 행 객체 배열로 푼다.
 * 두 형식을 받는다: (1) 행 객체 배열, (2) 압축형 {fields: [...], rows: [[...], ...]} (열 이름 배열 + 값 배열).
 * 압축형은 수집 단계에서 쓰는 필드만 적어 저장 용량을 줄이기 위한 것이다.
 */
export function expandRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.fields) && Array.isArray(parsed.rows)) {
    const { fields, rows } = parsed;
    return rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
  }
  throw new Error("원자료 형식 오류: 행 배열 또는 {fields, rows} 여야 함");
}

function readRows(rawDir, month, gu) {
  const file = join(rawDir, month, `${gu}.json`);
  if (!existsSync(file)) {
    console.warn(`[aggregate] 원자료 없음: ${file} → 빈 배열로 처리`);
    return [];
  }
  try {
    return expandRows(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

function parseArgs(argv) {
  const opts = { raw: "tools/data/raw", out: "frontend/public/data", months: "202609,202610,202611" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) opts[a.slice(2)] = argv[++i];
  }
  return { raw: opts.raw, out: opts.out, months: opts.months.split(",").map((m) => m.trim()).filter(Boolean) };
}

export function runCli(argv) {
  const { raw, out, months } = parseArgs(argv);
  const generatedAt = new Date().toISOString();
  const perGu = months.map((month) => {
    mkdirSync(join(out, month), { recursive: true });
    return GU_ORDER.map((gu) => {
      const data = aggregateRows(readRows(raw, month, gu), { month, gu, generatedAt });
      writeFileSync(join(out, month, `${gu}.json`), JSON.stringify(data) + "\n");
      return data;
    });
  });
  const index = buildIndex(perGu, { months, generatedAt });
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
  for (const month of months) {
    const total = GU_ORDER.reduce((s, gu) => s + index.summary[month][gu].n, 0);
    console.log(`[aggregate] ${month}: 유효 거래 ${total}건 (25구)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
