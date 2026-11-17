// 구 해설 문장 쓰기: Bedrock Converse가 사실표로 caption만 쓰고, speech는 caption에서 유도한다.
// validateScript가 숫자·최상급의 뜻까지 사실표와 맞춰 보고, 실패하면 재시도, 그래도 안 되면 템플릿 문장으로 대체한다.
// CLI는 기존 scripts.json과 병합한다: source "edited"(사람이 고친 문장)는 --force 없이는 덮지 않고, --only로 일부 구만 다시 쓴다.
import { pathToFileURL } from "node:url";
import { TOP_DONG_MIN_N } from "./facts.mjs";
import { GU_ORDER } from "../data/gu.mjs";

export const MODEL_ID = "global.anthropic.claude-sonnet-5-5";
export const MAX_CAPTION = 90;
export const MAX_SPEECH = 200;
export const CONCURRENCY = 4;

const BANNED = [
  "번지", "지번", "본번", "부번", "동 호", "단지명",
  "폭등", "폭락", "대박", "꼭 사야", "무조건", "투자", "매수", "매도", "추천", "급등", "급락",
];

const gu_id = (f) => `gu-${f.month}-${f.gu}`;
const comma = (v) => Math.round(v).toLocaleString("en-US");
const eok = (v) => (v / 10000).toFixed(1);
// 최고 동은 "거래 N건 이상인 동 가운데"라는 단서와 함께일 때만 말할 수 있다(facts.topDongBasis 참고).
const dongSpeakable = (f) => Boolean(f.topDong) && f.topDongBasis === "min3";
const ym = (month) => ({ y: String(month).slice(0, 4), m: String(Number(String(month).slice(4, 6))) });

export function buildPrompt(facts) {
  const { y, m } = ym(facts.month);
  const lines = [
    `구: ${facts.gu}`,
    `기간: ${y}년 ${m}월`,
    `거래 건수: ${facts.n}건`,
    `취소 건수: ${facts.cancelled}건`,
  ];
  if (facts.n > 0) {
    if (facts.medPerM2 != null) lines.push(`㎡당 중위 가격: ${comma(facts.medPerM2)}만 원`);
    if (facts.rankPrice != null) lines.push(`㎡당 가격 순위: ${facts.totalGus}개 구 중 ${facts.rankPrice}위`);
    if (facts.maxAmt != null) lines.push(`최고 거래가: ${eok(facts.maxAmt)}억 원`);
    if (dongSpeakable(facts)) {
      lines.push(`거래 ${TOP_DONG_MIN_N}건 이상인 동 가운데 ㎡당 중위 가격이 가장 높은 동: ${facts.topDong}` +
        (facts.topDongMedPerM2 != null ? ` (㎡당 중위 ${comma(facts.topDongMedPerM2)}만 원)` : ""));
    }
  } else {
    lines.push("이번 달 거래 없음");
  }
  return [
    "당신은 서울 부동산 실거래 데이터를 발표 화면에서 설명하는 해설자입니다.",
    "아래 사실표만 근거로 해당 구의 해설 문장을 한국어로 씁니다.",
    "",
    "[사실표]",
    ...lines,
    "",
    "[규칙]",
    "- 존댓말로 정확히 두 문장을 씁니다.",
    `- caption은 자막 한 개만 씁니다. 자막용이며 공백 포함 ${MAX_CAPTION}자 이내입니다. 숫자는 아라비아 숫자로 쓰고 금액은 "2,890만 원", "52.6억 원"처럼 씁니다.`,
    "- 사실표에 있는 숫자만 사용합니다. 계산해서 새 숫자를 만들거나 다른 달·다른 구와 비교하는 숫자를 쓰지 않습니다.",
    "- 아파트 이름(단지명), 건물명, 지번, 본번, 부번은 쓰지 않습니다.",
    `- 순위는 사실표의 순위만 씁니다. 구를 "가장 비싸다·높다"고 하는 것은 1위일 때만, "가장 낮다·싸다"는 ${facts.totalGus}위일 때만 씁니다. 거래 건수로 "가장 많다·적다"고 쓰지 않습니다.`,
    dongSpeakable(facts)
      ? `- 동을 말할 때는 "거래 ${TOP_DONG_MIN_N}건 이상인 동 가운데"라는 단서를 반드시 붙입니다. 거래가 적은 동 중에 더 비싼 곳이 있을 수 있으므로 이 단서 없이 어떤 동이 "가장 높다"고 쓰지 않습니다.`
      : "- 동 이름은 쓰지 않습니다. 이번 달에는 대표로 말할 만큼 거래가 많은 동이 없습니다.",
    '- 투자 권유와 과장("폭등", "대박", "꼭 사야" 등)은 쓰지 않습니다.',
    '- 거래가 없으면 "이번 달 거래가 없었습니다"는 취지로만 씁니다.',
    "",
    '출력은 JSON 한 개만 씁니다. 형식: {"caption": "..."}  다른 설명은 붙이지 않습니다.',
  ].join("\n");
}

