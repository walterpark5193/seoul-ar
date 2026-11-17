import { fileURLToPath } from "node:url";
import { checkModel } from "./assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const model = `${root}public/models/gesture_recognizer.task`;

let r;
try {
  r = await checkModel(model);
} catch (e) {
  console.warn(`[assets] 경고: 모델 파일을 확인하지 못했습니다(${e.code ?? e.message}). 무대는 마우스 모드로 동작합니다.`);
  process.exit(0);
}
if (r.ok) {
  console.log(`[assets] 손 인식 모델 확인 (${r.bytes} 바이트)`);
} else if (r.reason === "missing") {
  console.warn("[assets] 경고: public/models/gesture_recognizer.task 없음. 무대는 마우스 모드로 동작합니다. README의 '무대 모델 받기' 참고.");
} else if (r.reason === "not-file") {
  console.warn("[assets] 경고: public/models/gesture_recognizer.task가 파일이 아닙니다(디렉터리). 무대는 마우스 모드로 동작합니다.");
} else {
  console.warn("[assets] 경고: gesture_recognizer.task가 zip 형식이 아닙니다(받다 만 파일일 수 있음). 무대는 마우스 모드로 동작합니다. 다시 받으세요.");
}
process.exit(0);
