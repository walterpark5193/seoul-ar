// Font-free stroke glyphs for the marker art.
//
// The build machine has no fonts at all (no fontconfig, no CJK, not even Latin), so SVG <text>
// rasterizes to nothing through sharp/librsvg. Everything textual is therefore drawn as stroked
// paths: Hangul syllables are composed from jamo strokes with simple block layouts, plus a small
// Latin capital subset. Coordinates are unit-box (x right, y down); callers scale by font size.
//
// Dense components (e.g. a final ㄹ: three bars in a 0.34 em box) get a thinner stroke so their
// parallel bars keep a visible gap instead of fusing into a solid block (see `densityFactor`).

const Jamo = {
  // consonants
  "ㄱ": [[[0, 0], [1, 0], [1, 1]]],
  "ㄴ": [[[0, 0], [0, 1], [1, 1]]],
  "ㄷ": [[[1, 0], [0, 0], [0, 1], [1, 1]]],
  "ㄹ": [[[0, 0], [1, 0], [1, 0.5], [0, 0.5], [0, 1], [1, 1]]],
  "ㅁ": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  "ㅂ": [[[0, 0], [0, 1], [1, 1], [1, 0]], [[0, 0.5], [1, 0.5]]],
  "ㅅ": [[[0.5, 0], [0, 1]], [[0.35, 0.3], [1, 1]]],
  "ㅇ": [{ c: [0.5, 0.5], r: 0.5 }],
  "ㅈ": [[[0, 0], [1, 0]], [[0.5, 0], [0.04, 1]], [[0.37, 0.28], [0.96, 1]]],
  "ㅊ": [[[0.5, 0], [0.5, 0.2]], [[0, 0.2], [1, 0.2]], [[0.5, 0.2], [0.04, 1]], [[0.38, 0.46], [0.96, 1]]],
  "ㅋ": [[[0, 0], [1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  "ㅌ": [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.85, 0.5]]],
  "ㅍ": [[[0.04, 0], [0.96, 0]], [[0.3, 0], [0.3, 1]], [[0.7, 0], [0.7, 1]], [[0, 1], [1, 1]]],
  "ㅎ": [[[0.5, 0], [0.5, 0.16]], [[0.04, 0.16], [0.96, 0.16]], { c: [0.5, 0.66], r: 0.34 }],
  // vowels drawn in a narrow, tall box (beside the consonant)
  "ㅏ": [[[0.3, 0], [0.3, 1]], [[0.3, 0.5], [1, 0.5]]],
  "ㅓ": [[[0.7, 0], [0.7, 1]], [[0, 0.5], [0.7, 0.5]]],
  "ㅣ": [[[0.5, 0], [0.5, 1]]],
  "ㅔ": [[[0.3, 0], [0.3, 1]], [[0, 0.5], [0.3, 0.5]], [[0.88, 0], [0.88, 1]]],
  "ㅐ": [[[0.12, 0], [0.12, 1]], [[0.12, 0.5], [0.7, 0.5]], [[0.7, 0], [0.7, 1]]],
  "ㅑ": [[[0.3, 0], [0.3, 1]], [[0.3, 0.34], [1, 0.34]], [[0.3, 0.66], [1, 0.66]]],
  "ㅕ": [[[0.7, 0], [0.7, 1]], [[0, 0.34], [0.7, 0.34]], [[0, 0.66], [0.7, 0.66]]],
  // vowels drawn in a wide, short box (below the consonant)
  "ㅗ": [[[0, 1], [1, 1]], [[0.5, 0], [0.5, 1]]],
  "ㅜ": [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  "ㅛ": [[[0, 1], [1, 1]], [[0.34, 0], [0.34, 1]], [[0.66, 0], [0.66, 1]]],
  "ㅠ": [[[0, 0], [1, 0]], [[0.34, 0], [0.34, 1]], [[0.66, 0], [0.66, 1]]],
  "ㅡ": [[[0, 0.5], [1, 0.5]]],
};

// Smallest distance (fraction of the component box) between parallel bars: `h` for horizontal
// bars stacked vertically, `v` for vertical bars side by side. Infinity = no parallel pair.
const PITCH = {
  "ㄷ": { h: 1 }, "ㄹ": { h: 0.5 }, "ㅁ": { h: 1, v: 1 }, "ㅂ": { h: 0.5, v: 1 }, "ㅊ": { h: 0.2 },
  "ㅋ": { h: 0.5 }, "ㅌ": { h: 0.5 }, "ㅍ": { h: 1, v: 0.4 }, "ㅎ": { h: 0.16 },
  "ㅔ": { v: 0.58 }, "ㅐ": { v: 0.58 }, "ㅑ": { h: 0.32 }, "ㅕ": { h: 0.32 }, "ㅛ": { v: 0.32 }, "ㅠ": { v: 0.32 },
};
const MIN_GAP_RATIO = 0.5; // bars must stay >= 0.5 stroke widths apart (edge to edge)
const MIN_FACTOR = 0.5;

const VERTICAL_VOWELS = new Set(["ㅏ", "ㅓ", "ㅣ", "ㅔ", "ㅐ", "ㅑ", "ㅕ"]);
const HORIZONTAL_VOWELS = new Set(["ㅗ", "ㅜ", "ㅛ", "ㅠ", "ㅡ"]);
const COMPOUND_VOWELS = {
  "ㅘ": ["ㅗ", "ㅏ"], "ㅙ": ["ㅗ", "ㅐ"], "ㅚ": ["ㅗ", "ㅣ"],
  "ㅝ": ["ㅜ", "ㅓ"], "ㅞ": ["ㅜ", "ㅔ"], "ㅟ": ["ㅜ", "ㅣ"], "ㅢ": ["ㅡ", "ㅣ"],
};

// Unicode Hangul syllable decomposition tables (U+AC00..U+D7A3).
const CHOSEONG = [..."ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"];
const JUNGSEONG = [..."ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"];
const JONGSEONG = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];

// Latin capitals in a unit box; `w` is the advance (box width) relative to the em.
const Latin = {
  A: { w: 0.78, s: [[[0, 1], [0.5, 0], [1, 1]], [[0.18, 0.66], [0.82, 0.66]]] },
  C: { w: 0.74, s: [[[1, 0.12], [0.7, 0], [0.28, 0], [0, 0.22], [0, 0.78], [0.28, 1], [0.7, 1], [1, 0.88]]] },
  D: { w: 0.72, s: [[[0, 0], [0, 1], [0.56, 1], [1, 0.74], [1, 0.26], [0.56, 0], [0, 0]]] },
  E: { w: 0.62, s: [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.8, 0.5]]] },
  G: { w: 0.78, s: [[[1, 0.12], [0.7, 0], [0.28, 0], [0, 0.22], [0, 0.78], [0.28, 1], [0.7, 1], [1, 0.8], [1, 0.55], [0.55, 0.55]]] },
  H: { w: 0.72, s: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]] },
  I: { w: 0.22, s: [[[0.5, 0], [0.5, 1]]] },
  L: { w: 0.6, s: [[[0, 0], [0, 1], [1, 1]]] },
  M: { w: 0.86, s: [[[0, 1], [0, 0], [0.5, 0.62], [1, 0], [1, 1]]] },
  N: { w: 0.74, s: [[[0, 1], [0, 0], [1, 1], [1, 0]]] },
  O: { w: 0.8, s: [{ c: [0.5, 0.5], r: 0.5 }] },
  P: { w: 0.68, s: [[[0, 1], [0, 0], [0.7, 0], [1, 0.14], [1, 0.42], [0.7, 0.56], [0, 0.56]]] },
  Q: { w: 0.8, s: [{ c: [0.5, 0.5], r: 0.5 }, [[0.64, 0.7], [1.02, 1.06]]] },
  R: { w: 0.7, s: [[[0, 1], [0, 0], [0.7, 0], [1, 0.14], [1, 0.4], [0.7, 0.54], [0, 0.54]], [[0.58, 0.54], [1, 1]]] },
  S: { w: 0.72, s: [[[1, 0.14], [0.74, 0], [0.26, 0], [0, 0.16], [0, 0.36], [0.26, 0.5], [0.74, 0.5], [1, 0.64], [1, 0.84], [0.74, 1], [0.26, 1], [0, 0.86]]] },
  T: { w: 0.68, s: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]] },
  U: { w: 0.72, s: [[[0, 0], [0, 0.78], [0.22, 1], [0.78, 1], [1, 0.78], [1, 0]]] },
};

