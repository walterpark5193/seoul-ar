#!/usr/bin/env node
// Marker art generator for "서울이 선다".
//
//   node tools/marker/make-slide.mjs [--out frontend/public/marker]
//
// Writes target.png (1024x1024, the MindAR image target) and slide.png (1920x1080, the presenter
// slide: target art on the left, title + QR placeholder on the right). The SVG is assembled in
// code with a seeded PRNG so output is deterministic, and all text is drawn as stroke paths
// (see glyphs.mjs) because this machine has no fonts.
//
// Tracking-oriented design: dark ground, bright irregular Voronoi "districts" with dot clusters,
// a curved river, a rising-bars motif, a random dot matrix, scattered background marks to the
// edges, bold stroke typography. Nothing repeats, nothing is mirror-symmetric, no large flat areas.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { textSvg, textWidth } from "./glyphs.mjs";

export const TARGET_SIZE = 1024;
export const SLIDE_SIZE = { width: 1920, height: 1080 };
export const TITLE = "서울이 선다";
export const HINT = "폰 카메라로 비춰 보세요";
export const SUBTITLE = "SEOUL STANDS";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = resolve(here, "../../frontend/public/marker");

// Palette (CONTRACTS 4, frontend/src/scene/colors.ts) so the marker matches the 3D scene.
const P = {
  bg: "#0b1020", guBase: "#1b2340", ramp: ["#1e3a8a", "#2563eb", "#38bdf8", "#fbbf24", "#f97316"],
  text: "#e5e7eb", river: "#38bdf8", amber: "#fbbf24", orange: "#f97316", dim: "#5b6a99",
};

// Approximate district centroids (lon, lat) in GU_ORDER; geographic fidelity is not the point,
// a Seoul-like silhouette with 25 irregular cells is.
const SITES = [
  ["종로구", 126.979, 37.595], ["중구", 126.996, 37.56], ["용산구", 126.98, 37.532], ["성동구", 127.041, 37.551],
  ["광진구", 127.086, 37.546], ["동대문구", 127.054, 37.582], ["중랑구", 127.093, 37.598], ["성북구", 127.018, 37.606],
  ["강북구", 127.011, 37.643], ["도봉구", 127.032, 37.669], ["노원구", 127.075, 37.655], ["은평구", 126.927, 37.617],
  ["서대문구", 126.939, 37.578], ["마포구", 126.908, 37.559], ["양천구", 126.855, 37.524], ["강서구", 126.822, 37.561],
  ["구로구", 126.858, 37.494], ["금천구", 126.902, 37.46], ["영등포구", 126.91, 37.522], ["동작구", 126.951, 37.498],
  ["관악구", 126.945, 37.467], ["서초구", 127.031, 37.473], ["강남구", 127.063, 37.496], ["송파구", 127.115, 37.505],
  ["강동구", 127.147, 37.55],
];
const RIVER = [
  [126.79, 37.588], [126.85, 37.568], [126.89, 37.548], [126.93, 37.535], [126.97, 37.522], [127.0, 37.519],
  [127.03, 37.528], [127.07, 37.527], [127.11, 37.534], [127.15, 37.558], [127.19, 37.574],
];

// ---------- small math helpers ----------
const f = (n) => String(Math.round(n * 10) / 10);
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const project = ([lon, lat]) => [(lon - 126.985) * Math.cos((37.555 * Math.PI) / 180), -(lat - 37.555)];

function convexHull(pts) {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (const p of s.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}
function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Keep the part of `poly` closer to `a` than to `b` (Sutherland–Hodgman against the bisector). */
function clipToBisector(poly, a, b) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  const side = (p) => (p[0] - mx) * dx + (p[1] - my) * dy;
  const cut = (p, q, sp, sq) => { const t = sp / (sp - sq); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
    const sc = side(cur), sp = side(prev);
    if (sc <= 0) { if (sp > 0) out.push(cut(prev, cur, sp, sc)); out.push(cur); }
    else if (sp <= 0) out.push(cut(prev, cur, sp, sc));
  }
  return out;
}
function bbox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
/** Catmull-Rom through points -> cubic Bézier path data. */
function smoothPath(pts) {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}
const poly = (pts) => pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");

