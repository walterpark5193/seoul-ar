// 실기 조정용: #/ar?cf=…&beta=… 해시 쿼리를 ArSession 옵션으로 바꾼다(순수 함수, 테스트 대상).
// 다시 배포하지 않고 폰에서 흔들림 정도를 맞춰 보기 위한 것. 유한한 양수만 받고 나머지는 버린다.
import type { ArSessionOptions, ArSmoothing } from "../ar/session";

export type ArTuning = Pick<Partial<ArSessionOptions>, "filterMinCF" | "filterBeta" | "warmupTolerance" | "missTolerance" | "smoothing">;

/** 쿼리 이름 → 최상위 옵션. 표시 순서도 이 순서. */
const TOP = [
  ["cf", "filterMinCF"],
  ["beta", "filterBeta"],
  ["warm", "warmupTolerance"],
  ["miss", "missTolerance"],
] as const satisfies ReadonlyArray<readonly [string, keyof ArTuning]>;

/** 쿼리 이름 → smoothing 안의 옵션. */
const SMOOTH = [
  ["alpha", "positionAlpha"],
  ["ralpha", "rotationAlpha"],
  ["dead", "deadbandPos"],
  ["rdead", "deadbandRotRad"],
  ["hold", "holdMs"],
] as const satisfies ReadonlyArray<readonly [string, keyof ArSmoothing]>;

// 10진수 표기만(1, 0.5, .5, 1e-4). "0x10", "Infinity", "1x" 같은 것은 받지 않는다.
const DECIMAL = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

function positive(raw: string | null): number | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (!DECIMAL.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** query: "cf=…&…", "?cf=…", 또는 "#/ar?cf=…" 모두 받는다. */
export function parseArTuning(query: string): ArTuning {
  const q = query.includes("?") ? query.slice(query.indexOf("?") + 1) : query;
  const params = new URLSearchParams(q);
  const out: ArTuning = {};
  for (const [key, option] of TOP) {
    const v = positive(params.get(key));
    if (v !== null) out[option] = v;
  }
  const smoothing: ArSmoothing = {};
  for (const [key, option] of SMOOTH) {
    const v = positive(params.get(key));
    if (v !== null) smoothing[option] = v;
  }
  if (Object.keys(smoothing).length > 0) out.smoothing = smoothing;
  return out;
}

/** 적용 중인 값을 쿼리 이름으로 한 줄에. 적용된 것이 없으면 null(줄을 숨긴다). */
export function describeArTuning(t: ArTuning): string | null {
  const parts: string[] = [];
  for (const [key, option] of TOP) {
    const v = t[option];
    if (typeof v === "number") parts.push(`${key}=${v}`);
  }
  for (const [key, option] of SMOOTH) {
    const v = t.smoothing?.[option];
    if (typeof v === "number") parts.push(`${key}=${v}`);
  }
  return parts.length ? `조정값 적용 중: ${parts.join(", ")}` : null;
}