export const SPACE_ADVANCE = 0.42;

// Block layouts: rects are [x, y, w, h] inside the unit syllable cell. Finals get 0.34 em so a
// three-bar ㄹ/ㅌ still resolves (together with the density-based stroke thinning below).
const LAYOUT = {
  vertical: { cons: [0.02, 0.1, 0.5, 0.8], vowel: [0.64, 0, 0.34, 1] },
  verticalFinal: { cons: [0.02, 0.02, 0.48, 0.5], vowel: [0.64, 0, 0.34, 0.58], final: [0.08, 0.66, 0.84, 0.34] },
  horizontal: { cons: [0.14, 0.02, 0.72, 0.46], vowel: [0, 0.58, 1, 0.4] },
  horizontalFinal: { cons: [0.18, 0, 0.64, 0.3], vowel: [0.02, 0.36, 0.96, 0.22], final: [0.1, 0.66, 0.8, 0.34] },
  compound: { cons: [0.04, 0.02, 0.44, 0.44], hvowel: [0, 0.54, 0.56, 0.26], vvowel: [0.66, 0, 0.32, 1] },
  compoundFinal: { cons: [0.04, 0, 0.42, 0.3], hvowel: [0, 0.36, 0.56, 0.2], vvowel: [0.66, 0, 0.32, 0.58], final: [0.1, 0.66, 0.8, 0.34] },
};

