import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SEOUL_KEY, NARRATION_KEYS, MAX_CHARS, MAX_CALLS, FORBIDDEN_RE, narrationKey,
  validateSentence, parseJsonObject, buildFacts, generateNarration, templateSentence, formatManwon, tallyText, retryHint,
} from "./narrate.mjs";
import { aggregateRows } from "./aggregate.mjs";
import { GU_ORDER } from "./gu.mjs";
import { row, fakeConverse, bulkReply } from "./fakes.mjs";

const MONTH = "202610";
const GEN = "2026-11-17T10:00:00.000Z";
const perGu = () => GU_ORDER.map((gu) => aggregateRows(
  gu === "강남구" ? [row({ CTRT_DAY: "20261010", STDG_NM: "압구정동", THING_AMT: "400000", ARCH_AREA: 100 }), row({ CTRT_DAY: "20261011", STDG_NM: "대치동", THING_AMT: "200000", ARCH_AREA: 80 })] : [],
  { month: MONTH, gu, generatedAt: GEN },
));

describe("상수와 키", () => {
  test("키는 서울 전체 + GU_ORDER 25개, 상한 100자, 호출 30회", () => {
    assert.equal(SEOUL_KEY, "서울 전체");
    assert.deepEqual(NARRATION_KEYS, ["서울 전체", ...GU_ORDER]);
    assert.equal(MAX_CHARS, 100);
    assert.equal(MAX_CALLS, 30);
    assert.equal(narrationKey("202610"), "data/202610/narration.json");
  });
});

describe("validateSentence", () => {
  test("한국어 한 문장, 앞뒤 공백은 걷어 낸다. 계약서 예시 문장은 통과", () => {
    assert.deepEqual(validateSentence("  강남구 10월: ㎡당 중앙값 3,750만원입니다. "), { ok: true, text: "강남구 10월: ㎡당 중앙값 3,750만원입니다." });
    assert.equal(validateSentence("강남구 11월: ㎡당 중앙값 1,564만원, 압구정동이 가장 높습니다.").ok, true);
    assert.equal(validateSentence("11월 서울 매매 1,014건, ㎡당 중앙값은 1,200만원입니다.").ok, true);
  });

  test("해설이 아닌 원문은 거절: 한글 없음, { 나 \" 로 시작, '<키>:' 조각, '죄송'", () => {
    const cases = {
      "Gangnam had 3 trades in October.": "hangul",
      "1,234": "hangul",
      "{\"강남구\": \"강남구 10월 거래 3건입니다.\"": "json",
      "\"강남구 10월 거래 3건입니다.\"": "json",
      "강남구: 10월 거래 3건입니다.": "key",
      "결과는 \"중구\": 거래 없음": "key",
      "서울 전체: 거래 1,014건": "key",
      "죄송합니다만 그 요청은 도와드릴 수 없습니다.": "refusal",
    };
    for (const [s, reason] of Object.entries(cases)) {
      const v = validateSentence(s);
      assert.equal(v.ok, false, s);
      assert.equal(v.reason, reason, s);
    }
  });

  test("100자까지는 통과, 101자는 거절 (코드 포인트로 센다), 길이를 detail 로", () => {
    assert.equal(validateSentence("가".repeat(100)).ok, true);
    assert.deepEqual(validateSentence("가".repeat(101)), { ok: false, reason: "length", detail: { length: 101 } });
    assert.equal(validateSentence("가" + "😀".repeat(79)).ok, true);
  });

  test("빈 값, 문자열 아님, 줄바꿈은 거절", () => {
    for (const bad of ["", "   ", null, undefined, 3, { a: 1 }, "첫 줄\n둘째 줄"]) assert.equal(validateSentence(bad).ok, false, String(bad));
  });

  test("투자 권유·전망 표현은 거절", () => {
    for (const w of ["추천", "매수", "매도", "사세요", "팔세요", "오를", "내릴", "전망", "유망", "투자하"]) {
      assert.match(w, FORBIDDEN_RE);
      const v = validateSentence(`강남구는 ${w} 만한 곳입니다.`);
      assert.equal(v.ok, false, w);
      assert.equal(v.reason, "forbidden");
    }
  });

  test("번지·본번·부번·지번 숫자는 거절", () => {
    for (const s of ["대치동 316번지 거래가 가장 비쌌습니다.", "대치동 316-1 거래가 있었습니다.", "본번 0316 의 거래입니다.", "부번이 같은 거래입니다."]) {
      assert.equal(validateSentence(s).ok, false, s);
    }
  });
});