// ---------- map: Voronoi districts clipped to an irregular Seoul-like outline ----------
function buildMap(box, rnd) {
  const sites = SITES.map(([, lon, lat]) => project([lon, lat]));
  const hull = convexHull(sites);
  const c = [sites.reduce((s, p) => s + p[0], 0) / sites.length, sites.reduce((s, p) => s + p[1], 0) / sites.length];
  const outline = [];
  for (let i = 0; i < hull.length; i++) {
    const v = hull[i], n = hull[(i + 1) % hull.length];
    const push = (p, k) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
    outline.push(push(v, 1.2 + rnd() * 0.12));
    outline.push(push([(v[0] + n[0]) / 2, (v[1] + n[1]) / 2], 1.1 + rnd() * 0.14));
  }
  // Fit outline (plus river overflow) into the box, preserving aspect.
  const b = bbox(outline);
  const k = Math.min(box.w / (b.maxX - b.minX), box.h / (b.maxY - b.minY));
  const ox = box.x + (box.w - (b.maxX - b.minX) * k) / 2, oy = box.y + (box.h - (b.maxY - b.minY) * k) / 2;
  const toPx = ([x, y]) => [ox + (x - b.minX) * k, oy + (y - b.minY) * k];
  const outlinePx = outline.map(toPx), sitesPx = sites.map(toPx);

  const cells = sitesPx.map((s, i) => {
    let cell = outlinePx;
    const neighbours = [];
    for (let j = 0; j < sitesPx.length; j++) {
      if (j === i) continue;
      const before = polygonArea(cell);
      cell = clipToBisector(cell, s, sitesPx[j]);
      if (polygonArea(cell) < before - 1e-6) neighbours.push(j);
    }
    return { site: s, poly: cell, neighbours };
  });
  // Greedy colouring: neighbours never share a fill, so every border is a luminance edge.
  const fills = [...P.ramp, P.guBase];
  const color = new Array(cells.length).fill(null);
  cells.forEach((cell, i) => {
    const used = new Set(cell.neighbours.map((j) => color[j]).filter(Boolean));
    const free = fills.filter((x) => !used.has(x));
    const pool = free.length ? free : fills;
    color[i] = pool[Math.floor(rnd() * pool.length)];
  });

  const parts = [];
  parts.push(`<g stroke="${P.bg}" stroke-width="7" stroke-linejoin="round">${cells.map((cell, i) => `<polygon points="${poly(cell.poly)}" fill="${color[i]}"/>`).join("")}</g>`);
  parts.push(`<g fill="none" stroke="${P.text}" stroke-width="2.5" stroke-linejoin="round" opacity="0.9">${cells.map((cell) => `<polygon points="${poly(cell.poly)}"/>`).join("")}</g>`);
  // Dot clusters of differing sizes inside each district (the "transactions").
  const dots = [];
  cells.forEach((cell, i) => {
    const cb = bbox(cell.poly);
    const n = 4 + Math.floor(rnd() * 9);
    let placed = 0, guard = 0;
    while (placed < n && guard++ < 200) {
      const p = [cb.minX + rnd() * (cb.maxX - cb.minX), cb.minY + rnd() * (cb.maxY - cb.minY)];
      if (!pointInPolygon(p, cell.poly)) continue;
      const r = 2 + rnd() * 6.5;
      const dark = color[i] === P.amber || color[i] === P.ramp[2];
      const fill = dark ? P.bg : rnd() < 0.6 ? P.text : P.amber;
      dots.push(rnd() < 0.25
        ? `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${f(r)}" fill="none" stroke="${fill}" stroke-width="2"/>`
        : `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${f(r)}" fill="${fill}"/>`);
      placed++;
    }
  });
  parts.push(`<g>${dots.join("")}</g>`);
  // Han river: light edge under a cyan core, clipped to the outline so it does not spill out.
  const riverPx = RIVER.map(project).map(toPx);
  parts.push(`<clipPath id="mapClip"><polygon points="${poly(outlinePx)}"/></clipPath>`);
  parts.push(`<g clip-path="url(#mapClip)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${smoothPath(riverPx)}" stroke="${P.text}" stroke-width="17"/><path d="${smoothPath(riverPx)}" stroke="${P.river}" stroke-width="10"/></g>`);
  return parts.join("");
}