export function extractText(resp) {
  const blocks = resp?.output?.message?.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b && typeof b.text === "string") return b.text;
  }
  return null;
}

export function speechFromCaption(caption) {
  return String(caption).replaceAll("㎡", "제곱미터");
}

export function parseScript(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    if (o && typeof o.caption === "string") {
      const caption = o.caption.trim();
      return { caption, speech: speechFromCaption(caption) };
    }
  } catch { /* 형식 오류 */ }
  return null;
}

export function allowedNumbers(facts) {
  const set = new Set();
  const addInt = (v) => {
    if (v == null || !Number.isFinite(v)) return;
    set.add(String(Math.round(v)));
    set.add(comma(v));
  };
  addInt(facts.n);
  addInt(facts.cancelled);
  addInt(facts.rankPrice);
  addInt(facts.totalGus);
  addInt(facts.medPerM2);
  if (dongSpeakable(facts)) {
    addInt(facts.topDongMedPerM2);
    set.add(String(TOP_DONG_MIN_N));
  }
  if (facts.maxAmt != null && Number.isFinite(facts.maxAmt)) {
    set.add(eok(facts.maxAmt));
    set.add(String(facts.maxAmt));
    set.add(comma(facts.maxAmt));
  }
  const { y, m } = ym(facts.month);
  set.add(y);
  set.add(m);
  set.add(String(facts.month));
  return set;
}

// ---- 의미 검사(설계 5.6, 최종 리뷰 C-I3) ----
// 숫자는 "허용 집합에 있다"만으로는 부족하다(중구 취소 1건 → "1위" 통과 같은 구멍). 단위·문맥별로 맞는 사실과만 비교한다.
const SUPERLATIVE = /(가장|제일)\s*(비싸|비싼|비쌉|비쌌|높|낮|싸|싼|쌉|쌌|저렴|많|적)/g;
const HIGH = /^(비싸|비싼|비쌉|비쌌|높)/;
const COUNT_SUP = /^(많|적)/;
const PARTICLE_AFTER_DONG = "(?=[이가은는을를의에도와과로으만]|[^가-힣]|$)";
const DONG_TOKEN = new RegExp(`[가-힣]+동(?:\\d+가)?${PARTICLE_AFTER_DONG}`, "g");
const GU_NAMES = [...GU_ORDER].sort((a, b) => b.length - a.length);
const num = (t) => Number(String(t).replaceAll(",", ""));

// 문장 단위로 나눈다. 숫자 사이 점(27.5)은 문장 끝이 아니다.
function sentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[.!?]/.test(text[i]) && !/\d/.test(text[i + 1] ?? "")) { out.push({ start, text: text.slice(start, i + 1) }); start = i + 1; }
  }
  if (start < text.length) out.push({ start, text: text.slice(start) });
  return out;
}

// 문장 속 이름(구·동)의 위치. 구 이름을 가린 뒤 "…동", "…동N가"를 동으로 본다.
function entities(sentence) {
  const list = [];
  let masked = sentence;
  for (const gu of GU_NAMES) {
    let at = masked.indexOf(gu);
    while (at >= 0) {
      list.push({ kind: "gu", name: gu, at });
      masked = masked.slice(0, at) + "#".repeat(gu.length) + masked.slice(at + gu.length);
      at = masked.indexOf(gu, at + gu.length);
    }
  }
  for (const m of masked.matchAll(DONG_TOKEN)) list.push({ kind: "dong", name: m[0], at: m.index });
  return list.sort((a, b) => a.at - b.at);
}
// pos 앞에서 가장 가까운 이름(없으면 구 자신으로 본다).
const subjectAt = (ents, pos) => ents.filter((e) => e.at < pos).at(-1) ?? { kind: "gu", name: null };

