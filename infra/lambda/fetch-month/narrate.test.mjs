import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SEOUL_KEY, NARRATION_KEYS, MAX_CHARS, MAX_CALLS, FORBIDDEN_RE, narrationKey,
  validateSentence, parseJsonObject, buildFacts, generateNarration,
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
  test("키는 서울 전체 + GU_ORDER 25개, 상한 80자, 호출 30회", () => {
    assert.equal(SEOUL_KEY, "서울 전체");
    assert.deepEqual(NARRATION_KEYS, ["서울 전체", ...GU_ORDER]);
    assert.equal(MAX_CHARS, 80);
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

  test("80자까지는 통과, 81자는 거절 (코드 포인트로 센다)", () => {
    assert.equal(validateSentence("가".repeat(80)).ok, true);
    assert.equal(validateSentence("가".repeat(81)).ok, false);
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
    assert.deepEqual(Object.keys(out.narration), ["v", "month", "generatedAt", "model", "items"]);
    assert.equal(out.narration.v, 1);
    assert.equal(out.narration.month, MONTH);
    assert.equal(out.narration.generatedAt, GEN);
    assert.equal(out.narration.model, "anthropic.claude-haiku-5-5");
    assert.deepEqual(Object.keys(out.narration.items), NARRATION_KEYS);
    assert.match(converse.calls[0].prompt, /압구정동/);
    assert.equal(converse.calls[0].modelId, "anthropic.claude-haiku-5-5");
    assert.ok(converse.calls[0].system.includes("80자"));
  });

  test("모르는 키는 버린다", async () => {
    const converse = fakeConverse(() => bulkReply({ 해운대구: "부산입니다.", 강남구: "강남구 10월 거래 2건입니다." }));
    const out = await generateNarration(base(converse));
    assert.equal("해운대구" in out.narration.items, false);
    assert.equal(out.narration.items["강남구"], "강남구 10월 거래 2건입니다.");
  });

  test("누락·검증 실패 항목만 구별로 1회 재시도, 그래도 실패하면 생략", async () => {
    const converse = fakeConverse((c) => {
      if (c.single === null) return bulkReply({ 중구: undefined, 용산구: "용산구는 매수 추천 지역입니다.", 강남구: "가".repeat(90) });
      if (c.single === "중구") return '{"중구": "중구 10월 거래는 없었습니다."}';
      if (c.single === "용산구") return "용산구 10월 거래는 없었습니다."; // JSON 이 아닌 한 줄도 받는다
      return '{"강남구": "강남구는 앞으로 오를 전망입니다."}'; // 다시 금지어 → 생략
    });
    const progress = [];
    const out = await generateNarration(base(converse, { onProgress: (p) => progress.push(p) }));
    assert.deepEqual(converse.calls.map((c) => c.single), [null, "용산구", "중구", "강남구"].sort((a, b) => NARRATION_KEYS.indexOf(a) - NARRATION_KEYS.indexOf(b)));
    assert.equal(out.narration.items["중구"], "중구 10월 거래는 없었습니다.");
    assert.equal(out.narration.items["용산구"], "용산구 10월 거래는 없었습니다.");
    assert.equal("강남구" in out.narration.items, false);
    assert.deepEqual(out.missing, ["강남구"]);
    assert.equal(out.calls, 4);
    assert.deepEqual(Object.keys(out.narration.items), NARRATION_KEYS.filter((k) => k !== "강남구"));
    // 진행: 첫 호출 뒤 통과 수, 재시도마다 하나씩, 마지막 26
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

  test("호출 상한: maxCalls 를 넘지 않고 남은 항목은 생략", async () => {
    const converse = fakeConverse(() => "JSON 아님\n검증도 실패하는 두 줄");
    const out = await generateNarration(base(converse, { maxCalls: 5 }));
    assert.equal(converse.calls.length, 5);
    assert.equal(out.calls, 5);
    assert.equal(Object.keys(out.narration.items).length, 0);
    assert.deepEqual(out.missing, NARRATION_KEYS);
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

  test("구별 재시도 중 예외는 그 항목만 생략", async () => {
    const converse = fakeConverse((c) => {
      if (c.single === null) return bulkReply({ 중구: undefined });
      throw Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
    });
    const out = await generateNarration(base(converse));
    assert.deepEqual(out.missing, ["중구"]);
    assert.equal(Object.keys(out.narration.items).length, 25);
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
    assert.deepEqual(Object.keys(out.narration.items), ["서울 전체"]);
    assert.equal(out.missing.length, 25);
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
