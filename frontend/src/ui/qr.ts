// QR을 캔버스에 그린다(qrcode 패키지, 외부 호출 없음). 밝은 바탕에 어두운 점: 폰 카메라가 가장 잘 읽는다.
import QRCode from "qrcode";

export function drawQr(canvas: HTMLCanvasElement, text: string, size = 240): Promise<void> {
  return QRCode.toCanvas(canvas, text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#0b1020", light: "#f3f4f6" },
  });
}