function semanticErrors(facts, caption) {
  const errors = [];
  const speakable = dongSpeakable(facts);
  const clue = new RegExp(`${TOP_DONG_MIN_N}건\\s*이상`);
  const dongOk = (name) => speakable && name === facts.topDong;
  for (const sen of sentences(caption)) {
    const t = sen.text;
    const ents = entities(t);
    for (const m of t.matchAll(/(?<![\d.,])(\d+)\s*위/g)) {
      if (facts.rankPrice == null || num(m[1]) !== facts.rankPrice) errors.push(`순위가 사실과 다름: ${m[1]}위(실제 ${facts.rankPrice ?? "없음"})`);
    }
    for (const m of t.matchAll(/(?<![\d.,])(\d+)\s*개\s*구/g)) {
      if (num(m[1]) !== facts.totalGus) errors.push(`구 개수가 사실과 다름: ${m[1]}개 구`);
    }
    for (const m of t.matchAll(/(?<![\d.,])(\d[\d,]*(?:\.\d+)?)\s*억/g)) {
      if (facts.maxAmt == null || num(m[1]) !== Number(eok(facts.maxAmt))) errors.push(`억 금액이 최고 거래가와 다름: ${m[1]}억(실제 ${facts.maxAmt == null ? "없음" : eok(facts.maxAmt)}억)`);
    }
    let from = 0;
    for (const m of t.matchAll(/(?<![\d.,])(\d[\d,]*)\s*건(\s*이상)?/g)) {
      const v = num(m[1]);
      const before = t.slice(Math.max(from, t.lastIndexOf(",", m.index) + 1), m.index);
      from = m.index + m[0].length;
      if (m[2] && speakable && v === TOP_DONG_MIN_N) continue; // "3건 이상 거래된 동" 단서
      if (before.includes("취소")) { if (v !== facts.cancelled) errors.push(`취소 건수가 사실과 다름: ${m[1]}건`); }
      else if (v !== facts.n) errors.push(`거래 건수가 사실과 다름: ${m[1]}건`);
    }
    for (const m of t.matchAll(/(?<![\d.,])(\d[\d,]*)\s*만\s*원/g)) {
      const v = num(m[1]);
      const who = subjectAt(ents, m.index);
      if (who.kind === "dong") {
        if (!dongOk(who.name)) errors.push(`사실표에 없는 동의 금액: ${who.name}`);
        else if (v !== Math.round(facts.topDongMedPerM2)) errors.push(`${who.name}의 금액이 사실과 다름: ${m[1]}만 원`);
      } else if (v !== Math.round(facts.medPerM2 ?? NaN) && v !== Math.round(facts.maxAmt ?? NaN)) {
        errors.push(`구 금액이 사실과 다름: ${m[1]}만 원`);
      }
    }
    for (const m of t.matchAll(SUPERLATIVE)) {
      const word = m[2];
      const who = subjectAt(ents, m.index);
      if (COUNT_SUP.test(word)) { errors.push(`사실표에 없는 건수 비교: ${m[0]}`); continue; }
      if (who.kind === "dong") {
        if (!HIGH.test(word)) errors.push(`사실표에 없는 동 비교: ${who.name} ${m[0]}`);
        else if (!dongOk(who.name)) errors.push(`사실표에 없는 동의 최상급: ${who.name}`);
        else if (!clue.test(t) && facts.topDongIsMax !== true) errors.push(`동 최상급에 "${TOP_DONG_MIN_N}건 이상" 단서 필요: ${who.name}(거래가 적은 동 중에 더 비싼 곳이 있음)`);
      } else if (HIGH.test(word) ? facts.rankPrice !== 1 : facts.rankPrice !== facts.totalGus) {
        errors.push(`구 최상급이 순위와 다름: ${m[0]}(실제 ${facts.rankPrice ?? "없음"}위)`);
      }
    }
  }
  return errors;
}

