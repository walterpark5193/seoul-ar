// 정적 데이터 JSON 로더 (CONTRACTS 2절, 12.3). 구 데이터와 해설은 메모리에 캐시한다.
import { isNarration, type Narration } from "./narration";
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

// AI 해설(CONTRACTS 12.3). 없는 달은 CloudFront가 404 → index.html(200)로 바꿔 주므로 "JSON이 아님"도 없음으로 본다.
// 있는 해설은 무효화 전까지 기억하고, 없음은 잠깐만 기억한다(발표 중에 새로 생성된 해설이 폰에도 나타나게).
const NARRATION_MISS_TTL_MS = 60_000;
const narrationCache = new Map<string, { value: Promise<Narration | null>; expires: number }>();

async function fetchNarration(url: string): Promise<{ value: Narration | null; cacheable: boolean }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { value: null, cacheable: false }; // 네트워크 오류는 기억하지 않는다
  }
  if (!res.ok) return { value: null, cacheable: res.status === 404 || res.status === 403 };
  try {
    const body: unknown = await res.json();
    return { value: isNarration(body) ? body : null, cacheable: true };
  } catch {
    return { value: null, cacheable: true };
  }
}

export function loadNarration(month: string, base?: string): Promise<Narration | null> {
  const url = `${base ?? ""}/data/${month}/narration.json`;
  const hit = narrationCache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const entry = { value: Promise.resolve<Narration | null>(null), expires: Infinity };
  entry.value = fetchNarration(url).then(({ value, cacheable }) => {
    if (!cacheable) { if (narrationCache.get(url) === entry) narrationCache.delete(url); }
    else if (value === null) entry.expires = Date.now() + NARRATION_MISS_TTL_MS;
    return value;
  });
  narrationCache.set(url, entry);
  return entry.value;
}

/** index를 다시 읽을 때 해설 캐시를 모두 비운다. */
export function forgetNarrations(): void {
  narrationCache.clear();
}

/** 그 달 해설만 비운다(해설 생성이 끝난 뒤). */
export function forgetNarration(month: string, base?: string): void {
  narrationCache.delete(`${base ?? ""}/data/${month}/narration.json`);
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