describe("parseJsonObject", () => {
  test("순수 JSON, ```json 울타리, 앞뒤 설명이 붙은 JSON", () => {
    assert.deepEqual(parseJsonObject('{"a": "1"}'), { a: "1" });
    assert.deepEqual(parseJsonObject('```json\n{"강남구": "문장"}\n```'), { 강남구: "문장" });
    assert.deepEqual(parseJsonObject('다음과 같습니다.\n{"a": "x"}\n이상입니다.'), { a: "x" });
  });

  test("깨졌거나 객체가 아니면 null", () => {
    for (const bad of ["{a: 1}", "[1,2]", "그냥 문장", "", null, '{"a": "1"'] ) assert.equal(parseJsonObject(bad), null, String(bad));
  });
});

describe("buildFacts: 집계 JSON 만 넘긴다", () => {
  test("서울 합계와 구별 total, 상위 법정동 3개(이름, n, ㎡당 중앙값)", () => {
    const f = buildFacts(MONTH, perGu());
    assert.equal(f.month, MONTH);
    assert.equal(f.seoul.n, 2);
    assert.equal(f.gus["강남구"].n, 2);
    assert.equal(f.gus["강남구"].medPerM2, 3250);
    assert.deepEqual(f.gus["강남구"].topDongs.map((d) => d.name), ["압구정동", "대치동"]);
    assert.equal(f.gus["종로구"].n, 0);
    assert.deepEqual(Object.keys(f.gus), GU_ORDER);
    const text = JSON.stringify(f);
    for (const banned of ["MNO", "SNO", "BLDG_NM", "비밀아파트테스트", "CTRT_DAY"]) assert.ok(!text.includes(banned), banned);
  });
});