export function validateScript(facts, script) {
  const errors = [];
  if (!script || typeof script.caption !== "string") {
    return { ok: false, errors: ["caption이 문자열이어야 합니다"] };
  }
  const caption = script.caption;
  const speech = typeof script.speech === "string" ? script.speech : speechFromCaption(caption);
  if (!caption.trim()) errors.push("caption이 비었습니다");
  if (!speech.trim()) errors.push("speech가 비었습니다");
  if ([...caption].length > MAX_CAPTION) errors.push(`caption이 ${MAX_CAPTION}자를 넘습니다(${[...caption].length}자)`);
  if ([...speech].length > MAX_SPEECH) errors.push(`speech가 ${MAX_SPEECH}자를 넘습니다`);
  for (const w of BANNED) {
    if (caption.includes(w) || speech.includes(w)) errors.push(`금지어: ${w}`);
  }
  if (facts.topDong && !dongSpeakable(facts) && (caption.includes(facts.topDong) || speech.includes(facts.topDong))) {
    errors.push(`거래가 적어 대표로 말할 수 없는 동 이름: ${facts.topDong}`);
  }
  const allowed = allowedNumbers(facts);
  let scan = caption;
  for (const name of [facts.gu, facts.topDong]) if (name) scan = scan.replaceAll(name, " ");
  const tokens = scan.match(/\d[\d,]*(\.\d+)?/g) ?? [];
  for (let t of tokens) {
    t = t.replace(/,+$/, "");
    if (!allowed.has(t)) errors.push(`사실표에 없는 숫자: ${t}`);
  }
  if (facts.n === 0 && !/거래가 없었/.test(caption)) errors.push("거래가 없는 구인데 없었다는 취지가 아닙니다");
  errors.push(...semanticErrors(facts, caption));
  return { ok: errors.length === 0, errors };
}

export function fallbackScript(facts) {
  const { y, m } = ym(facts.month);
  if (!facts.n) {
    const t = `${facts.gu}는 이번 달 거래가 없었습니다. 다른 구를 살펴보겠습니다.`;
    return { caption: t, speech: speechFromCaption(t) };
  }
  const s1 = `${facts.gu}는 ${y}년 ${m}월 거래가 ${facts.n}건이었습니다.`;
  let s2;
  if (facts.medPerM2 != null) {
    s2 = `㎡당 중위 가격은 ${comma(facts.medPerM2)}만 원` +
      (facts.rankPrice != null ? `으로 ${facts.totalGus}개 구 중 ${facts.rankPrice}위입니다.` : "입니다.");
  } else {
    s2 = "㎡당 가격은 집계하지 못했습니다.";
  }
  const caption = `${s1} ${s2}`;
  return { caption, speech: speechFromCaption(caption) };
}

async function askOnce(client, modelId, prompt) {
  const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const resp = await client.send(new ConverseCommand({
    modelId,
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 4000 },
  }));
  return extractText(resp);
}

export async function writeScripts(factsList, { client, modelId = MODEL_ID, retries = 2, log = () => {} } = {}) {
  const items = {};
  const failures = [];
  const results = new Array(factsList.length);

  const one = async (facts) => {
    const id = gu_id(facts);
    let prompt = buildPrompt(facts);
    let lastErrors = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const text = await askOnce(client, modelId, prompt);
        const script = parseScript(text);
        if (!script) {
          lastErrors = ["JSON을 해석하지 못했습니다"];
        } else {
          const v = validateScript(facts, script);
          if (v.ok) return { id, caption: script.caption, speech: speechFromCaption(script.caption), source: "bedrock" };
          lastErrors = v.errors;
        }
      } catch (e) {
        lastErrors = [`호출 오류: ${e?.message ?? e}`];
      }
      log(`${id} 시도 ${attempt + 1} 실패: ${lastErrors.join("; ")}`);
      prompt = buildPrompt(facts) + `\n\n[이전 시도 문제]\n- ${lastErrors.join("\n- ")}\n위 문제를 고쳐 JSON만 다시 출력하세요.`;
    }
    failures.push(id);
    const fb = fallbackScript(facts);
    return { id, caption: fb.caption, speech: fb.speech, source: "template" };
  };

  let next = 0;
  const worker = async () => {
    while (next < factsList.length) {
      const i = next++;
      results[i] = await one(factsList[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, factsList.length) }, worker));
  for (const r of results) items[r.id] = { caption: r.caption, speech: r.speech, source: r.source };
  return { items, failures };
}

