// MP3 길이 측정: ID3v2를 건너뛰고 MPEG 오디오 프레임 헤더를 따라가며 샘플 수를 더한다.
// manifest 5.1의 ms 필드(해설 클립 길이)를 재합성 없이 파일에서 얻기 위해 쓴다. 외부 의존 없음.

// kbps. [MPEG-1 | MPEG-2·2.5][Layer I·II·III], 인덱스 0(free)·15(bad)는 쓰지 않는다.
const BITRATES = {
  v1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  v2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
// 버전 비트 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5 (1은 예약)
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function frameAt(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3;
  const layer = 4 - ((b[i + 1] >> 1) & 3);
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (ver === 1 || layer === 4 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const bitrate = BITRATES[ver === 3 ? "v1" : "v2"][layer][brIdx] * 1000;
  const sr = SAMPLE_RATES[ver][srIdx];
  const pad = (b[i + 2] >> 1) & 1;
  const spf = layer === 1 ? 384 : layer === 2 || ver === 3 ? 1152 : 576;
  const len = layer === 1 ? (Math.floor((12 * bitrate) / sr) + pad) * 4 : Math.floor(((spf / 8) * bitrate) / sr) + pad;
  const crc = (b[i + 1] & 1) === 0;
  const mono = b[i + 3] >> 6 === 3;
  return { len, spf, sr, ver, layer, crc, mono };
}

function ascii(b, i, n) {
  let s = "";
  for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
  return s;
}

// LAME/FFmpeg의 Xing·Info, Fraunhofer VBRI 헤더 프레임은 소리가 없는 메타데이터 프레임이다.
function isInfoFrame(b, i, h) {
  if (h.layer !== 3) return false;
  const side = h.ver === 3 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
  const at = i + 4 + (h.crc ? 2 : 0) + side;
  const tag = ascii(b, at, 4);
  return tag === "Xing" || tag === "Info" || ascii(b, i + 36, 4) === "VBRI";
}

function skipId3v2(b) {
  let i = 0;
  while (ascii(b, i, 3) === "ID3" && i + 10 <= b.length) {
    const size = ((b[i + 6] & 0x7f) << 21) | ((b[i + 7] & 0x7f) << 14) | ((b[i + 8] & 0x7f) << 7) | (b[i + 9] & 0x7f);
    const footer = b[i + 5] & 0x10 ? 10 : 0;
    i += 10 + size + footer;
  }
  return i;
}

// 프레임이 아닌 바이트를 만나면 다음 "프레임 두 개가 이어지는" 자리(또는 파일 끝에서 끝나는 프레임)를 찾는다.
function resync(b, from) {
  for (let j = from; j + 4 <= b.length; j++) {
    const h = frameAt(b, j);
    if (!h || j + h.len > b.length) continue;
    if (j + h.len === b.length || frameAt(b, j + h.len)) return j;
  }
  return -1;
}

/** MP3 바이트의 재생 길이(ms, 반올림). MP3 프레임이 없으면 0. */
export function mp3DurationMs(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let i = skipId3v2(b);
  let seconds = 0;
  let first = true;
  while (i + 4 <= b.length) {
    if (ascii(b, i, 3) === "TAG") break; // ID3v1(끝 128바이트)
    let h = frameAt(b, i);
    if (!h) {
      const j = resync(b, i + 1);
      if (j < 0) break;
      i = j;
      h = frameAt(b, i);
    }
    if (i + h.len > b.length) break; // 잘린 마지막 프레임
    if (!(first && isInfoFrame(b, i, h))) seconds += h.spf / h.sr;
    first = false;
    i += h.len;
  }
  return Math.round(seconds * 1000);
}
