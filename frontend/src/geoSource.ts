// 씬에 넘길 자치구 기하: geo/seoul-gu.json이 있으면 그것, 없거나 깨졌으면 tileGeo() (CONTRACTS 3절).
import type { Geo } from "./geo/types";
import { tileGeo } from "./geo/tiles";

// glob은 파일이 없어도 빌드가 깨지지 않는다(빈 객체).
const found = import.meta.glob<unknown>("./geo/seoul-gu.json", { eager: true, import: "default" });

function isGeo(x: unknown): x is Geo {
  const g = x as Partial<Geo> | null;
  return !!g && g.v === 1 && Array.isArray(g.gus) && g.gus.length > 0;
}

export function loadGeo(): Geo {
  const g = Object.values(found)[0];
  return isGeo(g) ? g : tileGeo();
}

/** 서쪽에서 동쪽으로 구 이름(랜딩 스카이라인 순서). */
export function westToEast(geo: Geo): string[] {
  return [...geo.gus].sort((a, b) => a.centroid[0] - b.centroid[0]).map((g) => g.name);
}
