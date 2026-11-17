// GeoJSON(서울 자치구) -> Geo(unit-square). 순수 함수 convertGeoJson + CLI.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GU_ORDER, GU_CODE } from "./gu.mjs";

const MAX_RING = 400;
const round = (n) => Math.round(n * 1e7) / 1e7 + 0; // +0: -0 방지

function guName(props = {}) {
  return props.name ?? props.SIG_KOR_NM ?? props.SGG_NM ?? null;
}

function openRing(ring) {
  const r = ring.map((p) => [p[0], p[1]]);
  const a = r[0], b = r[r.length - 1];
  if (r.length > 1 && a[0] === b[0] && a[1] === b[1]) r.pop();
  return r;
}

function downsample(ring) {
  if (ring.length <= MAX_RING) return ring;
  return Array.from({ length: MAX_RING }, (_, i) => ring[Math.floor((i * ring.length) / MAX_RING)]);
}

function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates.slice(0, 1);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((poly) => poly[0]);
  return [];
}

function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
    const c = x0 * z1 - x1 * z0;
    a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c;
  }
  if (Math.abs(a) < 1e-12) {
    const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function convertGeoJson(fc) {
  const byName = new Map();
  for (const f of fc.features ?? []) {
    const name = guName(f.properties);
    if (!GU_ORDER.includes(name)) continue;
    const rings = outerRings(f.geometry).map(openRing).filter((r) => r.length >= 3);
    if (rings.length) byName.set(name, [...(byName.get(name) ?? []), ...rings]);
  }
  const lons = [], lats = [];
  for (const rings of byName.values()) for (const r of rings) for (const [lon, lat] of r) { lons.push(lon); lats.push(lat); }
  if (!lons.length) return { v: 1, crs: "unit-square", gus: [] };
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const project = ([lon, lat]) => [(lon - lon0) * k, -(lat - lat0)];
  const w = (Math.max(...lons) - Math.min(...lons)) * k;
  const h = Math.max(...lats) - Math.min(...lats);
  const scale = 1 / Math.max(w, h);
  const gus = GU_ORDER.filter((n) => byName.has(n)).map((name) => {
    const full = byName.get(name).map((r) => r.map((p) => project(p).map((v) => v * scale)));
    const biggest = full.reduce((m, r) => (Math.abs(area(r)) > Math.abs(area(m)) ? r : m));
    const centroid = ringCentroid(biggest).map(round);
    const rings = full.map((r) => downsample(r).map(([x, z]) => [round(x), round(z)]));
    return { name, code: GU_CODE[name], centroid, rings };
  });
  return { v: 1, crs: "unit-square", gus };
}

function area(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; }
  return a / 2;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
  const inp = resolve(arg("--in", resolve(here, "raw/seoul_municipalities_geo_simple.json")));
  const out = resolve(arg("--out", resolve(here, "../../frontend/src/geo/seoul-gu.json")));
  const geo = convertGeoJson(JSON.parse(readFileSync(inp, "utf8")));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(geo));
  console.log(`wrote ${out}: ${geo.gus.length} gus (unit-square)`);
}
