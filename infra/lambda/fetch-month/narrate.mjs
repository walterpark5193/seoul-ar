// AI 한 줄 해설 (CONTRACTS 12). 한 달 집계(구별 GuData 25개)를 Bedrock Converse 로 26개 한국어 문장으로 만든다.
// 입력은 집계 JSON 에서 고른 숫자뿐이다(행 단위 거래, 본번·부번·건물명은 원래 없다).
// 출력은 코드로 검증한다: 80자 이내 한 줄, 금지어(투자 권유·전망), 번지·지번 숫자, 키 유효성.
// 첫 일괄 호출 뒤 누락·검증 실패 항목만 구별로 1회 재시도하고, 그래도 안 되면 생략한다. 한 작업 호출 ≤ 30회.
import { GU_ORDER } from "./gu.mjs";

export const SEOUL_KEY = "서울 전체";
export const NARRATION_KEYS = Object.freeze([SEOUL_KEY, ...GU_ORDER]);
export const MAX_CHARS = 80;
export const MAX_CALLS = 30;
export const FORBIDDEN_RE = /추천|매수|매도|사세요|팔세요|오를|내릴|전망|유망|투자하/;
const LOT_RE = /번지|본번|부번|\d+-\d+/; // 번지·지번(316-1) 같은 개별 필지 표기
const GEO_PREFIX_RE = /^(us|eu|apac|global|us-gov|jp|au|ca)\./;
const KEY_SET = new Set(NARRATION_KEYS);

export const narrationKey = (month) => `data/${month}/narration.json`;

/** 문장 하나 검증. 앞뒤 공백·따옴표를 걷어 낸 text 를 돌려준다. */
export function validateSentence(value) {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  const text = value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "multiline" };
  if ([...text].length > MAX_CHARS) return { ok: false, reason: "length" };
  if (FORBIDDEN_RE.test(text)) return { ok: false, reason: "forbidden" };
  if (LOT_RE.test(text)) return { ok: false, reason: "lot" };
  return { ok: true, text };
}

/** 응답 문자열에서 JSON 객체 하나를 꺼낸다(```json 울타리나 앞뒤 설명 허용). 실패하면 null. */
export function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

const statFacts = (t) => ({ n: t.n, cancelled: t.cancelled, medPerM2: t.medPerM2, medAmt: t.medAmt, maxAmt: t.maxAmt });

/** 모델에 넘길 사실 묶음: 서울 합계와 구별 total, ㎡당 중앙값 상위 법정동 3개. 금액은 만원, ㎡당은 만원/㎡. */
export function buildFacts(month, perGu) {
  const byGu = new Map(perGu.map((g) => [g.gu, g]));
  const gus = {};
  for (const gu of GU_ORDER) {
    const g = byGu.get(gu);
    const total = g?.total ?? { n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null };
    gus[gu] = {
      ...statFacts(total),
      topDongs: (g?.dongs ?? []).slice(0, 3).map((d) => ({ name: d.name, n: d.n, medPerM2: d.medPerM2 })),
    };
  }
  const ranked = GU_ORDER.filter((gu) => gus[gu].medPerM2 !== null).sort((a, b) => gus[b].medPerM2 - gus[a].medPerM2);
  const pick = (list) => list.map((gu) => ({ gu, medPerM2: gus[gu].medPerM2 }));
  const seoul = {
    n: GU_ORDER.reduce((s, gu) => s + gus[gu].n, 0),
    cancelled: GU_ORDER.reduce((s, gu) => s + gus[gu].cancelled, 0),
    maxAmt: GU_ORDER.reduce((m, gu) => (gus[gu].maxAmt !== null && (m === null || gus[gu].maxAmt > m) ? gus[gu].maxAmt : m), null),
    highestMedPerM2: pick(ranked.slice(0, 3)),
    lowestMedPerM2: pick(ranked.slice(-3).reverse()),
  };
  return { month, units: { amount: "만원", perM2: "만원/㎡" }, seoul, gus };
}

