import { describe, it, expect } from "vitest";
import {
  buildPrompt, extractText, speechFromCaption, parseScript, allowedNumbers, validateScript, fallbackScript, writeScripts,
  planWrite, mergeScripts, parseArgs, parseOnly,
} from "./write.mjs";

const facts = {
  gu: "강남구", month: "202611", n: 25, cancelled: 2, medPerM2: 2890, rankPrice: 1,
  maxAmt: 526000, topDong: "압구정동", topDongMedPerM2: 3500, topDongBasis: "min3", topDongIsMax: true, totalGus: 25,
};
const good = { caption: "강남구는 2026년 11월 거래가 25건이었습니다. ㎡당 중위 2,890만 원으로 25개 구 중 1위입니다.", speech: "강남구는 이천이십육 년 십일 월 거래가 스물다섯 건이었습니다. 제곱미터당 이천팔백구십만 원입니다." };
const zero = { ...facts, n: 0, cancelled: 0, medPerM2: null, rankPrice: null, maxAmt: null, topDong: null, topDongMedPerM2: null, topDongBasis: null };
const thin = { ...facts, topDong: "홍파동", topDongMedPerM2: 3250, topDongBasis: "maxN" };
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
  it("min3이면 기준 건수 3 허용, 아니면 불허", () => {
    expect(allowedNumbers(facts).has("3")).toBe(true);
    expect(allowedNumbers(thin).has("3")).toBe(false);
    expect(allowedNumbers(zero).has("3")).toBe(false);
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
  it("min3 동은 3건 이상 단서와 함께 통과", () => {
    const c = "강남구는 25건이 거래됐습니다. 거래 3건 이상인 동 가운데 압구정동이 ㎡당 중위 3,500만 원으로 가장 높았습니다.";
    expect(validateScript(facts, { caption: c })).toEqual({ ok: true, errors: [] });
  });
  it("maxN·null 동은 이름을 쓰면 거절", () => {
    const c = "강남구는 25건이 거래됐습니다. 홍파동이 ㎡당 중위 3,250만 원으로 가장 높았습니다.";
    const r = validateScript(thin, { caption: c });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("홍파동");
    expect(validateScript(thin, good).ok).toBe(true);
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
  it("순위·최상급 규칙을 알려 준다", () => {
    const p = buildPrompt(facts);
    expect(p).toContain("1위일 때만");
    expect(p).toContain("25위일 때만");
  });
  it("min3이면 3건 이상 단서를 요구한다", () => {
    const p = buildPrompt(facts);
    expect(p).toContain("거래 3건 이상인 동 가운데");
    expect(p).toMatch(/단서/);
    expect(p).not.toMatch(/동 이름은 쓰지 않습니다/);
  });
  it("maxN·null이면 동 이름을 주지 않고 쓰지 말라고 한다", () => {
    for (const f of [thin, { ...facts, topDong: null, topDongMedPerM2: null, topDongBasis: null }]) {
      const p = buildPrompt(f);
      expect(p).not.toContain("홍파동");
      expect(p).not.toContain("압구정동");
      expect(p).not.toContain("3,250");
      expect(p).toContain("동 이름은 쓰지 않습니다");
    }
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

describe("validateScript 의미 검사", () => {
  const ok = (f, caption) => validateScript(f, { caption });
  it("N위는 rankPrice와 같아야 한다", () => {
    expect(ok(facts, "강남구는 25개 구 중 1위입니다. 거래는 25건입니다.").ok).toBe(true);
    const r = ok({ ...facts, cancelled: 3 }, "강남구는 25개 구 중 3위입니다. 거래는 25건입니다.");
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("3위");
  });
  it("구에 대한 최상급(가장 비싼·높)은 1위일 때만, 가장 낮·싼은 꼴찌일 때만", () => {
    expect(ok(facts, "강남구는 서울에서 가장 비쌉니다. 거래는 25건입니다.").ok).toBe(true);
    expect(ok({ ...facts, rankPrice: 17 }, "강남구는 서울에서 가장 비쌉니다. 거래는 25건입니다.").ok).toBe(false);
    expect(ok({ ...facts, rankPrice: 2 }, "강남구는 ㎡당 중위 2,890만 원으로 가장 높습니다.").ok).toBe(false);
    expect(ok({ ...facts, rankPrice: 2 }, "강남구는 25개 구 중 가장 싼 편입니다.").ok).toBe(false);
    expect(ok({ ...facts, rankPrice: 25 }, "강남구는 ㎡당 중위 2,890만 원으로 가장 낮습니다.").ok).toBe(true);
  });
  it("동에 대한 최상급은 3건 이상 단서가 있거나 그 동이 구 전체 최대일 때만", () => {
    const noClue = "강남구는 25건이 거래됐습니다. 압구정동이 ㎡당 중위 3,500만 원으로 가장 높았습니다.";
    const clue = "강남구는 25건이 거래됐습니다. 3건 이상 거래된 동 중 압구정동이 ㎡당 중위 3,500만 원으로 가장 높았습니다.";
    expect(ok(facts, noClue).ok).toBe(true);
    const r = ok({ ...facts, topDongIsMax: false }, noClue);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("압구정동");
    expect(ok({ ...facts, topDongIsMax: false }, clue).ok).toBe(true);
  });
  it("사실표의 동이 아닌 동에 최상급·금액을 붙이면 거절", () => {
    expect(ok(facts, "3건 이상 거래된 동 중 대치동이 가장 높았습니다. 거래는 25건입니다.").ok).toBe(false);
    expect(ok(facts, "대치동은 ㎡당 중위 3,500만 원입니다. 거래는 25건입니다.").ok).toBe(false);
  });
  it("동에 대한 가장 낮·싼, 건수 최상급(가장 많·적)은 사실표에 없어 거절", () => {
    expect(ok(facts, "압구정동이 가장 쌌습니다. 거래는 25건입니다.").ok).toBe(false);
    expect(ok(facts, "강남구는 거래가 가장 많았습니다. 모두 25건입니다.").ok).toBe(false);
  });
  it("억 숫자는 maxAmt/10000(소수 첫째)과만", () => {
    expect(ok(facts, "최고 거래가는 52.6억 원이었습니다. 거래는 25건입니다.").ok).toBe(true);
    const r = ok(facts, "최고 거래가는 25억 원이었습니다. 거래는 25건입니다.");
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("25억");
    expect(ok({ ...facts, maxAmt: 250000 }, "최고 거래가는 25억 원이었습니다. 거래는 25건입니다.").ok).toBe(true);
  });
  it("건 숫자는 거래 n, 취소 문맥이면 cancelled와만", () => {
    expect(ok(facts, "거래 25건, 취소 2건이었습니다.").ok).toBe(true);
    expect(ok(facts, "강남구 거래는 25건, 취소는 2건이었습니다.").ok).toBe(true);
    expect(ok(facts, "취소 2건을 빼고 25건이 거래됐습니다.").ok).toBe(true);
    expect(ok(facts, "강남구는 2건이 거래됐습니다.").ok).toBe(false);
    expect(ok(facts, "거래 25건, 취소 25건이었습니다.").ok).toBe(false);
  });
  it("3건 이상 단서는 min3일 때만 건 숫자 예외", () => {
    expect(ok(facts, "3건 이상 거래된 동 중 압구정동이 가장 높습니다. 거래는 25건입니다.").ok).toBe(true);
    expect(ok({ ...thin, n: 3 }, "3건 이상 거래된 동이 없었습니다. 거래는 3건입니다.").ok).toBe(true);
    expect(ok(thin, "3건 이상 거래된 동이 없었습니다. 거래는 25건입니다.").ok).toBe(false);
  });
  it("만 원 숫자는 동 문맥이면 topDongMedPerM2, 아니면 medPerM2·maxAmt", () => {
    expect(ok(facts, "강남구는 ㎡당 중위 3,500만 원입니다. 거래는 25건입니다.").ok).toBe(false);
    expect(ok(facts, "3건 이상 거래된 동 중 압구정동이 ㎡당 중위 2,890만 원으로 가장 높습니다.").ok).toBe(false);
    expect(ok(facts, "강남구는 ㎡당 중위 2,890만 원, 3건 이상 거래된 동 중 압구정동은 3,500만 원으로 가장 높습니다.").ok).toBe(true);
  });
  it("N개 구는 totalGus와만", () => {
    expect(ok({ ...facts, n: 17 }, "강남구는 17개 구 중 1위입니다. 거래는 17건입니다.").ok).toBe(false);
  });
});

describe("planWrite / mergeScripts", () => {
  const list = [facts, { ...facts, gu: "서초구" }, { ...facts, gu: "송파구" }];
  const existing = { v: 1, month: "202611", items: {
    "gu-202611-강남구": { caption: "사람 문장", speech: "사람 문장", source: "edited" },
    "gu-202611-서초구": { caption: "옛 문장", speech: "옛 문장", source: "bedrock" },
  } };
  it("edited 항목은 --force 없이는 다시 쓰지 않는다", () => {
    const p = planWrite(list, existing);
    expect(p.targets.map((f) => f.gu)).toEqual(["서초구", "송파구"]);
    expect(p.keptEdited).toEqual(["gu-202611-강남구"]);
    expect(planWrite(list, existing, { force: true }).targets.map((f) => f.gu)).toEqual(["강남구", "서초구", "송파구"]);
  });
  it("--only는 고른 구만 다시 쓴다(edited 보호는 그대로)", () => {
    expect(planWrite(list, existing, { only: ["서초구"] }).targets.map((f) => f.gu)).toEqual(["서초구"]);
    const p = planWrite(list, existing, { only: ["강남구"] });
    expect(p.targets).toEqual([]);
    expect(p.keptEdited).toEqual(["gu-202611-강남구"]);
    expect(planWrite(list, existing, { only: ["강남구"], force: true }).targets.map((f) => f.gu)).toEqual(["강남구"]);
  });
  it("기존 파일이 없으면 전부", () => {
    expect(planWrite(list, null).targets).toHaveLength(3);
  });
  it("mergeScripts는 기존 항목을 남기고 새 항목만 덮되 edited는 force일 때만", () => {
    const gen = {
      "gu-202611-강남구": { caption: "새", speech: "새", source: "bedrock" },
      "gu-202611-송파구": { caption: "새2", speech: "새2", source: "bedrock" },
    };
    const m = mergeScripts(existing, gen);
    expect(m.items["gu-202611-강남구"].source).toBe("edited");
    expect(m.items["gu-202611-서초구"].caption).toBe("옛 문장");
    expect(m.items["gu-202611-송파구"].caption).toBe("새2");
    expect(m.kept).toEqual(["gu-202611-강남구"]);
    expect(mergeScripts(existing, gen, { force: true }).items["gu-202611-강남구"].caption).toBe("새");
    expect(mergeScripts(null, gen).items).toEqual(gen);
  });
});

describe("CLI 인자", () => {
  it("--force는 값 없는 플래그, 나머지는 값", () => {
    expect(parseArgs(["--force", "--only", "강남구,서초구", "--month", "202611"])).toEqual({ force: true, only: "강남구,서초구", month: "202611" });
    expect(parseArgs(["--month", "202611", "--force"])).toEqual({ month: "202611", force: true });
  });
  it("parseOnly는 GU_ORDER 이름만 받는다", () => {
    expect(parseOnly("강남구, 서초구")).toEqual(["강남구", "서초구"]);
    expect(() => parseOnly("강남구,없는구")).toThrow(/없는구/);
    expect(parseOnly(undefined)).toBe(null);
  });
});

describe("공동 순위·공동 최고 동·집계 중인 달", () => {
  const ok = (f, caption) => validateScript(f, { caption });
  const tiedRank = { ...facts, rankPrice: 13, rankTied: true };
  it("공동 순위: 같은 순위의 구가 있으면 'N위'·'공동 N위' 모두 참, 없으면 '공동' 거절", () => {
    expect(ok(tiedRank, "강남구는 25개 구 중 공동 13위입니다. 거래는 25건입니다.")).toEqual({ ok: true, errors: [] });
    expect(ok(tiedRank, "강남구는 25개 구 중 13위입니다. 거래는 25건입니다.").ok).toBe(true);
    expect(ok(tiedRank, "강남구는 25개 구 중 14위입니다. 거래는 25건입니다.").ok).toBe(false);
    const r = ok({ ...facts, rankPrice: 13, rankTied: false }, "강남구는 25개 구 중 공동 13위입니다. 거래는 25건입니다.");
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("공동");
  });
  it("공동 1위인 구의 '가장 비싸다'는 공동이라고 밝힐 때만", () => {
    const top = { ...facts, rankPrice: 1, rankTied: true };
    expect(ok(top, "강남구는 서울에서 가장 비쌉니다. 거래는 25건입니다.").ok).toBe(false);
    expect(ok(top, "강남구는 공동으로 가장 비쌉니다. 거래는 25건입니다.").ok).toBe(true);
    expect(ok(top, "강남구는 25개 구 중 공동 1위입니다. 거래는 25건입니다.").ok).toBe(true);
  });
  it("buildPrompt: 공동 순위면 '공동 N위'로 알려 준다", () => {
    expect(buildPrompt(tiedRank)).toContain("25개 구 중 공동 13위");
    expect(buildPrompt(tiedRank)).toContain('"공동 13위"로 씁니다');
    expect(buildPrompt(facts)).not.toContain("공동 1위");
    expect(fallbackScript(tiedRank).caption).toContain("공동 13위");
    expect(validateScript(tiedRank, fallbackScript(tiedRank)).ok).toBe(true);
  });

  const tiedDong = { ...facts, topDong: "금호동3가", topDongMedPerM2: 2335, topDongIsMax: false, topDongTiedWith: ["행당동"] };
  it("공동 최고 동: 한 동만 '가장 높다'면 거절, 함께·공동이라고 밝히면 통과(짝 동 이름·금액 허용)", () => {
    const solo = "강남구는 25건이 거래됐습니다. 거래 3건 이상인 동 가운데 금호동3가가 ㎡당 2,335만 원으로 가장 높습니다.";
    const r = ok(tiedDong, solo);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("행당동");
    expect(ok(tiedDong, "강남구는 25건이 거래됐습니다. 3건 이상 거래된 동 중 금호동3가와 행당동이 ㎡당 2,335만 원으로 함께 가장 높습니다.")).toEqual({ ok: true, errors: [] });
    expect(ok(tiedDong, "강남구는 25건이 거래됐습니다. 3건 이상 거래된 동 중 금호동3가가 ㎡당 2,335만 원으로 공동으로 가장 높습니다.").ok).toBe(true);
    // 짝 동의 금액이 다르면 거절, 짝이 아닌 동은 거절
    expect(ok(tiedDong, "3건 이상 거래된 동 중 행당동이 ㎡당 2,000만 원입니다. 거래는 25건입니다.").ok).toBe(false);
    expect(ok(tiedDong, "3건 이상 거래된 동 중 금호동3가와 옥수동이 함께 가장 높습니다. 거래는 25건입니다.").ok).toBe(false);
    // 3건 이상 단서 없이도 안 된다(topDongIsMax false)
    expect(ok(tiedDong, "강남구는 25건이 거래됐습니다. 금호동3가와 행당동이 ㎡당 2,335만 원으로 함께 가장 높습니다.").ok).toBe(false);
  });
  it("buildPrompt: 공동 최고 동이면 두 이름과 공동을 알려 준다", () => {
    const p = buildPrompt(tiedDong);
    expect(p).toContain("금호동3가, 행당동 (공동, ㎡당 중위 2,335만 원)");
    expect(p).toContain("한 동만");
    expect(buildPrompt(facts)).not.toContain("한 동만");
  });

  const partial = { ...facts, partial: true };
  it('집계 중인 달은 달 바로 뒤에 "(집계 중)", 달을 반드시 말한다', () => {
    expect(ok(partial, "강남구 11월(집계 중) 거래는 25건입니다. ㎡당 중위 2,890만 원으로 1위입니다.")).toEqual({ ok: true, errors: [] });
    expect(ok(partial, "강남구는 2026년 11월(집계 중) 거래가 25건입니다. ㎡당 중위 2,890만 원입니다.").ok).toBe(true);
    const r = ok(partial, "강남구 11월 거래는 25건입니다. ㎡당 중위 2,890만 원으로 1위입니다.");
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("11월(집계 중)");
    expect(ok(partial, "강남구 11월 (집계 중) 거래는 25건입니다. 1위입니다.").ok).toBe(false);
    expect(ok(partial, "강남구 11월(집계 중) 거래는 25건입니다. 11월 1위입니다.").ok).toBe(false);
    expect(ok(partial, "강남구 거래는 25건입니다. ㎡당 중위 2,890만 원으로 1위입니다.").ok).toBe(false);
  });
  it('집계 중이 아닌 달에 "집계 중"이면 거절', () => {
    expect(ok({ ...facts, partial: false }, "강남구 11월(집계 중) 거래는 25건입니다. 1위입니다.").ok).toBe(false);
    expect(ok(facts, "강남구 11월(집계 중) 거래는 25건입니다. 1위입니다.").ok).toBe(false);
  });
  it("buildPrompt·fallbackScript: 집계 중인 달 표시", () => {
    const p = buildPrompt(partial);
    expect(p).toContain('"11월(집계 중)"처럼');
    expect(p).toMatch(/기간: 2026년 11월 \(집계 중/);
    expect(buildPrompt(facts)).not.toContain("집계 중");
    for (const f of [partial, { ...zero, partial: true }]) {
      const fb = fallbackScript(f);
      expect(fb.caption).toContain("11월(집계 중)");
      expect(validateScript(f, fb)).toEqual({ ok: true, errors: [] });
    }
    expect(fallbackScript(facts).caption).not.toContain("집계 중");
  });
});
