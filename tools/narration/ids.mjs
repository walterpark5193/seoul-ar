// 해설 id (CONTRACTS-stage 3.2 NARRATION_IDS와 같은 구조). 프런트 effects.ts와 글자 하나까지 같아야 한다.
export const NARRATION_IDS = {
  hello: "stage-hello",
  spread: "spread-intro",
  mapBack: "map-back",
  voteIntro: "vote-intro",
  gu: (month, gu) => `gu-${month}-${gu}`,
  votePrompt: (gu) => `vote-prompt-${gu}`,
  voteResult: (gu, n) => `vote-result-${gu}-${n}`,
  voteNone: (gu) => `vote-none-${gu}`,
};

// 득표 수 고유어 낭독 (1~6표)
export const NATIVE_COUNT = ["", "한", "두", "세", "네", "다섯", "여섯"];
