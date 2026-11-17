// 저장소에 실린 해설 생성물(scripts.json, manifest.json, mp3)이 현재 데이터·서로와 맞는지 확인한다.
// 구 해설은 데이터 스냅샷(index.months)의 모든 달 × 25개 구를 덮는다.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { templateLines } from "./templates.mjs";
import { speechHash } from "./synth.mjs";
import { mp3DurationMs } from "./mp3.mjs";
import { buildFacts } from "./facts.mjs";
import { validateScript, speechFromCaption } from "./write.mjs";
import { GU_ORDER } from "../data/gu.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = join(repo, "frontend/public/data");
const narrDir = join(repo, "frontend/public/narration");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const index = readJson(join(dataDir, "index.json"));
const scripts = readJson(join(repo, "tools/narration/scripts.json"));
const manifest = readJson(join(narrDir, "manifest.json"));
const months = index.months;
const TEMPLATE_COUNT = 204;
const lines = [
  ...templateLines(index.gus, months.at(-1)),
  ...Object.entries(scripts.items).map(([id, s]) => ({ id, caption: s.caption, speech: s.speech })),
];

// 달마다 사실표(구 이름 → Facts)
const factsByMonth = Object.fromEntries(months.map((month) => {
  const byName = {};
  for (const gu of GU_ORDER) byName[gu] = readJson(join(dataDir, month, `${gu}.json`));
  return [month, Object.fromEntries(buildFacts(index, byName, month).map((f) => [f.gu, f]))];
}));
const guItems = () => Object.entries(scripts.items).map(([id, s]) => {
  const [, month, gu] = id.match(/^gu-(\d{6})-(.+)$/) ?? [];
  return { id, month, gu, s, f: factsByMonth[month]?.[gu] };
});

describe("실린 manifest", () => {
  it(`id가 templateLines + scripts와 정확히 같다(템플릿 ${TEMPLATE_COUNT} + 달 수 × 25)`, () => {
    expect(Object.keys(manifest.items).sort()).toEqual(lines.map((l) => l.id).sort());
    expect(lines.length).toBe(TEMPLATE_COUNT + months.length * GU_ORDER.length);
  });
  it("caption과 hash가 문장과 맞고 파일이 있다", () => {
    for (const l of lines) {
      const it = manifest.items[l.id];
      expect(it.file, l.id).toBe(`${l.id}.mp3`);
      expect(it.caption, l.id).toBe(l.caption);
      expect(it.hash, l.id).toBe(speechHash(l.speech, manifest.voice, manifest.engine));
      expect(existsSync(join(narrDir, it.file)), l.id).toBe(true);
    }
  });
  it("모든 항목에 ms가 있고 mp3 실제 길이와 같다", () => {
    for (const [id, it] of Object.entries(manifest.items)) {
      expect(Number.isInteger(it.ms) && it.ms > 0, id).toBe(true);
      expect(it.ms, id).toBe(mp3DurationMs(readFileSync(join(narrDir, it.file))));
    }
  });
});

