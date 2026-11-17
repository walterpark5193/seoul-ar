// 타일 폴백을 frontend/src/geo/seoul-gu.json 으로 쓴다. 배치표는 tile-layout.json 공유.
// 원본 GeoJSON(tools/geo/raw/...)이 있으면 convert.mjs 결과를 쓰고 타일은 쓰지 않는다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertWithReport } from "./convert.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const layoutPath = resolve(here, "../../frontend/src/geo/tile-layout.json");
const rawPath = resolve(here, "raw/seoul_municipalities_geo_simple.json");
const outPath = resolve(here, "../../frontend/src/geo/seoul-gu.json");
const round = (n) => Math.round(n * 1e7) / 1e7 + 0; // +0: -0 방지

// tiles.ts의 tileGeo()와 같은 계산 (테스트가 일치를 확인한다).
export function buildTileGeo(layout) {
  const { tile, gap, cols, rows } = layout;
  const pitch = tile + gap;
  const x0 = -((cols - 1) * pitch + tile) / 2;
  const z0 = -((rows - 1) * pitch + tile) / 2;
  const gus = layout.gus.map((g) => {
    const minX = x0 + g.col * pitch, minZ = z0 + g.row * pitch;
    const maxX = minX + tile, maxZ = minZ + tile;
    return {
      name: g.name, code: g.code,
      centroid: [round((minX + maxX) / 2), round((minZ + maxZ) / 2)],
      rings: [[[round(minX), round(minZ)], [round(maxX), round(minZ)], [round(maxX), round(maxZ)], [round(minX), round(maxZ)]]],
    };
  });
  return { v: 1, crs: "tile", gus };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let geo = null;
  if (existsSync(rawPath)) {
    const r = convertWithReport(JSON.parse(readFileSync(rawPath, "utf8")));
    if (r.geo.gus.length === 25) geo = r.geo;
    else console.warn(`경고: 원본 GeoJSON이 ${r.geo.gus.length}/25구만 일치, 타일 폴백 유지.\n누락: ${r.missing.join(", ")}\n미일치 feature: ${r.unmatched.join(", ") || "(없음)"}`);
  }
  geo ??= buildTileGeo(JSON.parse(readFileSync(layoutPath, "utf8")));
  writeFileSync(outPath, JSON.stringify(geo));
  console.log(`wrote ${outPath}: ${geo.gus.length} gus (${geo.crs})`);
}
