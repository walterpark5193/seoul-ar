// 정적 데이터 JSON 로더 (CONTRACTS 2절). 구 데이터는 메모리에 캐시한다.
import type { DataIndex, GuData } from "./types";

const guCache = new Map<string, Promise<GuData>>();

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadIndex(base?: string): Promise<DataIndex> {
  return getJson<DataIndex>(`${base ?? ""}/data/index.json`);
}

/** HTTP 캐시를 건너뛰고 다시 읽는다(새 달을 가져온 뒤, 또는 원격 상태가 모르는 달을 가리킬 때). */
export async function reloadIndex(base?: string): Promise<DataIndex> {
  return getJson<DataIndex>(`${base ?? ""}/data/index.json`, { cache: "no-store" });
}

/** 그 달의 구 데이터 메모리 캐시를 비운다(같은 달을 다시 가져온 뒤). */
export function forgetMonth(month: string, base?: string): void {
  const prefix = `${base ?? ""}/data/${month}/`;
  for (const key of [...guCache.keys()]) if (key.startsWith(prefix)) guCache.delete(key);
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