function decompose(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0xac00 || cp > 0xd7a3) return null;
  const idx = cp - 0xac00;
  return {
    initial: CHOSEONG[Math.floor(idx / (21 * 28))],
    medial: JUNGSEONG[Math.floor((idx % (21 * 28)) / 28)],
    final: JONGSEONG[idx % 28],
  };
}

/**
 * Stroke-width factor (<= 1) so that a component's parallel bars, once fitted into a box of
 * `bw` x `bh` with full stroke `s` (all in em), keep an edge-to-edge gap >= MIN_GAP_RATIO * stroke.
 * Solves pitch * (box - f*s) >= (1 + MIN_GAP_RATIO) * f*s for f.
 */
export function densityFactor(jamo, bw, bh, s) {
  const p = PITCH[jamo];
  if (!p) return 1;
  let f = 1;
  if (p.h) f = Math.min(f, (p.h * bh) / (s * (1 + MIN_GAP_RATIO + p.h)));
  if (p.v) f = Math.min(f, (p.v * bw) / (s * (1 + MIN_GAP_RATIO + p.v)));
  return Math.max(MIN_FACTOR, Math.min(1, f));
}

/** Map unit-box strokes into `rect` ([x, y, w, h]), shrunk by `hw` on every side so stroke caps stay inside. */
function fit(strokes, [rx, ry, rw, rh], hw, wf = 1) {
  const x0 = rx + hw, y0 = ry + hw, w = Math.max(rw - 2 * hw, 0.01), h = Math.max(rh - 2 * hw, 0.01);
  return strokes.map((s) => {
    if (Array.isArray(s)) return { pts: s.map(([px, py]) => [x0 + px * w, y0 + py * h]), wf };
    return { e: [x0 + s.c[0] * w, y0 + s.c[1] * h, s.r * w, s.r * h], wf };
  });
}

/** Place one jamo into a box: pick its stroke factor from the box size, then fit with the thinner inset. */
function place(jamo, rect, hw) {
  const wf = densityFactor(jamo, rect[2], rect[3], 2 * hw);
  return fit(Jamo[jamo], rect, hw * wf, wf);
}

