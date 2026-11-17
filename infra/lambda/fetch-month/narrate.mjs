// AI 한 줄 해설 (CONTRACTS 12, Task 11b 보강). 한 달 집계(구별 GuData 25개)를 Bedrock Converse 로 26개 한국어 문장으로 만든다.
// 입력은 집계 JSON 에서 고른 숫자뿐이다(행 단위 거래, 본번·부번·건물명은 원래 없다).
// 출력은 코드로 검증한다: 100자 이내 한 줄, 금지어(투자 권유·전망), 번지·지번 숫자, 키 조각.
// 첫 일괄 호출 뒤 검증에 걸린 항목만 "걸린 이유"를 알려 주며 구별로 1회 다시 만든다.
// 그래도 안 되면 데이터로 만든 틀 문장(template)으로 채운다(생략하지 않는다). 한 작업 호출 ≤ 30회.
// 파일에는 항목마다 출처 source: "model" | "template" 를 함께 쓴다.
import { GU_ORDER } from "./gu.mjs";

export const SEOUL_KEY = "서울 전체";
export const NARRATION_KEYS = Object.freeze([SEOUL_KEY, ...GU_ORDER]);
export const MAX_CHARS = 100; // 검증 상한(프롬프트는 70자 안팎, 최대 90자를 요구한다)
export const MAX_CALLS = 30;
export const FORBIDDEN_RE = /추천|매수|매도|사세요|팔세요|오를|내릴|전망|유망|투자하/;
const LOT_RE = /번지|본번|부번|\d+-\d+/; // 번지·지번(316-1) 같은 개별 필지 표기
const GEO_PREFIX_RE = /^(us|eu|apac|global|us-gov|jp|au|ca)\./;
const KEY_SET = new Set(NARRATION_KEYS);
const HANGUL_RE = /[가-힣]/;
// '"강남구": …', '서울 전체: …' 처럼 키 이름에 바로 콜론이 붙은 조각. 그 항목 자신의 키로 시작하는 것("종로구: 8월 …")은 받는다.
const KEY_FRAGMENT_RE = new RegExp(`(?:^|[\\s{,])"?(${NARRATION_KEYS.join("|")})"?\\s*:`, "g");
// Bedrock 설정 오류: 다른 항목도 같은 이유로 실패하므로 작업을 error 로 끝낸다(틀 문장으로 덮지 않는다)
const CONFIG_ERRORS = new Set(["AccessDeniedException", "ValidationException", "ResourceNotFoundException", "UnrecognizedClientException"]);

export const narrationKey = (month) => `data/${month}/narration.json`;

/** 거절 이유 → 작업 메시지용 짧은 한국어 */
export const REASON_LABELS = Object.freeze({
  length: "길이", forbidden: "금지어", lot: "번지·지번", key: "키 조각", json: "JSON 조각", hangul: "한글 없음",
  refusal: "거절 문구", multiline: "여러 줄", empty: "빈 값", type: "빈 값", missing: "응답에 없음", error: "호출 실패",
});

/**
 * 문장 하나 검증 → { ok: true, text } 또는 { ok: false, reason, detail }.
 * key 를 주면 "그 키: …" 로 시작하는 문장은 받는다(다른 키 조각은 거절).
 */