describe("실린 scripts.json", () => {
  const check = (gu, caption, month = "202611") => validateScript(factsByMonth[month][gu], { caption });

  it("스냅샷의 모든 달 × 25개 구 해설이 정확히 있다(빠지거나 남는 id 없음)", () => {
    const want = months.flatMap((m) => GU_ORDER.map((gu) => `gu-${m}-${gu}`)).sort();
    expect(Object.keys(scripts.items).sort()).toEqual(want);
  });
  it("모든 구 해설이 그 달 사실표로 validateScript를 통과한다", () => {
    for (const { id, s, f } of guItems()) {
      expect(validateScript(f, s), `${id}: ${s.caption}`).toEqual({ ok: true, errors: [] });
    }
  });
  it("speech는 caption에서 유도한 것과 같다(자막과 음성이 어긋나지 않음)", () => {
    for (const [id, s] of Object.entries(scripts.items)) expect(s.speech, id).toBe(speechFromCaption(s.caption));
  });
  it('들리는 그대로 참: 면적당 금액엔 "㎡당", "21.0억" 같은 소수 없음, 달·연도가 그 달', () => {
    for (const { id, month, s, f } of guItems()) {
      const c = s.caption;
      expect(c, id).not.toMatch(/\d+\.0\s*억/);
      for (const m of c.matchAll(/(?<![\d.,])(\d+)\s*월/g)) expect(m[1], `${id}: ${c}`).toBe(String(Number(month.slice(4))));
      for (const m of c.matchAll(/(?<![\d.,])(\d+)\s*년/g)) expect(m[1], `${id}: ${c}`).toBe(month.slice(0, 4));
      // ㎡당 중위값(구·동)인 금액은 같은 문장에서 그 금액 앞(앞 금액이나 동 이름 뒤)에 "㎡당"이 있어야 한다
      for (const sen of c.split(/(?<=[.!?])(?!\d)/)) {
        let from = 0;
        for (const m of sen.matchAll(/(?<![\d.,])(\d[\d,]*)\s*만\s*원/g)) {
          const v = Number(m[1].replaceAll(",", ""));
          const dongAt = [...sen.slice(0, m.index).matchAll(/[가-힣]+동(?:\d+가)?/g)].at(-1)?.index ?? 0;
          const seg = sen.slice(Math.max(from, dongAt), m.index);
          from = m.index + m[0].length;
          const perArea = v === f.medPerM2 || v === f.topDongMedPerM2;
          if (perArea && v !== f.maxAmt) expect(seg, `${id}: ${c}`).toMatch(/㎡당/);
        }
      }
    }
  });
  it("리뷰어 반례 4개는 모두 거절된다(2026년 11월 데이터)", () => {
    const bad = [
      ["서초구", "서초구 11월(집계 중) 거래는 22건, ㎡당 중위 1,220만 원으로 7위입니다. 방배동이 ㎡당 중위 2,704만 원으로 가장 높습니다."],
      ["중구", "중구는 11월(집계 중) 19건이 거래됐고 ㎡당 중위 1,701만 원으로 25개 구 중 1위입니다."],
      ["강남구", "강남구는 11월(집계 중) 40건이 거래됐고 최고 거래가는 25억 원이었습니다."],
      ["마포구", "마포구는 11월(집계 중) 31건이 거래됐고 ㎡당 중위 1,001만 원으로 서울에서 가장 비쌉니다."],
    ];
    for (const [gu, caption] of bad) expect(check(gu, caption).ok, `${gu}: ${caption}`).toBe(false);
  });
  it("반례를 사실대로 고치면 통과한다(검사가 과하지 않음)", () => {
    const good = [
      ["서초구", "서초구 11월(집계 중) 거래는 22건, ㎡당 중위 1,220만 원으로 7위입니다. 3건 이상 거래된 동 중 방배동이 ㎡당 2,704만 원으로 가장 높습니다."],
      ["중구", "중구는 11월(집계 중) 19건이 거래됐고 ㎡당 중위 1,701만 원으로 25개 구 중 3위입니다."],
      ["강남구", "강남구는 11월(집계 중) 40건이 거래됐고 최고 거래가는 66.0억 원이었습니다."],
      ["마포구", "마포구는 11월(집계 중) 31건이 거래됐고 ㎡당 중위 1,001만 원으로 25개 구 중 17위입니다."],
    ];
    for (const [gu, caption] of good) expect(check(gu, caption), `${gu}: ${caption}`).toEqual({ ok: true, errors: [] });
  });
});

