// 구별 사실표. 해설 문장에 쓸 수 있는 숫자는 여기 있는 것뿐이다.
import { GU_ORDER } from "../data/gu.mjs";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// 최고 동을 고른 근거. "min3": 거래 TOP_DONG_MIN_N건 이상인 동 가운데 ㎡당 중위 최대(그 단서와 함께만 말할 수 있다).
// "maxN": 그런 동이 없어 거래가 가장 많은 동을 고름(대표값이 아니므로 해설에 이름을 쓰지 않는다). null: 동 없음.
export const TOP_DONG_MIN_N = 3;

// topDongIsMax: 고른 동의 ㎡당 중위가 거래 건수와 상관없이 구의 다른 모든 동보다 높은가(같은 값의 동이 있으면 유일한 최대가 아니므로 false).
// 참이면 "3건 이상" 단서 없이 "가장 높다"고 말해도 참이다(validateScript가 쓴다).
// tiedWith: min3일 때 거래 3건 이상인 다른 동 가운데 ㎡당 중위가 고른 동과 같은 동 이름(공동 최고, dongs 순서). 없으면 [].
function pickTopDong(dongs) {
  const list = Array.isArray(dongs) ? dongs : [];
  const priced = list.filter((d) => d && d.n > 0 && num(d.medPerM2) !== null);
  const isMax = (d) => num(d.medPerM2) !== null && priced.every((o) => o === d || o.medPerM2 < d.medPerM2);
  const strong = priced.filter((d) => d.n >= TOP_DONG_MIN_N);
  if (strong.length) {
    const best = strong.reduce((a, b) => (b.medPerM2 > a.medPerM2 ? b : a));
    const tiedWith = strong.filter((d) => d !== best && d.medPerM2 === best.medPerM2).map((d) => d.name);
    return { dong: best, basis: "min3", isMax: isMax(best), tiedWith };
  }
  const withN = list.filter((d) => d && d.n > 0);
  if (withN.length) {
    const most = withN.reduce((a, b) => (b.n > a.n ? b : a));
    return { dong: most, basis: "maxN", isMax: isMax(most), tiedWith: [] };
  }
  return null;
}

// 집계 중인 달: 데이터를 그 달이 끝나기 전에 받았다(generatedAt의 한국 시간 연월이 그 달이거나 그 이전).
// 지금 받은 거래만 센 것이라 건수·순위가 달 전체 합계처럼 들리면 안 된다(해설에 "(집계 중)"을 붙인다).
const KST_MS = 9 * 60 * 60 * 1000;
export function isPartialMonth(month, generatedAt) {
  const t = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(t)) return false;
  const d = new Date(t + KST_MS);
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return ym <= String(month);
}

export function buildFacts(index, guDataByName, month) {
  const summary = (index && index.summary && index.summary[month]) || {};
  const rows = GU_ORDER.map((gu) => {
    const data = guDataByName && guDataByName[gu];
    const t = (data && data.total) || summary[gu] || {};
    const n = num(t.n) ?? 0;
    const top = n > 0 ? pickTopDong(data && data.dongs) : null;
    return {
      gu,
      month,
      partial: isPartialMonth(month, data ? data.generatedAt : index && index.generatedAt),
      n,
      cancelled: num(t.cancelled) ?? 0,
      medPerM2: n > 0 ? num(t.medPerM2) : null,
      rankPrice: null,
      rankTied: false,
      maxAmt: n > 0 ? num(t.maxAmt) : null,
      topDong: top ? top.dong.name : null,
      topDongMedPerM2: top ? num(top.dong.medPerM2) : null,
      topDongBasis: top ? top.basis : null,
      topDongIsMax: top ? top.isMax : false,
      topDongTiedWith: top ? top.tiedWith : [],
      totalGus: 25,
    };
  });
  // 표준 경쟁 순위: ㎡당 중위가 같으면 같은 순위, 다음 순위는 그만큼 건너뛴다(예 13, 13, 15). rankTied: 같은 값의 구가 있다.
  const ranked = rows.filter((r) => r.medPerM2 !== null);
  for (const r of ranked) {
    r.rankPrice = 1 + ranked.filter((o) => o.medPerM2 > r.medPerM2).length;
    r.rankTied = ranked.some((o) => o !== r && o.medPerM2 === r.medPerM2);
  }
  return rows;
}
