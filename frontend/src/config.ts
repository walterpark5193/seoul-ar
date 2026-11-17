// 배포 설정 읽기 (CONTRACTS 7절). 실패하면 events 없는 기본값 → 모의 실시간.

export interface EventsConfig { httpEndpoint: string; realtimeEndpoint: string; region: string; apiKey: string; }
export interface AppConfig { v: 1; appUrl: string | null; events: EventsConfig | null; }

const fallback = (): AppConfig => ({ v: 1, appUrl: null, events: null });

const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;

function isEvents(x: unknown): x is EventsConfig {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return isStr(e.httpEndpoint) && isStr(e.realtimeEndpoint) && isStr(e.region) && isStr(e.apiKey);
}

function parse(x: unknown): AppConfig | null {
  if (typeof x !== "object" || x === null) return null;
  const c = x as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (c.appUrl !== null && !isStr(c.appUrl)) return null;
  if (c.events === null) return { v: 1, appUrl: c.appUrl, events: null };
  if (!isEvents(c.events)) return null;
  const { httpEndpoint, realtimeEndpoint, region, apiKey } = c.events;
  return { v: 1, appUrl: c.appUrl, events: { httpEndpoint, realtimeEndpoint, region, apiKey } };
}

export async function loadConfig(fetchImpl: typeof fetch = globalThis.fetch): Promise<AppConfig> {
  try {
    const res = await fetchImpl("/config.json", { cache: "no-store" });
    if (!res.ok) return fallback();
    return parse(await res.json()) ?? fallback();
  } catch {
    return fallback();
  }
}