// ---------- the 1024x1024 target art ----------
/** Inner SVG content (no <svg> wrapper) for the 1024x1024 target; reused scaled inside the slide. */
export function targetArtInner() {
  const S = TARGET_SIZE;
  const rnd = mulberry32(20261117);
  const out = [`<rect width="${S}" height="${S}" fill="${P.bg}"/>`];

  // Background marks to the very edges: jittered grid (never periodic), varied shapes and sizes.
  const marks = [];
  const cellsPerSide = 34, cs = S / cellsPerSide;
  for (let gy = 0; gy < cellsPerSide; gy++) {
    for (let gx = 0; gx < cellsPerSide; gx++) {
      if (rnd() > 0.62) continue;
      const x = gx * cs + 3 + rnd() * (cs - 6), y = gy * cs + 3 + rnd() * (cs - 6);
      const t = rnd();
      if (t < 0.5) marks.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(1.8 + rnd() * 2.4)}"/>`);
      else if (t < 0.8) { const l = 4 + rnd() * 6; marks.push(`<path d="M${f(x - l)} ${f(y)}H${f(x + l)}M${f(x)} ${f(y - l)}V${f(y + l)}" stroke-width="2.2"/>`); }
      else { const l = 5 + rnd() * 9, a = rnd() * Math.PI; marks.push(`<path d="M${f(x - Math.cos(a) * l)} ${f(y - Math.sin(a) * l)}L${f(x + Math.cos(a) * l)} ${f(y + Math.sin(a) * l)}" stroke-width="2.8"/>`); }
    }
  }
  out.push(`<g fill="${P.dim}" stroke="${P.dim}" stroke-linecap="round" opacity="0.9">${marks.join("")}</g>`);
  // (Tried an extra layer of 18–36px shapes to feed MindAR's 256/128px tracking templates: tracking
  // points stayed within noise (38/24 vs 34/26) while the art got cluttered, so it was dropped.)

  // Title (two colour runs) and Latin subtitle, top-left.
  const titleSize = 124; // "서울이 선다" ends near x=774, clear of the ripple at x>=816
  const run1 = "서울이 ";
  out.push(textSvg(run1, { x: 52, y: 58, size: titleSize, color: P.text, weight: 0.115 }));
  out.push(textSvg("선다", { x: 52 + textWidth(run1, titleSize) + 0.08 * titleSize, y: 58, size: titleSize, color: P.amber, weight: 0.115 }));
  out.push(textSvg(SUBTITLE, { x: 56, y: 204, size: 30, color: P.river, weight: 0.13, letterSpacing: 0.2 }));

  // Ripple accent, top-right: three jittered rings (asymmetric, non-repeating).
  const rings = [];
  const rc = [912, 150];
  for (let r = 0; r < 3; r++) {
    const R = 30 + r * 26, pts = [];
    const n = 11 + r * 2;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + rnd() * 0.25; const rr = R * (0.86 + rnd() * 0.28); pts.push([rc[0] + Math.cos(a) * rr, rc[1] + Math.sin(a) * rr]); }
    rings.push(`<polygon points="${poly(pts)}"/>`);
  }
  out.push(`<g fill="none" stroke="${P.text}" stroke-width="2.4" stroke-linejoin="round" opacity="0.95">${rings.join("")}</g><circle cx="${rc[0]}" cy="${rc[1]}" r="8" fill="${P.amber}"/>`);

  // Map, centre-left.
  out.push(buildMap({ x: 40, y: 286, w: 684, h: 520 }, rnd));

  // Rising bars motif ("stands"), right side, with an axis and irregular ticks.
  const bars = [];
  // Widths (188) + gaps (<= 6*12) from x=752 stay inside the canvas: right edge <= 1012.
  const heights = [0.36, 0.62, 0.47, 0.9, 0.7, 1.0, 0.55], widths = [22, 30, 20, 34, 26, 32, 24];
  let bx = 752;
  heights.forEach((h, i) => {
    const bh = 90 + h * 400, w = widths[i], y = 800 - bh;
    const fill = P.ramp[Math.min(P.ramp.length - 1, Math.floor(h * P.ramp.length))];
    bars.push(`<rect x="${bx}" y="${f(y)}" width="${w}" height="${f(bh)}" fill="${fill}" stroke="${P.text}" stroke-width="1.5"/>`);
    bars.push(`<rect x="${bx - 3}" y="${f(y - 5)}" width="${w + 6}" height="5" fill="${P.text}"/>`);
    bx += w + 7 + Math.floor(rnd() * 6);
  });
  const ticks = [];
  for (let i = 0; i < 14; i++) { const ty = 300 + rnd() * 500, l = 6 + rnd() * 12; ticks.push(`<path d="M${f(740 - l)} ${f(ty)}H740"/>`); }
  out.push(`<g>${bars.join("")}</g><g stroke="${P.text}" stroke-width="2.5" fill="none"><path d="M740 292V806H1012"/>${ticks.join("")}</g>`);

  // Hint line, bottom-left, plus an aperiodic dashed baseline.
  out.push(textSvg(HINT, { x: 52, y: 886, size: 44, color: P.text, weight: 0.1 }));
  const dashes = [];
  let dx = 52;
  while (dx < 690) { const l = 8 + rnd() * 46; dashes.push(`<path d="M${f(dx)} 972H${f(Math.min(dx + l, 690))}"/>`); dx += l + 6 + rnd() * 18; }
  out.push(`<g stroke="${P.river}" stroke-width="3.5" stroke-linecap="butt">${dashes.join("")}</g>`);

  // Random dot matrix, bottom-right: binary-looking but non-repeating, strong corners.
  const matrix = [];
  const mc = 9, ms = 21, mx0 = 782, my0 = 808;
  for (let gy = 0; gy < mc; gy++) {
    for (let gx = 0; gx < mc; gx++) {
      if (rnd() > 0.56) continue;
      const cx = mx0 + gx * ms + ms / 2, cy = my0 + gy * ms + ms / 2, t = rnd();
      if (t < 0.4) matrix.push(`<rect x="${f(cx - 7.5)}" y="${f(cy - 7.5)}" width="15" height="15" fill="${P.text}"/>`);
      else if (t < 0.7) matrix.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="7.5" fill="${P.amber}"/>`);
      else if (t < 0.85) matrix.push(`<polygon points="${f(cx)},${f(cy - 8)} ${f(cx + 8)},${f(cy)} ${f(cx)},${f(cy + 8)} ${f(cx - 8)},${f(cy)}" fill="${P.river}"/>`);
      else matrix.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="6" fill="none" stroke="${P.text}" stroke-width="2.5"/>`);
    }
  }
  out.push(`<g>${matrix.join("")}</g>`);
  return out.join("");
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function buildTargetSvg() {
  const S = TARGET_SIZE;
  return `<svg xmlns="${SVG_NS}" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${targetArtInner()}</svg>`;
}