describe("generateNarration", () => {
  const base = (converse, over = {}) => ({ converse, modelId: "anthropic.claude-haiku-5-5", month: MONTH, perGu: perGu(), generatedAt: GEN, ...over });

  test("한 번의 호출로 26개: 파일 모양 {v, month, generatedAt, model, items}", async () => {
    const converse = fakeConverse(() => bulkReply());
    const out = await generateNarration(base(converse));
    assert.equal(converse.calls.length, 1);
    assert.equal(out.calls, 1);
    assert.deepEqual(out.missing, []);
    assert.deepEqual(Object.keys(out.narration), ["v", "month", "generatedAt", "model", "items", "source"]);
    assert.ok(Object.values(out.narration.source).every((x) => x === "model"));
    assert.equal(Object.keys(out.narration.source).length, 26);
    assert.equal(out.narration.v, 1);
    assert.equal(out.narration.month, MONTH);
    assert.equal(out.narration.generatedAt, GEN);
    assert.equal(out.narration.model, "anthropic.claude-haiku-5-5");
    assert.deepEqual(Object.keys(out.narration.items), NARRATION_KEYS);
    assert.match(converse.calls[0].prompt, /압구정동/);
    assert.equal(converse.calls[0].modelId, "anthropic.claude-haiku-5-5");
    const sys = converse.calls[0].system;
    assert.ok(sys.includes("70자 안팎") && sys.includes("최대 90자"), "길이 한도를 밝힌다");
    assert.ok(sys.includes("5억 5,000만원"), "금액 표기 예");
    assert.ok(sys.includes("좋은 예:"), "통과하는 문장 예");
  });

  test("모르는 키는 버린다", async () => {
    const converse = fakeConverse(() => bulkReply({ 해운대구: "부산입니다.", 강남구: "강남구 10월 거래 2건입니다." }));
    const out = await generateNarration(base(converse));
    assert.equal("해운대구" in out.narration.items, false);
    assert.equal(out.narration.items["강남구"], "강남구 10월 거래 2건입니다.");
  });

  test("걸린 항목만 이유를 알려 주며 1회 재시도, 그래도 걸리면 틀 문장(생략 없음)", async () => {
    const converse = fakeConverse((c) => {
      if (c.single === null) return bulkReply({ 중구: undefined, 용산구: "용산구는 매수 추천 지역입니다.", 강남구: "가".repeat(110) });
      if (c.single === "중구") return '{"중구": "중구 10월 거래는 없었습니다."}';
      if (c.single === "용산구") return "용산구 10월 거래는 없었습니다."; // JSON 이 아닌 한 줄도 받는다
      return '{"강남구": "강남구는 앞으로 오를 전망입니다."}'; // 다시 금지어 → 틀 문장
    });
    const progress = [];
    const out = await generateNarration(base(converse, { onProgress: (p) => progress.push(p) }));
    const singles = converse.calls.filter((c) => c.single !== null);
    assert.deepEqual(singles.map((c) => c.single), ["중구", "용산구", "강남구"]);
    assert.match(singles[0].prompt, /앞 일괄 응답에 이 키가 없었습니다/);
    assert.match(singles[1].prompt, /쓰면 안 되는 말\("매수"\)/);
    assert.match(singles[2].prompt, /앞 문장은 110자였습니다\. 70자 안팎, 최대 90자로 줄여 주세요/);
    assert.equal(out.narration.items["중구"], "중구 10월 거래는 없었습니다.");
    assert.equal(out.narration.items["용산구"], "용산구 10월 거래는 없었습니다.");
    assert.equal(out.narration.items["강남구"], templateSentence("강남구", buildFacts(MONTH, perGu())));
    assert.equal(out.narration.source["강남구"], "template");
    assert.equal(out.narration.source["중구"], "model");
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.templated, ["강남구"]);
    assert.deepEqual(out.tally, { forbidden: 1 });
    assert.equal(out.calls, 4);
    assert.deepEqual(Object.keys(out.narration.items), NARRATION_KEYS);
    assert.deepEqual(progress.map((p) => p.done), [23, 24, 25, 26]);
    assert.deepEqual(progress.slice(1).map((p) => p.key), ["중구", "용산구", "강남구"]);
  });

  test("첫 응답이 JSON 이 아니면 26개 모두 구별 재시도 (호출 27회 ≤ 30)", async () => {
    const converse = fakeConverse((c) => (c.single === null ? "죄송합니다, 지금은 답할 수 없습니다." : JSON.stringify({ [c.single]: `${c.single} 10월 요약입니다.` })));
    const out = await generateNarration(base(converse));
    assert.equal(out.calls, 27);
    assert.ok(out.calls <= MAX_CALLS);
    assert.deepEqual(out.missing, []);
    assert.deepEqual(Object.keys(out.narration.items), NARRATION_KEYS);
  });

  test("호출 상한: maxCalls 를 넘지 않고 남은 항목은 틀 문장 (26/26)", async () => {
    const converse = fakeConverse(() => "JSON 아님\n검증도 실패하는 두 줄");
    const out = await generateNarration(base(converse, { maxCalls: 5 }));
    assert.equal(converse.calls.length, 5);
    assert.equal(out.calls, 5);
    assert.equal(Object.keys(out.narration.items).length, 26);
    assert.ok(Object.values(out.narration.source).every((x) => x === "template"));
    assert.deepEqual(out.missing, []);
  });

  test("첫 호출이 예외면(권한 없음 등) 그대로 올린다: 재시도 26번을 하지 않는다", async () => {
    const converse = fakeConverse(() => { throw Object.assign(new Error("You don't have access to the model"), { name: "AccessDeniedException" }); });
    await assert.rejects(generateNarration(base(converse)), { name: "AccessDeniedException" });
    assert.equal(converse.calls.length, 1);
  });

  test("on-demand 불가(인퍼런스 프로파일 필요)면 us. 프로파일로 한 번 바꿔 계속, model 에 실제 ID", async () => {
    const converse = fakeConverse((c) => {
      if (!c.modelId.startsWith("us.")) throw Object.assign(new Error("Invocation of model ID anthropic.claude-haiku-5-5 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model."), { name: "ValidationException" });
      return bulkReply();
    });
    const out = await generateNarration(base(converse));
    assert.deepEqual(converse.calls.map((c) => c.modelId), ["anthropic.claude-haiku-5-5", "us.anthropic.claude-haiku-5-5"]);
    assert.equal(out.narration.model, "us.anthropic.claude-haiku-5-5");
    assert.equal(out.calls, 2);
  });

  test("구별 재시도 중 예외는 그 항목만 틀 문장 (이유 '호출 실패')", async () => {
    const converse = fakeConverse((c) => {
      if (c.single === null) return bulkReply({ 중구: undefined });
      throw Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
    });
    const out = await generateNarration(base(converse));
    assert.deepEqual(out.missing, []);
    assert.equal(out.narration.source["중구"], "template");
    assert.deepEqual(out.tally, { error: 1 });
    assert.equal(Object.keys(out.narration.items).length, 26);
  });

  test("첫 호출 전 마감이면 던진다(모은 것이 없다)", async () => {
    const converse = fakeConverse(() => bulkReply());
    await assert.rejects(generateNarration(base(converse, { beforeCall: () => { throw new Error("마감"); } })), /마감/);
    assert.equal(converse.calls.length, 0);
  });

  test("재시도 중 마감이면 거기서 멈추고 지금까지 통과한 항목을 돌려준다 (stoppedEarly)", async () => {
    const converse = fakeConverse((c) => (c.single === null ? "죄송합니다, 지금은 답할 수 없습니다." : JSON.stringify({ [c.single]: `${c.single} 10월 요약입니다.` })));
    let n = 0;
    const out = await generateNarration(base(converse, { beforeCall: () => { if (++n === 3) throw new Error("마감"); } }));
    assert.equal(converse.calls.length, 2);
    assert.equal(out.stoppedEarly, true);
    assert.equal(out.narration.source["서울 전체"], "model");
    assert.equal(Object.keys(out.narration.items).length, 26, "남은 항목은 틀 문장");
    assert.equal(out.templated.length, 25);
    assert.deepEqual(out.missing, []);
  });

  test("skip 키(읽지 못한 구 파일)는 만들지도 다시 시도하지도 않고 missing 에 넣는다. 구를 빼면 서울 전체도 뺀다", async () => {
    const converse = fakeConverse(() => bulkReply()); // 모델이 빼라는 키까지 써 와도 버린다
    const progress = [];
    const out = await generateNarration(base(converse, { skip: ["중구"], onProgress: (p) => progress.push(p) }));
    assert.equal(converse.calls.length, 1);
    assert.equal("중구" in out.narration.items, false);
    assert.equal("서울 전체" in out.narration.items, false);
    assert.deepEqual(out.missing, ["서울 전체", "중구"]);
    assert.equal(Object.keys(out.narration.items).length, 24);
    const prompt = converse.calls[0].prompt;
    assert.ok(!prompt.includes('"중구"'), "중구 사실을 넘기지 않는다");
    assert.ok(!/키 목록[^\n]*서울 전체/.test(prompt), "서울 전체를 요청하지 않는다");
    assert.equal(progress.at(-1).done, 26);
  });

  test("일괄 응답의 stopReason 을 남기고 max_tokens 면 잘렸다고 경고한다", async () => {
    const logs = [];
    const converse = fakeConverse(() => ({ text: bulkReply(), stopReason: "max_tokens" }));
    const out = await generateNarration(base(converse, { log: (level, msg, fields) => logs.push({ level, msg, fields }) }));
    assert.equal(Object.keys(out.narration.items).length, 26);
    assert.ok(logs.some((l) => l.fields?.stopReason === "max_tokens"));
    assert.ok(logs.some((l) => l.level === "warn" && /잘림/.test(l.msg)));
    const quiet = [];
    await generateNarration(base(fakeConverse(() => ({ text: bulkReply(), stopReason: "end_turn" })), { log: (level, msg, fields) => quiet.push({ level, msg, fields }) }));
    assert.ok(quiet.some((l) => l.fields?.stopReason === "end_turn"));
    assert.ok(!quiet.some((l) => /잘림/.test(l.msg)));
  });
});