const monthLabel = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(4))}월`;

export const SYSTEM_PROMPT = [
  "너는 서울 부동산 매매 실거래 집계를 한국어 한 문장으로 요약한다.",
  "규칙:",
  `- 각 문장은 ${MAX_CHARS}자 이내의 한 문장. 줄바꿈 없이.`,
  "- 주어진 JSON 의 숫자와 이름만 쓴다. 추측, 원인 분석, 비교 평가를 하지 않는다.",
  "- 투자 권유나 가격 전망을 쓰지 않는다(추천, 매수, 매도, 사세요, 팔세요, 오를, 내릴, 전망, 유망, 투자 같은 말 금지).",
  "- 건물명, 번지, 개별 거래는 쓰지 않는다. 법정동 이름까지만 쓴다.",
  "- 금액 단위는 만원이다. 1억 이상은 '12억 3천만원'처럼 읽기 쉽게 쓴다. ㎡당 값은 '㎡당 1,564만원'처럼 쓴다.",
  "- 거래가 0건이면 '거래가 없었습니다' 같은 한 문장으로 쓴다.",
  "- 출력은 JSON 객체 하나만. 설명이나 코드 울타리 없이.",
].join("\n");

function bulkPrompt(facts) {
  return [
    `${monthLabel(facts.month)} 서울 매매 실거래 집계(JSON):`,
    JSON.stringify(facts),
    "",
    `키 목록(정확히 이 ${NARRATION_KEYS.length}개): ${NARRATION_KEYS.join(", ")}`,
    `"서울 전체"는 seoul 값, 각 구는 gus 의 그 구 값으로 쓴다.`,
    '형식: {"서울 전체": "문장", "종로구": "문장", ...}',
  ].join("\n");
}

function singlePrompt(key, facts) {
  const data = key === SEOUL_KEY ? { month: facts.month, units: facts.units, seoul: facts.seoul } : { month: facts.month, units: facts.units, [key]: facts.gus[key] };
  return [
    `대상 키: ${key}`,
    `${monthLabel(facts.month)} 집계(JSON): ${JSON.stringify(data)}`,
    `형식: {"${key}": "문장"}`,
  ].join("\n");
}

/** on-demand 호출이 안 되고 인퍼런스 프로파일이 필요하다는 응답 */
function needsInferenceProfile(e) {
  return e?.name === "ValidationException" && /inference profile/i.test(String(e?.message ?? ""));
}

/**
 * 26개 해설을 만든다. 첫 일괄 호출의 예외(권한 없음 등)는 그대로 올린다(재시도 26번을 하지 않는다).
 * @param {object} o
 * @param {(args: {modelId, system, prompt, maxTokens}) => Promise<string>} o.converse
 * @param {(p: {done: number, total: number, key?: string}) => void} [o.onProgress]
 * @param {() => void} [o.beforeCall] 호출마다 먼저 부른다(작업자 마감 검사)
 * @returns {Promise<{narration: {v, month, generatedAt, model, items}, missing: string[], calls: number}>}
 */
export async function generateNarration({ converse, modelId, month, perGu, generatedAt, maxCalls = MAX_CALLS, onProgress = () => {}, beforeCall = () => {}, log = () => {} }) {
  const facts = buildFacts(month, perGu);
  let model = modelId;
  let calls = 0;
  const total = NARRATION_KEYS.length;

  // 첫 시도 전 beforeCall 은 호출하는 쪽이 try 밖에서 부른다(마감 오류를 항목 실패로 삼키지 않게).
  async function call(prompt, maxTokens) {
    calls++;
    try {
      return await converse({ modelId: model, system: SYSTEM_PROMPT, prompt, maxTokens });
    } catch (e) {
      if (!needsInferenceProfile(e) || GEO_PREFIX_RE.test(model) || calls >= maxCalls) throw e;
      model = `us.${model}`;
      log("warn", "on-demand 호출 불가: us. 인퍼런스 프로파일로 바꿔 다시 부른다", { model });
      beforeCall();
      calls++;
      return await converse({ modelId: model, system: SYSTEM_PROMPT, prompt, maxTokens });
    }
  }

  const items = {};
  beforeCall();
  const bulk = parseJsonObject(await call(bulkPrompt(facts), 4000));
  if (!bulk) log("warn", "일괄 응답을 JSON 으로 읽지 못해 구별로 다시 만든다", {});
  for (const key of NARRATION_KEYS) {
    const v = validateSentence(bulk?.[key]);
    if (v.ok) items[key] = v.text;
    else if (bulk && key in bulk) log("warn", "해설 검증 실패", { key, reason: v.reason });
  }
  let done = Object.keys(items).length;
  onProgress({ done, total });

  for (const key of NARRATION_KEYS.filter((k) => !(k in items))) {
    if (calls < maxCalls) {
      beforeCall();
      try {
        const out = await call(singlePrompt(key, facts), 400);
        const obj = parseJsonObject(out);
        const v = validateSentence(obj ? obj[key] : out); // JSON 이 아니면 한 줄 문장으로 본다
        if (v.ok) items[key] = v.text;
        else log("warn", "해설 재생성도 검증 실패: 생략", { key, reason: v.reason });
      } catch (e) {
        log("warn", "해설 재생성 호출 실패: 생략", { key, error: String(e?.name ?? "Error") });
      }
    }
    done++;
    onProgress({ done, total, key });
  }

  const ordered = {};
  for (const key of NARRATION_KEYS) if (key in items && KEY_SET.has(key)) ordered[key] = items[key];
  return {
    narration: { v: 1, month, generatedAt, model, items: ordered },
    missing: NARRATION_KEYS.filter((k) => !(k in ordered)),
    calls,
  };
}
