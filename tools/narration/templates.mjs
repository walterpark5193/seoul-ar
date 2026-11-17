// 고정 문구 해설 (CONTRACTS-stage 5.2). 4 + prompt 25 + result 150 + none 25 = 204.
import { NARRATION_IDS, NATIVE_COUNT } from "./ids.mjs";

export function templateLines(gus, month) { // eslint-disable-line no-unused-vars
  const lines = [
    { id: NARRATION_IDS.hello, caption: "무대를 시작합니다. 손을 들어 서울을 움직여 보세요.", speech: "무대를 시작합니다. 손을 들어 서울을 움직여 보세요." },
    {
      id: NARRATION_IDS.spread,
      caption: "25개 구를 ㎡당 가격순으로 펼쳤습니다. 왼쪽이 가장 비쌉니다.",
      speech: "스물다섯 개 구를 제곱미터당 가격순으로 펼쳤습니다. 왼쪽이 가장 비쌉니다.",
    },
    { id: NARRATION_IDS.mapBack, caption: "다시 지도로 돌아왔습니다.", speech: "다시 지도로 돌아왔습니다." },
    { id: NARRATION_IDS.voteIntro, caption: "투표를 시작합니다. 보고 싶은 구에 손을 들어 주세요.", speech: "투표를 시작합니다. 보고 싶은 구에 손을 들어 주세요." },
  ];
  for (const gu of gus) {
    const t = `${gu} 보고 싶은 분, 손 들어 주세요.`;
    lines.push({ id: NARRATION_IDS.votePrompt(gu), caption: t, speech: t });
  }
  for (const gu of gus) {
    for (let n = 1; n <= 6; n++) {
      lines.push({
        id: NARRATION_IDS.voteResult(gu, n),
        caption: `${n}표로 ${gu}가 뽑혔습니다.`,
        speech: `${NATIVE_COUNT[n]} 표로 ${gu}가 뽑혔습니다.`,
      });
    }
  }
  for (const gu of gus) {
    const t = `아무도 손을 들지 않아 ${gu}로 갑니다.`;
    lines.push({ id: NARRATION_IDS.voteNone(gu), caption: t, speech: t });
  }
  return lines;
}