describe("Task 11b: 검증 이유, 틀 문장, only", () => {
  const base = (converse, over = {}) => ({ converse, modelId: "us.anthropic.claude-haiku-5-5", month: MONTH, perGu: perGu(), generatedAt: GEN, ...over });

  test("그 항목 자신의 키로 시작하는 '종로구: …' 는 받고, 다른 키 조각은 거절", () => {
    assert.equal(validateSentence("종로구: 8월 매매 141건입니다.", { key: "종로구" }).ok, true);
    assert.deepEqual(validateSentence("종로구: 8월 매매 141건입니다.", { key: "중구" }), { ok: false, reason: "key", detail: { match: "종로구:" } });
    assert.equal(validateSentence("종로구: 8월 매매 141건입니다.").reason, "key");
    assert.equal(validateSentence("서울 전체: 8월 매매 1,014건입니다.", { key: "서울 전체" }).ok, true);
    assert.equal(validateSentence('종로구: 8월 141건, "중구": 3건', { key: "종로구" }).reason, "key");
  });

  test("거절 detail: 금지어와 번지 표기", () => {
    assert.deepEqual(validateSentence("강남구는 전망이 밝습니다.").detail, { word: "전망" });
    assert.deepEqual(validateSentence("대치동 316-1 거래가 있었습니다.").detail, { match: "316-1" });
    assert.equal(validateSentence("강남구 최고 5억 5,000만원, 5억 5천만원입니다.").ok, true, "억·천 표기는 통과");
  });

  test("retryHint 는 이유별 한 줄", () => {
    assert.equal(retryHint({ reason: "length", detail: { length: 97 } }), "앞 문장은 97자였습니다. 70자 안팎, 최대 90자로 줄여 주세요.");
    assert.match(retryHint({ reason: "lot", detail: { match: "316-1" } }), /316-1/);
    assert.match(retryHint({ reason: "missing" }), /없었습니다/);
  });

  test("formatManwon: 억·만원 표기(하이픈 없음)", () => {
    assert.equal(formatManwon(255000), "25억 5,000만원");
    assert.equal(formatManwon(400000), "40억원");
    assert.equal(formatManwon(9800), "9,800만원");
    assert.equal(formatManwon(1234567), "123억 4,567만원");
  });

  test("틀 문장 모양: 구, 서울 전체, 거래 없음. 모두 검증을 통과", () => {
    const facts = buildFacts(MONTH, perGu());
    assert.equal(templateSentence("강남구", facts), "강남구 10월 매매 2건(취소 0건), ㎡당 중앙값 3,250만원, 최고 40억원.");
    assert.equal(templateSentence("서울 전체", facts), "10월 서울 매매 2건, ㎡당 중앙값이 가장 높은 구는 강남구(3,250만원)입니다.");
    assert.equal(templateSentence("종로구", facts), "종로구 10월에는 매매 거래가 없었습니다.");
    for (const key of NARRATION_KEYS) assert.equal(validateSentence(templateSentence(key, facts), { key }).ok, true, key);
  });

  test("모든 응답이 걸려도 26/26: 이유 집계(tally)와 tallyText", async () => {
    const tooLong = "가".repeat(120);
    const converse = fakeConverse((c) => (c.single === null ? JSON.stringify(Object.fromEntries(NARRATION_KEYS.map((k) => [k, tooLong]))) : JSON.stringify({ [c.single]: tooLong })));
    const logs = [];
    const out = await generateNarration(base(converse, { log: (level, msg, fields) => logs.push({ level, msg, fields }) }));
    assert.equal(Object.keys(out.narration.items).length, 26);
    assert.equal(out.templated.length, 26);
    assert.deepEqual(out.tally, { length: 26 });
    assert.equal(tallyText(out.tally), "길이 26");
    assert.equal(tallyText({ key: 2, length: 5, forbidden: 1 }), "길이 5, 키 조각 2, 금지어 1");
    const rejects = logs.filter((l) => l.msg === "해설 검증 실패");
    assert.equal(rejects.filter((l) => l.fields.phase === "bulk").length, 26);
    assert.equal(rejects.filter((l) => l.fields.phase === "retry").length, 26);
    assert.ok(rejects.every((l) => l.fields.reason === "length" && l.fields.length === 120));
    assert.ok(logs.some((l) => l.msg === "해설 결과" && l.fields.template === 26));
  });

  test("일괄 호출이 설정 오류가 아닌 예외(스로틀링)면 다시 부르지 않고 모두 틀 문장", async () => {
    const converse = fakeConverse(() => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); });
    const out = await generateNarration(base(converse));
    assert.equal(converse.calls.length, 1);
    assert.equal(out.templated.length, 26);
    assert.deepEqual(out.tally, { error: 26 });
  });

  test("only: 그 키들만 묻고 그 키들만 돌려준다", async () => {
    const converse = fakeConverse(() => bulkReply());
    const out = await generateNarration(base(converse, { only: ["중구", "서울 전체"] }));
    assert.match(converse.calls[0].prompt, /키 목록\(정확히 이 2개\): 서울 전체, 중구/);
    assert.deepEqual(Object.keys(out.narration.items), ["서울 전체", "중구"]);
    assert.deepEqual(out.missing, []);
  });
});