// ---- 기존 scripts.json과 병합 ----
// 다시 쓸 사실표만 고른다. edited 항목은 force일 때만, only가 있으면 그 구만.
export function planWrite(factsList, existing, { force = false, only = null } = {}) {
  const prev = existing?.items ?? {};
  const pick = only ? new Set(only) : null;
  const targets = [], keptEdited = [];
  for (const f of factsList) {
    if (pick && !pick.has(f.gu)) continue;
    const id = gu_id(f);
    if (!force && prev[id]?.source === "edited") { keptEdited.push(id); continue; }
    targets.push(f);
  }
  return { targets, keptEdited };
}

// 기존 항목은 남기고 새로 쓴 항목만 덮는다. edited는 force일 때만 덮는다(planWrite가 이미 거르지만 한 번 더 막는다).
export function mergeScripts(existing, generated, { force = false } = {}) {
  const items = { ...(existing?.items ?? {}) };
  const kept = [];
  for (const [id, item] of Object.entries(generated)) {
    if (!force && items[id]?.source === "edited") { kept.push(id); continue; }
    items[id] = item;
  }
  return { items, kept };
}

// ---- CLI ----
const FLAGS = new Set(["force"]);
export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    o[key] = FLAGS.has(key) ? true : argv[++i];
  }
  return o;
}

export function parseOnly(value) {
  if (value == null) return null;
  const names = String(value).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !GU_ORDER.includes(n));
  if (unknown.length) throw new Error(`--only에 모르는 구: ${unknown.join(", ")}`);
  return names;
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const args = parseArgs(process.argv.slice(2));
  const data = args.data ?? "frontend/public/data";
  const month = args.month ?? "202611";
  const out = args.out ?? "tools/narration/scripts.json";
  const { buildFacts } = await import("./facts.mjs");
  const index = JSON.parse(await readFile(path.join(data, "index.json"), "utf8"));
  const guDataByName = {};
  for (const gu of index.gus) {
    try {
      guDataByName[gu] = JSON.parse(await readFile(path.join(data, month, `${gu}.json`), "utf8"));
    } catch { /* 없는 구는 buildFacts가 n 0으로 처리 */ }
  }
  const factsList = buildFacts(index, guDataByName, month);
  const force = args.force === true;
  let only;
  try { only = parseOnly(args.only); } catch (e) { console.error(`[write] ${e.message}`); process.exit(1); }
  let existing = null;
  try {
    existing = JSON.parse(await readFile(out, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT" && !force) {
      console.error(`[write] 기존 ${out}를 읽을 수 없습니다(${e.message}). 사람이 고친 문장을 지킬 수 없으니 중단합니다. 새로 쓰려면 --force.`);
      process.exit(1);
    }
  }
  const { targets, keptEdited } = planWrite(factsList, existing, { force, only });
  const factsById = Object.fromEntries(factsList.map((f) => [gu_id(f), f]));
  for (const id of keptEdited) {
    const v = validateScript(factsById[id], existing.items[id]);
    console.error(`[write] ${id}: 사람이 고친 문장(edited)이라 그대로 둡니다(--force로 덮어쓰기).${v.ok ? "" : ` 경고: 현재 사실표와 맞지 않음 — ${v.errors.join("; ")}`}`);
  }
  if (!targets.length) {
    console.log("다시 쓸 항목이 없습니다. 파일을 바꾸지 않았습니다.");
    return;
  }
  const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: "us-east-1" });
  const { items: generated, failures } = await writeScripts(targets, { client, log: (m) => console.error(m) });
  const { items } = mergeScripts(existing, generated, { force });
  await writeFile(out, JSON.stringify({ v: 1, month, modelId: MODEL_ID, items }, null, 2) + "\n");
  console.log(`${targets.length}개 다시 씀(전체 ${Object.keys(items).length}개), edited 유지 ${keptEdited.length}개, 템플릿 대체 ${failures.length}개${failures.length ? `: ${failures.join(", ")}` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
