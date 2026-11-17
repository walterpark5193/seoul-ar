// 팔레트와 값→색 변환 (CONTRACTS 4절).

export const PALETTE = { bg: "#0b1020", guBase: "#1b2340", guDim: "#121833", ramp: ["#1e3a8a", "#2563eb", "#38bdf8", "#fbbf24", "#f97316"], noData: "#4b5563", text: "#e5e7eb" } as const;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

const RAMP: readonly Rgb[] = PALETTE.ramp.map(parseHex);

/** t∈[0,1]을 ramp 위에서 선형 보간한 "#rrggbb". 범위 밖은 자르고, NaN이면 noData. */
export function colorFor(t: number): string {
  if (Number.isNaN(t)) return PALETTE.noData;
  const last = RAMP.length - 1;
  const s = Math.min(1, Math.max(0, t)) * last;
  const i = Math.min(Math.floor(s), last - 1);
  const f = s - i;
  if (f === 0) return PALETTE.ramp[i]!;
  if (f === 1) return PALETTE.ramp[i + 1]!;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  return toHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

/** 최소~최대를 0~1로. 값이 하나뿐이거나 전부 같으면 0.5. null과 유한하지 않은 값은 null. */
export function normalize(values: (number | null)[]): (number | null)[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    return max === min ? 0.5 : (v - min) / (max - min);
  });
}
