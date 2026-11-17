import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { templateLines } from "./templates.mjs";
import { NARRATION_IDS, NATIVE_COUNT } from "./ids.mjs";
import { GU_ORDER } from "../data/gu.mjs";

const MONTH = "202611";

describe("templateLines", () => {
  const lines = templateLines(GU_ORDER, MONTH);
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));

  it("templateLines count 204, id 중복 없음", () => {
    expect(lines).toHaveLength(204);
    expect(new Set(lines.map((l) => l.id)).size).toBe(204);
  });

  it("vote-result 고유어 낭독", () => {
    const l = byId["vote-result-강남구-2"];
    expect(l.caption).toBe("2표로 강남구가 뽑혔습니다.");
    expect(l.speech).toBe("두 표로 강남구가 뽑혔습니다.");
  });

  it("spread-intro 낭독은 제곱미터", () => {
    expect(byId["spread-intro"].speech).toContain("제곱미터");
    expect(byId["spread-intro"].caption).toContain("㎡");
  });

  it("고정 문구", () => {
    expect(byId["stage-hello"].caption).toBe("무대를 시작합니다. 손을 들어 서울을 움직여 보세요.");
    expect(byId["map-back"].caption).toBe("다시 지도로 돌아왔습니다.");
    expect(byId["vote-intro"].caption).toBe("투표를 시작합니다. 보고 싶은 구에 손을 들어 주세요.");
    expect(byId["vote-prompt-마포구"].caption).toBe("마포구 보고 싶은 분, 손 들어 주세요.");
    expect(byId["vote-none-마포구"].caption).toBe("아무도 손을 들지 않아 마포구로 갑니다.");
  });

  it("모든 문장에 undefined, NaN 없음", () => {
    for (const l of lines) {
      expect(l.caption + l.speech).not.toMatch(/undefined|NaN/);
      expect(l.caption.length).toBeGreaterThan(0);
      expect(l.speech.length).toBeGreaterThan(0);
    }
  });
});

describe("ids", () => {
  it("ids match frontend literals", () => {
    expect(NARRATION_IDS.hello).toBe("stage-hello");
    expect(NARRATION_IDS.spread).toBe("spread-intro");
    expect(NARRATION_IDS.mapBack).toBe("map-back");
    expect(NARRATION_IDS.voteIntro).toBe("vote-intro");
    expect(NARRATION_IDS.gu("202611", "강남구")).toBe("gu-202611-강남구");
    expect(NARRATION_IDS.votePrompt("강남구")).toBe("vote-prompt-강남구");
    expect(NARRATION_IDS.voteResult("강남구", 3)).toBe("vote-result-강남구-3");
    expect(NARRATION_IDS.voteNone("강남구")).toBe("vote-none-강남구");
    expect(NATIVE_COUNT).toEqual(["", "한", "두", "세", "네", "다섯", "여섯"]);
  });

  it("프런트 effects.ts가 있으면 같은 문자열 리터럴을 쓴다", () => {
    const f = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/src/stage/effects.ts");
    if (!fs.existsSync(f)) return;
    const src = fs.readFileSync(f, "utf8");
    for (const lit of ["stage-hello", "spread-intro", "map-back", "vote-intro", "vote-prompt-", "vote-result-", "vote-none-", "gu-"]) {
      expect(src).toContain(lit);
    }
  });
});