describe("실린 scripts.json: 데이터 리뷰(2026-11-17) 회귀", () => {
  // 공동 순위인데 GU_ORDER 순서로 한 계단 낮게 말하던 6개(리뷰 C1)와 공동 최고 동을 단독 최고로 말하던 1개(M1)의 옛 문장
  const OLD = {
    "gu-202401-서대문구": "2024년 1월 서대문구 ㎡당 중위 945만 원은 25개 구 중 14위입니다. 거래 3건 이상인 동 가운데 북아현동이 ㎡당 1,496만 원으로 가장 높습니다.",
    "gu-202404-양천구": "4월 양천구는 262건 거래, ㎡당 중위 896만 원, 25개 구 중 16위입니다. 거래 3건 이상인 동 가운데 신정동이 ㎡당 1,118만 원으로 가장 높습니다.",
    "gu-202409-강동구": "2024년 9월 강동구는 ㎡당 중위 1,088만 원으로 12위입니다. 거래 3건 이상인 동 가운데 고덕동이 ㎡당 1,859만 원으로 가장 높습니다.",
    "gu-202412-은평구": "12월 은평구 ㎡당 중위 가격은 731만 원으로 25개 구 중 23위였습니다. 거래 3건 이상인 동 가운데 수색동이 ㎡당 1,401만 원으로 가장 높았습니다.",
    "gu-202603-관악구": "2026년 3월 관악구 ㎡당 중위 가격은 860만 원으로 25개 구 중 21위입니다. 거래 3건 이상인 동 가운데 봉천동이 ㎡당 901만 원으로 가장 높습니다.",
    "gu-202605-구로구": "5월 구로구 거래는 908건, ㎡당 중위 1,026만 원(18위)입니다. 거래 3건 이상인 동 가운데 신도림동이 ㎡당 중위 1,512만 원으로 가장 높습니다.",
    "gu-202603-성동구": "3월 성동구 ㎡당 중위 가격은 1,895만 원으로 25개 구 중 1위입니다. 거래 3건 이상인 동 가운데 금호동3가가 ㎡당 2,335만 원으로 가장 높습니다.",
  };
  const RANK = { "gu-202401-서대문구": 13, "gu-202404-양천구": 15, "gu-202409-강동구": 11, "gu-202412-은평구": 22, "gu-202603-관악구": 20, "gu-202605-구로구": 17 };
  const factsOf = (id) => { const [, month, gu] = id.match(/^gu-(\d{6})-(.+)$/); return factsByMonth[month][gu]; };

  it("옛 문장은 지금 사실표로 거절되고, 실린 문장은 바뀌었다", () => {
    for (const [id, caption] of Object.entries(OLD)) {
      expect(validateScript(factsOf(id), { caption }).ok, id).toBe(false);
      expect(scripts.items[id].caption, id).not.toBe(caption);
    }
  });
  it("공동 순위 6개는 공유 순위를 말한다(공동 N위)", () => {
    for (const [id, rank] of Object.entries(RANK)) {
      expect(factsOf(id)).toMatchObject({ rankPrice: rank, rankTied: true });
      expect(scripts.items[id].caption, id).toContain(`공동 ${rank}위`);
    }
  });
  it("공동 순위인 구의 문장이 말하는 순위는 짝과 같다", () => {
    for (const { id, s, f } of guItems()) {
      if (!f.rankTied) continue;
      for (const m of s.caption.matchAll(/(?<![\d.,])(\d+)\s*위/g)) expect(Number(m[1]), `${id}: ${s.caption}`).toBe(f.rankPrice);
    }
  });
  it("공동 최고 동(2026년 3월 성동구)은 한 동만 가장 높다고 하지 않는다", () => {
    const s = scripts.items["gu-202603-성동구"].caption;
    expect(factsOf("gu-202603-성동구").topDongTiedWith).toEqual(["행당동"]);
    expect(s).toContain("행당동");
    expect(s).toMatch(/함께|공동/);
  });
  it('집계 중인 달(generatedAt이 그 달)은 모든 구 해설이 "N월(집계 중)"으로 표시한다', () => {
    const partial = months.filter((m) => Object.values(factsByMonth[m]).some((f) => f.partial));
    expect(partial).toEqual(["202611"]);
    for (const { id, month, s, f } of guItems()) {
      if (f.partial) {
        expect(s.caption, id).toContain(`${Number(month.slice(4))}월(집계 중)`);
        expect(s.source, id).toBe("edited");
      } else {
        expect(s.caption, id).not.toContain("집계 중");
      }
    }
  });
});