export function validateSentence(value, { key } = {}) {
  if (typeof value !== "string") return { ok: false, reason: "type", detail: {} };
  const text = value.trim();
  if (text === "") return { ok: false, reason: "empty", detail: {} };
  if (/^[{"]/.test(text)) return { ok: false, reason: "json", detail: {} };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "multiline", detail: {} };
  const length = [...text].length;
  if (length > MAX_CHARS) return { ok: false, reason: "length", detail: { length } };
  if (!HANGUL_RE.test(text)) return { ok: false, reason: "hangul", detail: {} };
  for (const m of text.matchAll(KEY_FRAGMENT_RE)) {
    if (!(key && m.index === 0 && m[1] === key)) return { ok: false, reason: "key", detail: { match: m[0].trim() } };
  }
  if (text.includes("죄송")) return { ok: false, reason: "refusal", detail: {} };
  const word = FORBIDDEN_RE.exec(text);
  if (word) return { ok: false, reason: "forbidden", detail: { word: word[0] } };
  const lot = LOT_RE.exec(text);
  if (lot) return { ok: false, reason: "lot", detail: { match: lot[0] } };
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
export function buildFacts(month, perGu, skip = new Set()) {
  const byGu = new Map(perGu.map((g) => [g.gu, g]));
  const gus = {};
  for (const gu of GU_ORDER) {
    if (skip.has(gu)) continue; // 읽지 못한 구는 사실에 넣지 않는다
    const g = byGu.get(gu);
    const total = g?.total ?? { n: 0, cancelled: 0, medPerM2: null, medAmt: null, maxAmt: null };
    gus[gu] = {
      ...statFacts(total),
      topDongs: (g?.dongs ?? []).slice(0, 3).map((d) => ({ name: d.name, n: d.n, medPerM2: d.medPerM2 })),
    };
  }
  const present = Object.keys(gus);
  const ranked = present.filter((gu) => gus[gu].medPerM2 !== null).sort((a, b) => gus[b].medPerM2 - gus[a].medPerM2);
  const pick = (list) => list.map((gu) => ({ gu, medPerM2: gus[gu].medPerM2 }));
  const seoul = {
    n: present.reduce((s, gu) => s + gus[gu].n, 0),
    cancelled: present.reduce((s, gu) => s + gus[gu].cancelled, 0),
    maxAmt: present.reduce((m, gu) => (gus[gu].maxAmt !== null && (m === null || gus[gu].maxAmt > m) ? gus[gu].maxAmt : m), null),
    highestMedPerM2: pick(ranked.slice(0, 3)),
    lowestMedPerM2: pick(ranked.slice(-3).reverse()),
  };
  return { month, units: { amount: "만원", perM2: "만원/㎡" }, seoul, gus };
}

const monthLabel = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(4))}월`;
const num = (v) => Number(v).toLocaleString("en-US");

/** 만원 정수 → "25억 5,000만원" / "3억원" / "9,800만원" (하이픈 없음) */
export function formatManwon(v) {
  const n = Math.round(Number(v));
  const eok = Math.floor(n / 10000);
  const rest = n % 10000;
  if (eok === 0) return `${num(rest)}만원`;
  return rest === 0 ? `${num(eok)}억원` : `${num(eok)}억 ${num(rest)}만원`;
}

/**
 * 데이터로 만든 틀 문장(검증을 통과하는 모양). 거래 0건이면 "…에는 매매 거래가 없었습니다".
 * 서울 전체에는 서울 전체 중앙값이 없으므로(구별 중앙값만 있다) ㎡당 중앙값이 가장 높은 구와 그 값을 쓴다.
 */
export function templateSentence(key, facts) {
  const m = Number(facts.month.slice(4));
  if (key === SEOUL_KEY) {
    const s = facts.seoul;
    if (!s || s.n === 0) return `${m}월 서울에는 매매 거래가 없었습니다.`;
    const top = s.highestMedPerM2?.[0];
    return top
      ? `${m}월 서울 매매 ${num(s.n)}건, ㎡당 중앙값이 가장 높은 구는 ${top.gu}(${num(top.medPerM2)}만원)입니다.`
      : `${m}월 서울 매매 ${num(s.n)}건입니다.`;
  }
  const g = facts.gus[key];
  if (!g || g.n === 0) {
    return g?.cancelled ? `${key} ${m}월에는 매매 거래가 없었습니다(취소 ${num(g.cancelled)}건).` : `${key} ${m}월에는 매매 거래가 없었습니다.`;
  }
  const parts = [`${key} ${m}월 매매 ${num(g.n)}건(취소 ${num(g.cancelled)}건)`];
  if (g.medPerM2 !== null) parts.push(`㎡당 중앙값 ${num(g.medPerM2)}만원`);
  if (g.maxAmt !== null) parts.push(`최고 ${formatManwon(g.maxAmt)}`);
  return `${parts.join(", ")}.`;
}

export const SYSTEM_PROMPT = [
  "너는 서울 부동산 매매 실거래 집계를 한국어 한 문장으로 요약한다. 아래를 어긴 문장은 버려진다.",
  "- 값마다 한 문장, 줄바꿈 없이. 70자 안팎을 목표로 하고 최대 90자를 넘기지 않는다.",
  "- 값은 문장만 쓴다. 값 앞에 \"종로구:\" 같은 키 이름과 콜론, 따옴표, 중괄호를 붙이지 않는다.",
  "- 주어진 JSON 의 숫자와 이름만 쓴다. 추측, 원인 분석, 비교 평가를 하지 않는다.",
  "- 투자 권유나 가격 전망을 쓰지 않는다(추천, 매수, 매도, 사세요, 팔세요, 오를, 내릴, 전망, 유망, 투자 같은 말 금지).",
  "- 건물명, 번지·지번(316-1 처럼 하이픈이 들어간 숫자), 개별 거래는 쓰지 않는다. 법정동 이름까지만 쓴다.",
  "- 금액 단위는 만원이다. \"5억 5,000만원\", \"9,800만원\", \"12억원\"처럼 쓴다(하이픈 금지). ㎡당 값은 \"㎡당 1,564만원\"처럼 쓴다.",
  "- 거래가 0건이면 \"○○구 8월에는 매매 거래가 없었습니다.\"처럼 쓴다.",
  "- 출력은 JSON 객체 하나만. 설명이나 코드 울타리 없이.",
  "좋은 예: \"종로구 8월 매매 141건(취소 8건), ㎡당 중앙값 936만원, 최고 25억 5,000만원입니다.\"",
].join("\n");

function bulkPrompt(facts, wanted) {
  const data = wanted.includes(SEOUL_KEY) ? facts : { ...facts, seoul: undefined };
  return [
    `${monthLabel(facts.month)} 서울 매매 실거래 집계(JSON):`,
    JSON.stringify(data),
    "",
    `키 목록(정확히 이 ${wanted.length}개): ${wanted.join(", ")}`,
    wanted.includes(SEOUL_KEY) ? `"서울 전체"는 seoul 값, 각 구는 gus 의 그 구 값으로 쓴다.` : "각 구는 gus 의 그 구 값으로 쓴다.",
    `형식: {${wanted.slice(0, 2).map((k) => `"${k}": "문장"`).join(", ")}${wanted.length > 2 ? ", ..." : ""}}`,
  ].join("\n");
}

/** 다시 만들 때 앞 답이 왜 버려졌는지 알려 주는 한 줄 */
export function retryHint({ reason, detail = {} }) {
  switch (reason) {
    case "length": return `앞 문장은 ${detail.length}자였습니다. 70자 안팎, 최대 90자로 줄여 주세요.`;
    case "forbidden": return `앞 문장에 쓰면 안 되는 말("${detail.word}")이 있었습니다. 투자 권유나 전망 없이 사실만 써 주세요.`;
    case "lot": return `앞 문장에 번지·지번처럼 보이는 표기("${detail.match}")가 있었습니다. 하이픈 숫자 없이, 금액은 "5억 5,000만원"처럼 써 주세요.`;
    case "key": return `앞 답에 다른 키 이름과 콜론 조각("${detail.match}")이 있었습니다. 이 키의 문장만 써 주세요.`;
    case "json": return "앞 답이 따옴표나 중괄호로 시작하는 조각이었습니다. 값에는 문장만 넣어 주세요.";
    case "multiline": return "앞 답이 여러 줄이었습니다. 한 줄 한 문장으로 써 주세요.";
    case "hangul": return "앞 답에 한국어 문장이 없었습니다. 한국어 한 문장으로 써 주세요.";
    case "refusal": return "앞 답이 거절 문구였습니다. 주어진 숫자만으로 한 문장을 써 주세요.";
    case "missing": return "앞 일괄 응답에 이 키가 없었습니다.";
    default: return "앞 답이 비어 있었습니다.";
  }
}

function singlePrompt(key, facts, rejection) {
  const data = key === SEOUL_KEY ? { month: facts.month, units: facts.units, seoul: facts.seoul } : { month: facts.month, units: facts.units, [key]: facts.gus[key] };
  return [
    `대상 키: ${key}`,
    retryHint(rejection),
    `${monthLabel(facts.month)} 집계(JSON): ${JSON.stringify(data)}`,
    `형식: {"${key}": "문장"}`,
  ].join("\n");
}

/** on-demand 호출이 안 되고 인퍼런스 프로파일이 필요하다는 응답 */
function needsInferenceProfile(e) {
  return e?.name === "ValidationException" && /inference profile/i.test(String(e?.message ?? ""));
}

/** converse 응답: 문자열(테스트) 또는 { text, stopReason }(aws.mjs). */
function toReply(out) {
  return typeof out === "string" ? { text: out, stopReason: undefined } : { text: String(out?.text ?? ""), stopReason: out?.stopReason };
}

/** { length: 3, key: 1 } → "길이 3, 키 조각 1" (많은 순) */
export function tallyText(tally) {
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${REASON_LABELS[reason] ?? reason} ${n}`)
    .join(", ");
}