export function buildSlideSvg() {
  const { width: W, height: H } = SLIDE_SIZE;
  const card = 1000, cardX = 60, cardY = (H - card) / 2;
  const out = [`<rect width="${W}" height="${H}" fill="#05070f"/>`];
  out.push(`<g transform="translate(${cardX} ${cardY}) scale(${card / TARGET_SIZE})">${targetArtInner()}</g>`);
  out.push(`<rect x="${cardX - 1.5}" y="${cardY - 1.5}" width="${card + 3}" height="${card + 3}" fill="none" stroke="#1b2340" stroke-width="3"/>`);
  const px = 1124;
  const titleSize = 122;
  const run1 = "서울이 ";
  out.push(textSvg(run1, { x: px, y: 110, size: titleSize, color: P.text, weight: 0.115 }));
  out.push(textSvg("선다", { x: px + textWidth(run1, titleSize) + 0.08 * titleSize, y: 110, size: titleSize, color: P.amber, weight: 0.115 }));
  out.push(textSvg(SUBTITLE, { x: px + 4, y: 252, size: 32, color: P.river, weight: 0.13, letterSpacing: 0.2 }));
  out.push(textSvg(HINT, { x: px + 4, y: 330, size: 40, color: P.text, weight: 0.1, opacity: 0.92 }));
  // QR placeholder: the host page draws the real QR (current URL) over this frame.
  const q = 400, qx = 1304, qy = 540;
  out.push(`<rect x="${qx}" y="${qy}" width="${q}" height="${q}" rx="14" fill="none" stroke="${P.text}" stroke-width="3" stroke-dasharray="18 10" opacity="0.8"/>`);
  const cornerLen = 40;
  const corners = [[qx, qy, 1, 1], [qx + q, qy, -1, 1], [qx, qy + q, 1, -1], [qx + q, qy + q, -1, -1]]
    .map(([x, y, sx, sy]) => `<path d="M${x + sx * cornerLen} ${y}H${x}V${y + sy * cornerLen}"/>`).join("");
  out.push(`<g fill="none" stroke="${P.amber}" stroke-width="6" stroke-linecap="square">${corners}</g>`);
  const qrLabel = "QR";
  out.push(textSvg(qrLabel, { x: qx + q / 2 - textWidth(qrLabel, 64) / 2, y: qy + q / 2 - 32, size: 64, color: P.dim, weight: 0.12 }));
  const scan = "SCAN";
  out.push(textSvg(scan, { x: qx + q / 2 - textWidth(scan, 30, { letterSpacing: 0.2 }) / 2, y: qy + q + 28, size: 30, color: P.river, weight: 0.13, letterSpacing: 0.2 }));
  return `<svg xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join("")}</svg>`;
}

async function renderPng(svg, file, width, height) {
  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(buf).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(`${file}: rendered ${meta.width}x${meta.height}, expected ${width}x${height}`);
  }
  await writeFile(file, buf);
  return buf.length;
}

/** Render target.png and slide.png into `outDir`; returns the written paths. */
export async function renderMarkerAssets({ outDir = DEFAULT_OUT_DIR, log = () => {} } = {}) {
  await mkdir(outDir, { recursive: true });
  const target = resolve(outDir, "target.png");
  const slide = resolve(outDir, "slide.png");
  const tb = await renderPng(buildTargetSvg(), target, TARGET_SIZE, TARGET_SIZE);
  log(`wrote ${target} (${TARGET_SIZE}x${TARGET_SIZE}, ${tb} bytes)`);
  const sb = await renderPng(buildSlideSvg(), slide, SLIDE_SIZE.width, SLIDE_SIZE.height);
  log(`wrote ${slide} (${SLIDE_SIZE.width}x${SLIDE_SIZE.height}, ${sb} bytes)`);
  return { target, slide };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf("--out");
  const outDir = i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : DEFAULT_OUT_DIR;
  renderMarkerAssets({ outDir, log: console.log }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
