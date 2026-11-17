// 구별 사실표. 해설 문장에 쓸 수 있는 숫자는 여기 있는 것뿐이다.
import { GU_ORDER } from "../data/gu.mjs";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function pickTopDong(dongs) {
  const list = Array.isArray(dongs) ? dongs : [];
  const strong = list.filter((d) => d && d.n >= 3 && num(d.medPerM2) !== null);
  if (strong.length) {
    const best = strong.reduce((a, b) => (b.medPerM2 > a.medPerM2 ? b : a));
    return best;
  }
  const withN = list.filter((d) => d && d.n > 0);
  if (withN.length) return withN.reduce((a, b) => (b.n > a.n ? b : a));
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
      topDong: top ? top.name : null,
      topDongMedPerM2: top ? num(top.medPerM2) : null,
      totalGus: 25,
    };
  });
  const ranked = rows
    .filter((r) => r.medPerM2 !== null)
    .sort((a, b) => b.medPerM2 - a.medPerM2 || GU_ORDER.indexOf(a.gu) - GU_ORDER.indexOf(b.gu));
  ranked.forEach((r, i) => { r.rankPrice = i + 1; });
  return rows;
}
