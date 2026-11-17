import { describe, it, expect } from "vitest";
import {
  buildPrompt, extractText, speechFromCaption, parseScript, allowedNumbers, validateScript, fallbackScript, writeScripts,
} from "./write.mjs";

const facts = {
  gu: "강남구", month: "202611", n: 25, cancelled: 2, medPerM2: 2890, rankPrice: 1,
  maxAmt: 526000, topDong: "압구정동", topDongMedPerM2: 3500, totalGus: 25,
};
const good = { caption: "강남구는 2026년 11월 거래가 25건이었습니다. ㎡당 중위 2,890만 원으로 25개 구 중 1위입니다.", speech: "강남구는 이천이십육 년 십일 월 거래가 스물다섯 건이었습니다. 제곱미터당 이천팔백구십만 원입니다." };
const zero = { ...facts, n: 0, cancelled: 0, medPerM2: null, rankPrice: null, maxAmt: null, topDong: null, topDongMedPerM2: null };
const reply = (obj) => ({ output: { message: { content: [{ reasoningContent: { reasoningText: { text: "생각" } } }, { text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } } });

describe("extractText", () => {
  it("skips reasoningContent", () => {
    expect(extractText(reply("안녕"))).toBe("안녕");
    expect(extractText({})).toBe(null);
  });
});

describe("parseScript", () => {
  it("코드펜스와 잡문 허용", () => {
    const t = '결과입니다.\n```json\n{"caption":"가","speech":"나"}\n```\n끝';
    expect(parseScript(t)).toEqual({ caption: "가", speech: "가" });
    expect(parseScript('앞 {"caption":"가"} 뒤')).toEqual({ caption: "가", speech: "가" });
  });
  it("필드 누락 거절", () => {
    expect(parseScript('{"speech":"나"}')).toBe(null);
    expect(parseScript('{"caption":3}')).toBe(null);
    expect(parseScript("없음")).toBe(null);
    expect(parseScript('{"caption":"가"}')).toEqual({ caption: "가", speech: "가" });
  });
});

describe("allowedNumbers", () => {
  it("52.6억, 2,890, 25, 1위", () => {
    const s = allowedNumbers(facts);
    for (const v of ["52.6", "2,890", "2890", "25", "1", "2026", "11", "3,500"]) expect(s.has(v)).toBe(true);
    expect(s.has("3,100")).toBe(false);
  });
});

describe("validateScript", () => {
  it("정상 통과", () => expect(validateScript(facts, good)).toEqual({ ok: true, errors: [] }));
  it("사실표 밖 숫자 거절", () => {
    const r = validateScript(facts, { ...good, caption: "중위 3,100만 원입니다." });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("3,100");
  });
  it("91자 거절", () => expect(validateScript(facts, { ...good, caption: "가".repeat(91) }).ok).toBe(false));
  it("90자는 통과", () => expect(validateScript(facts, { ...good, caption: "가".repeat(90) }).ok).toBe(true));
  it("금지어 거절", () => {
    expect(validateScript(facts, { ...good, caption: "123번지입니다." }).ok).toBe(false);
    expect(validateScript(facts, { ...good, speech: "폭등했습니다." }).ok).toBe(false);
  });
  it("n 0은 없었다는 취지 필요", () => {
    expect(validateScript(zero, good).ok).toBe(false);
    expect(validateScript(zero, fallbackScript(zero)).ok).toBe(true);
  });
});

describe("speechFromCaption / 지명 숫자 / 아파트", () => {
  it("㎡만 바꾼다", () => expect(speechFromCaption("㎡당 2,890만 원")).toBe("제곱미터당 2,890만 원"));
  it("지명 속 숫자는 무시", () => {
    const f = { ...facts, topDong: "당산동4가" };
    expect(validateScript(f, { caption: "당산동4가가 가장 높았습니다. 거래는 25건입니다." }).ok).toBe(true);
    expect(validateScript(f, { caption: "당산동4가 거래는 7건입니다." }).ok).toBe(false);
  });
  it("아파트라는 단어는 허용", () => expect(validateScript(facts, { caption: "아파트 거래가 많았습니다. 모두 25건입니다." }).ok).toBe(true));
  it("writeScripts speech는 caption에서 유도", async () => {
    const c = { send: async () => reply({ caption: "㎡당 2,890만 원입니다. 25건입니다.", speech: "임의 숫자 99" }) };
    const r = await writeScripts([facts], { client: c });
    expect(r.items["gu-202611-강남구"].speech).toBe("제곱미터당 2,890만 원입니다. 25건입니다.");
  });
});

describe("fallbackScript", () => {
  it("fallback for n 0", () => {
    const f = fallbackScript(zero);
    expect(f.caption).toContain("거래가 없었습니다");
    expect(f.caption).not.toMatch(/\d/);
  });
  it("정상 사실표 대체문도 검증 통과", () => {
    const f = fallbackScript(facts);
    expect(validateScript(facts, f).ok).toBe(true);
    expect(f.speech).toContain("제곱미터");
  });
});

describe("buildPrompt", () => {
  it("사실표 숫자와 JSON 지시", () => {
    const p = buildPrompt(facts);
    for (const v of ["강남구", "2,890", "52.6", "압구정동", "25"]) expect(p).toContain(v);
    expect(p).toContain('{"caption"');
    expect(p).toContain("90자");
  });
});

describe("writeScripts", () => {
  const fake = (responses) => {
    const calls = [];
    return { calls, send: async (cmd) => { calls.push(cmd.input); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; if (r instanceof Error) throw r; return r; } };
  };
  it("성공하면 bedrock", async () => {
    const c = fake([reply(good)]);
    const r = await writeScripts([facts], { client: c, modelId: "m" });
    expect(r.items["gu-202611-강남구"]).toEqual({ caption: good.caption, speech: speechFromCaption(good.caption), source: "bedrock" });
    expect(r.failures).toEqual([]);
    expect(c.calls[0].modelId).toBe("m");
  });
  it("writeScripts retries then falls back", async () => {
    const c = fake([reply({ caption: "3,100만 원", speech: "x" })]);
    const r = await writeScripts([facts], { client: c });
    expect(c.calls.length).toBe(3);
    expect(r.failures).toEqual(["gu-202611-강남구"]);
    expect(r.items["gu-202611-강남구"].source).toBe("template");
  });
  it("재시도 중 성공하면 멈춘다(호출 오류 포함)", async () => {
    const c = fake([new Error("throttled"), reply("잡문"), reply(good)]);
    const r = await writeScripts([facts], { client: c });
    expect(c.calls.length).toBe(3);
    expect(r.items["gu-202611-강남구"].source).toBe("bedrock");
  });
  it("동시 호출 4개 제한", async () => {
    let cur = 0, max = 0;
    const client = { send: async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 5)); cur--; return reply(good); } };
    const list = Array.from({ length: 10 }, (_, i) => ({ ...facts, gu: `구${i}` }));
    list.forEach((f) => { f.n = 25; });
    await writeScripts(list, { client, retries: 0 });
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
  });
});
