// 구별 사실표. 해설 문장에 쓸 수 있는 숫자는 여기 있는 것뿐이다.
import { GU_ORDER } from "../data/gu.mjs";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// 최고 동을 고른 근거. "min3": 거래 TOP_DONG_MIN_N건 이상인 동 가운데 ㎡당 중위 최대(그 단서와 함께만 말할 수 있다).
// "maxN": 그런 동이 없어 거래가 가장 많은 동을 고름(대표값이 아니므로 해설에 이름을 쓰지 않는다). null: 동 없음.
export const TOP_DONG_MIN_N = 3;

function pickTopDong(dongs) {
  const list = Array.isArray(dongs) ? dongs : [];
  const strong = list.filter((d) => d && d.n >= TOP_DONG_MIN_N && num(d.medPerM2) !== null);
  if (strong.length) {
    const best = strong.reduce((a, b) => (b.medPerM2 > a.medPerM2 ? b : a));
    return { dong: best, basis: "min3" };
  }
  const withN = list.filter((d) => d && d.n > 0);
  if (withN.length) return { dong: withN.reduce((a, b) => (b.n > a.n ? b : a)), basis: "maxN" };
  return null;
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
      n,
      cancelled: num(t.cancelled) ?? 0,
      medPerM2: n > 0 ? num(t.medPerM2) : null,
      rankPrice: null,
      maxAmt: n > 0 ? num(t.maxAmt) : null,
      topDong: top ? top.dong.name : null,
      topDongMedPerM2: top ? num(top.dong.medPerM2) : null,
      topDongBasis: top ? top.basis : null,
      totalGus: 25,
    };
  });
  const ranked = rows
    .filter((r) => r.medPerM2 !== null)
    .sort((a, b) => b.medPerM2 - a.medPerM2 || GU_ORDER.indexOf(a.gu) - GU_ORDER.indexOf(b.gu));
  ranked.forEach((r, i) => { r.rankPrice = i + 1; });
  return rows;
}