/**
 * 해설을 만든다.
 * - 첫 일괄 호출의 Bedrock 설정 오류(권한·모델 ID)와 첫 호출 전 마감은 그대로 올린다(작업 error).
 *   그 밖의 일괄 호출 오류(스로틀링 등)는 다시 부르지 않고 모든 항목을 틀 문장으로 채운다.
 * - 일괄 응답에서 검증에 걸린 항목은 이유를 알려 주며 1회 다시 만들고, 그래도 안 되면 틀 문장(source "template").
 * - 재시도 중 마감·호출 상한이면 남은 항목은 틀 문장(stoppedEarly).
 * - skip: 읽지 못한 구 키(사실이 없으므로 틀 문장도 없이 뺀다). 구가 빠지면 서울 전체도 뺀다.
 * - only: 이 키들만 만든다(onlyMissing). 결과 items/source 에는 만든 키만 들어간다.
 * @returns {Promise<{ narration: {v, month, generatedAt, model, items, source}, missing: string[], calls: number,
 *   stoppedEarly: boolean, templated: string[], tally: Record<string, number>, rejections: Record<string, {reason, detail}> }>}
 */
export async function generateNarration({
  converse, modelId, month, perGu, generatedAt, maxCalls = MAX_CALLS, skip: skipKeys = [], only = null,
  onProgress = () => {}, beforeCall = () => {}, log = () => {},
}) {
  const skip = new Set(skipKeys.filter((k) => KEY_SET.has(k)));
  if ([...skip].some((k) => k !== SEOUL_KEY)) skip.add(SEOUL_KEY);
  const scope = only ? NARRATION_KEYS.filter((k) => only.includes(k)) : [...NARRATION_KEYS];
  const wanted = scope.filter((k) => !skip.has(k));
  const facts = buildFacts(month, perGu, skip);
  let model = modelId;
  let calls = 0;
  const total = NARRATION_KEYS.length;
  const items = {};
  const source = {};
  const rejections = {};

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

  const reject = (key, phase, v, raw) => {
    rejections[key] = { reason: v.reason, detail: v.detail ?? {} };
    log("warn", "해설 검증 실패", {
      key, phase, reason: v.reason, ...v.detail,
      sample: typeof raw === "string" ? raw.slice(0, 120) : undefined,
    });
  };

  let bulkFailed = false;
  if (wanted.length > 0) {
    beforeCall(); // 첫 호출 전 마감은 던진다(모은 것이 없다)
    let bulk = null;
    try {
      const reply = toReply(await call(bulkPrompt(facts, wanted), 4000));
      log("info", "일괄 해설 응답", { stopReason: reply.stopReason ?? null, keys: wanted.length });
      if (reply.stopReason === "max_tokens") log("warn", "일괄 해설 응답이 maxTokens 에서 잘림: 빠진 항목은 구별로 다시 만든다", {});
      bulk = parseJsonObject(reply.text);
      if (!bulk) log("warn", "일괄 응답을 JSON 으로 읽지 못해 구별로 다시 만든다", {});
    } catch (e) {
      if (CONFIG_ERRORS.has(e?.name) || e?.name === "JobError") throw e;
      bulkFailed = true;
      log("warn", "일괄 해설 호출 실패: 다시 부르지 않고 틀 문장으로 채운다", { error: String(e?.name ?? "Error") });
    }
    for (const key of wanted) {
      if (bulkFailed) {
        rejections[key] = { reason: "error", detail: {} };
        continue;
      }
      if (!bulk || !(key in bulk)) {
        reject(key, "bulk", { reason: "missing", detail: {} });
        continue;
      }
      const v = validateSentence(bulk[key], { key });
      if (v.ok) {
        items[key] = v.text;
        source[key] = "model";
      } else {
        reject(key, "bulk", v, bulk[key]);
      }
    }
  }
  let done = total - wanted.length + Object.keys(items).length;
  onProgress({ done, total });

  let stopped = false;
  for (const key of wanted.filter((k) => !(k in items))) {
    if (!bulkFailed && !stopped && calls < maxCalls) {
      try {
        beforeCall();
      } catch (e) {
        stopped = true;
        log("warn", "마감: 남은 해설 재시도를 멈추고 틀 문장으로 채운다", { error: String(e?.name ?? "Error") });
      }
    }
    if (!bulkFailed && !stopped && calls < maxCalls) {
      try {
        const out = toReply(await call(singlePrompt(key, facts, rejections[key]), 400));
        const obj = parseJsonObject(out.text);
        const raw = obj ? obj[key] : out.text; // JSON 이 아니면 한 줄 문장으로 본다(원문 필터는 validateSentence)
        const v = validateSentence(raw, { key });
        if (v.ok) {
          items[key] = v.text;
          source[key] = "model";
          delete rejections[key];
        } else {
          reject(key, "retry", v, raw);
        }
      } catch (e) {
        rejections[key] = { reason: "error", detail: {} };
        log("warn", "해설 재생성 호출 실패", { key, error: String(e?.name ?? "Error") });
      }
    }
    if (!(key in items)) {
      const text = templateSentence(key, facts);
      const v = validateSentence(text, { key });
      if (v.ok) {
        items[key] = v.text;
        source[key] = "template";
      } else {
        log("error", "틀 문장도 검증 실패: 생략", { key, reason: v.reason });
      }
    }
    done++;
    onProgress({ done, total, key });
  }

  const ordered = {};
  const orderedSource = {};
  for (const key of NARRATION_KEYS) {
    if (key in items) {
      ordered[key] = items[key];
      orderedSource[key] = source[key];
    }
  }
  const templated = NARRATION_KEYS.filter((k) => orderedSource[k] === "template");
  const tally = {};
  for (const k of templated) {
    const reason = rejections[k]?.reason ?? "error";
    tally[reason] = (tally[reason] ?? 0) + 1;
  }
  log("info", "해설 결과", {
    month, model: NARRATION_KEYS.filter((k) => orderedSource[k] === "model").length, template: templated.length,
    omitted: scope.filter((k) => !(k in ordered)).length, tally, calls,
  });
  return {
    narration: { v: 1, month, generatedAt, model, items: ordered, source: orderedSource },
    missing: scope.filter((k) => !(k in ordered)),
    calls,
    stoppedEarly: stopped,
    templated,
    tally,
    rejections,
  };
}
