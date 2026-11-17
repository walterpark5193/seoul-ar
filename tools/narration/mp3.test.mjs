import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mp3DurationMs } from "./mp3.mjs";

// MPEG-2 Layer III, 보호 없음, 48kbps, 24000Hz, 모노: 프레임 144바이트, 576샘플 = 24ms (Polly 출력과 같은 형식)
function mpeg2Frame({ pad = 0, fill = 0x55 } = {}) {
  const len = 144 + pad;
  const f = new Uint8Array(len).fill(fill);
  f.set([0xff, 0xf3, 0x64 | (pad << 1), 0xc4]);
  return f;
}
// MPEG-1 Layer III, 128kbps, 44100Hz, 스테레오: 417(+1)바이트, 1152샘플
function mpeg1Frame({ pad = 0 } = {}) {
  const len = 417 + pad;
  const f = new Uint8Array(len).fill(0x11);
  f.set([0xff, 0xfb, 0x90 | (pad << 1), 0x00]);
  return f;
}
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const frames = (n, make) => cat(...Array.from({ length: n }, (_, i) => make(i)));
function id3v2(bodyLen) {
  // syncsafe 크기(7비트씩)
  const h = new Uint8Array(10 + bodyLen);
  h.set([0x49, 0x44, 0x33, 4, 0, 0, (bodyLen >> 21) & 0x7f, (bodyLen >> 14) & 0x7f, (bodyLen >> 7) & 0x7f, bodyLen & 0x7f]);
  return h;
}

describe("mp3DurationMs", () => {
  it("MPEG-2 Layer III 프레임 10개 = 240ms", () => {
    expect(mp3DurationMs(frames(10, () => mpeg2Frame()))).toBe(240);
  });
  it("앞의 ID3v2 태그(syncsafe 크기 > 127)를 건너뛴다", () => {
    expect(mp3DurationMs(cat(id3v2(300), frames(10, () => mpeg2Frame())))).toBe(240);
  });
  it("패딩 비트가 있는 프레임 길이를 따른다(MPEG-1 128kbps 44.1kHz)", () => {
    const b = frames(50, (i) => mpeg1Frame({ pad: i % 2 }));
    expect(mp3DurationMs(b)).toBe(Math.round((50 * 1152 * 1000) / 44100));
  });
  it("첫 프레임이 Xing/Info 헤더면 세지 않는다", () => {
    const info = mpeg2Frame({ fill: 0 });
    info.set([0x49, 0x6e, 0x66, 0x6f], 4 + 9); // MPEG-2 모노 side info 9바이트 뒤 "Info"
    expect(mp3DurationMs(cat(info, frames(10, () => mpeg2Frame())))).toBe(240);
  });
  it("끝의 ID3v1 TAG와 잘린 마지막 프레임은 세지 않는다", () => {
    const tag = new Uint8Array(128); tag.set([0x54, 0x41, 0x47]);
    expect(mp3DurationMs(cat(frames(10, () => mpeg2Frame()), tag))).toBe(240);
    expect(mp3DurationMs(cat(frames(10, () => mpeg2Frame()), mpeg2Frame().slice(0, 60)))).toBe(240);
  });
  it("프레임 사이 잡음 몇 바이트는 다음 프레임에 다시 맞춘다", () => {
    expect(mp3DurationMs(cat(frames(5, () => mpeg2Frame()), new Uint8Array([0, 0, 0]), frames(5, () => mpeg2Frame())))).toBe(240);
  });
  it("MP3가 아니면 0", () => {
    expect(mp3DurationMs(new Uint8Array([1, 2, 3, 4]))).toBe(0);
    expect(mp3DurationMs(new Uint8Array(0))).toBe(0);
    expect(mp3DurationMs(new TextEncoder().encode("<html>404</html>"))).toBe(0);
  });
  it("실제 해설 파일 stage-hello.mp3 = 3840ms (프레임 160개)", () => {
    const p = fileURLToPath(new URL("../../frontend/public/narration/stage-hello.mp3", import.meta.url));
    expect(mp3DurationMs(readFileSync(p))).toBe(3840);
  });
});
