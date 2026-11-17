// 정적 데이터 JSON 로더 (CONTRACTS 2절). 구 데이터는 메모리에 캐시한다.
import type { DataIndex, GuData } from "./types";

const guCache = new Map<string, Promise<GuData>>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadIndex(base?: string): Promise<DataIndex> {
  return getJson<DataIndex>(`${base ?? ""}/data/index.json`);
}

export async function loadGu(month: string, gu: string, base?: string): Promise<GuData> {
  const url = `${base ?? ""}/data/${month}/${encodeURIComponent(gu)}.json`;
  let hit = guCache.get(url);
  if (!hit) {
    hit = getJson<GuData>(url);
    guCache.set(url, hit);
    hit.catch(() => guCache.delete(url));
  }
  return hit;
}
