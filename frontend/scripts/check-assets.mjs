import { fileURLToPath } from "node:url";
import { checkModel } from "./assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const model = `${root}public/models/gesture_recognizer.task`;

const r = await checkModel(model);
if (r.ok) {
  console.log(`[assets] 손 인식 모델 확인 (${r.bytes} 바이트)`);
} else if (r.reason === "missing") {
  console.warn("[assets] 경고: public/models/gesture_recognizer.task 없음. 무대는 마우스 모드로 동작합니다. README의 '무대 모델 받기' 참고.");
} else {
  console.warn("[assets] 경고: gesture_recognizer.task가 zip 형식이 아닙니다(받다 만 파일일 수 있음). 무대는 마우스 모드로 동작합니다. 다시 받으세요.");
}
process.exit(0);
