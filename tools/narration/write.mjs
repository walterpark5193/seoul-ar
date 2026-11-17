// 구 해설 문장 쓰기: Bedrock Converse로 사실표에서 {caption, speech}를 만들고 검증한다.
// 실패하면 재시도하고, 그래도 안 되면 템플릿 문장으로 대체한다.
import { pathToFileURL } from "node:url";
import { TOP_DONG_MIN_N } from "./facts.mjs";

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

// ---- CLI ----
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i];
  }
  return o;
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
  const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: "us-east-1" });
  const { items, failures } = await writeScripts(factsList, { client, log: (m) => console.error(m) });
  await writeFile(out, JSON.stringify({ v: 1, month, modelId: MODEL_ID, items }, null, 2) + "\n");
  console.log(`${Object.keys(items).length}개 작성, 템플릿 대체 ${failures.length}개${failures.length ? `: ${failures.join(", ")}` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
