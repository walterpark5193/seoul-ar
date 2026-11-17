import type { Geo, GuShape } from "./types";
import layout from "./tile-layout.json";

const round = (n: number): number => Math.round(n * 1e7) / 1e7 + 0; // +0: -0 방지

/** 25구를 5x5 정사각 타일로 배치한 폴백 지오. 좌표는 [x, z], 북쪽이 -z. */
export function tileGeo(): Geo {
  const { tile, gap, cols, rows } = layout;
  const pitch = tile + gap;
  const x0 = -((cols - 1) * pitch + tile) / 2;
  const z0 = -((rows - 1) * pitch + tile) / 2;
  const gus: GuShape[] = layout.gus.map((g) => {
    const minX = x0 + g.col * pitch;
    const minZ = z0 + g.row * pitch;
    const maxX = minX + tile;
    const maxZ = minZ + tile;
    const ring: [number, number][] = [
      [round(minX), round(minZ)],
      [round(maxX), round(minZ)],
      [round(maxX), round(maxZ)],
      [round(minX), round(maxZ)],
    ];
    return {
      name: g.name,
      code: g.code,
      centroid: [round((minX + maxX) / 2), round((minZ + maxZ) / 2)],
      rings: [ring],
    };
  });
  return { v: 1, crs: "tile", gus };
}