function hangulStrokes(parts, hw) {
  const { initial, medial, final } = parts;
  const out = [];
  if (!Jamo[initial]) return null;
  if (final && !Jamo[final]) return null;
  if (VERTICAL_VOWELS.has(medial)) {
    const L = final ? LAYOUT.verticalFinal : LAYOUT.vertical;
    out.push(...place(initial, L.cons, hw), ...place(medial, L.vowel, hw));
    if (final) out.push(...place(final, L.final, hw));
  } else if (HORIZONTAL_VOWELS.has(medial)) {
    const L = final ? LAYOUT.horizontalFinal : LAYOUT.horizontal;
    out.push(...place(initial, L.cons, hw), ...place(medial, L.vowel, hw));
    if (final) out.push(...place(final, L.final, hw));
  } else if (COMPOUND_VOWELS[medial]) {
    const [h, v] = COMPOUND_VOWELS[medial];
    const L = final ? LAYOUT.compoundFinal : LAYOUT.compound;
    out.push(...place(initial, L.cons, hw), ...place(h, L.hvowel, hw), ...place(v, L.vvowel, hw));
    if (final) out.push(...place(final, L.final, hw));
  } else {
    return null;
  }
  return out;
}

/**
 * Strokes for one character at the given half stroke width (unit-em units).
 * Returns { w, strokes } where each stroke is { pts | e, wf } with coordinates in [0, w] x [0, 1]
 * and `wf` the stroke-width factor; or null if unsupported.
 */
export function glyph(ch, hw = 0.055) {
  const latin = Latin[ch.toUpperCase()];
  if (latin) return { w: latin.w, strokes: fit(latin.s, [0, 0, latin.w, 1], hw) };
  if (Jamo[ch]) return { w: 1, strokes: place(ch, [0.05, 0.05, 0.9, 0.9], hw) };
  const parts = decompose(ch);
  if (!parts) return null;
  const strokes = hangulStrokes(parts, hw);
  return strokes ? { w: 1, strokes } : null;
}

export function hasGlyph(ch) {
  return ch === " " || glyph(ch) !== null;
}

export function textWidth(text, size, { letterSpacing = 0.08 } = {}) {
  let w = 0;
  const chars = [...text];
  chars.forEach((ch, i) => {
    if (ch === " ") { w += SPACE_ADVANCE; return; }
    const g = glyph(ch);
    if (!g) throw new Error(`no glyph for "${ch}"`);
    w += g.w + (i < chars.length - 1 ? letterSpacing : 0);
  });
  return w * size;
}

const f = (n) => String(Math.round(n * 100) / 100);

/** SVG <g> of stroked paths for `text`, with the em box's top-left at (x, y). */
export function textSvg(text, { x, y, size, color = "#e5e7eb", weight = 0.11, letterSpacing = 0.08, opacity = 1 }) {
  const hw = weight / 2;
  const sw = size * weight;
  const parts = [];
  let cx = x;
  for (const ch of [...text]) {
    if (ch === " ") { cx += size * SPACE_ADVANCE; continue; }
    const g = glyph(ch, hw);
    if (!g) throw new Error(`no glyph for "${ch}"`);
    for (const s of g.strokes) {
      const widthAttr = s.wf === 1 ? "" : ` stroke-width="${f(sw * s.wf)}"`;
      if (s.pts) {
        const pts = s.pts.map(([px, py]) => `${f(cx + px * size)} ${f(y + py * size)}`);
        const first = s.pts[0], last = s.pts[s.pts.length - 1];
        const closed = s.pts.length > 2 && first[0] === last[0] && first[1] === last[1];
        const d = closed ? `M${pts.slice(0, -1).join("L")}Z` : `M${pts.join("L")}`;
        parts.push(`<path d="${d}"${widthAttr}/>`);
      } else {
        const [ex, ey, rx, ry] = s.e;
        parts.push(`<ellipse cx="${f(cx + ex * size)}" cy="${f(y + ey * size)}" rx="${f(rx * size)}" ry="${f(ry * size)}"${widthAttr}/>`);
      }
    }
    cx += size * (g.w + letterSpacing);
  }
  const op = opacity === 1 ? "" : ` opacity="${opacity}"`;
  return `<g fill="none" stroke="${color}" stroke-width="${f(sw)}" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="2"${op}>${parts.join("")}</g>`;
}
