// AI 한 줄 해설 (CONTRACTS 12.1): data/{month}/narration.json. 없거나 깨졌으면 화면은 영역을 숨긴다.

export const NARRATION_ALL = "서울 전체";

export interface Narration {
  v: 1;
  month: string;
  generatedAt: string;
  model: string;
  /** 키: "서울 전체"와 구 이름. 생성에 실패한 항목은 키가 없다. */
  items: Record<string, string>;
}

export function isNarration(x: unknown): x is Narration {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const n = x as Record<string, unknown>;
  if (n.v !== 1 || typeof n.month !== "string" || !/^\d{6}$/.test(n.month)) return false;
  if (typeof n.generatedAt !== "string" || typeof n.model !== "string") return false;
  if (typeof n.items !== "object" || n.items === null || Array.isArray(n.items)) return false;
  return Object.values(n.items as Record<string, unknown>).every((v) => typeof v === "string");
}

/** 고른 구(null이면 서울 전체)의 문장. 다른 달의 해설이거나 비어 있으면 null. */
export function narrationText(n: Narration | null | undefined, month: string, gu: string | null): string | null {
  if (!n || n.month !== month) return null;
  const text = n.items[gu ?? NARRATION_ALL];
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

/** "us.anthropic.claude-haiku-4-5-20251001-v1:0" → "claude-haiku-4-5-20251001" */
export function modelLabel(model: string): string {
  const s = model
    .replace(/^(us|eu|apac|global)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .trim();
  return s || "모델 정보 없음";
}
