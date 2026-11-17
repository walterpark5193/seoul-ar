// 해설 재생기: manifest의 id로 MP3를 재생하고 자막을 알린다. 오디오와 타이머는 주입받는다.
export interface NarrationItem { file: string; caption: string; hash?: string; ms?: number; }
export interface NarrationManifest { v: 1; voice: string; engine: string; items: Record<string, NarrationItem>; }
export interface AudioLike { src: string; muted: boolean; play(): Promise<void>; pause(): void; onended: (() => void) | null; onerror: (() => void) | null; }
export interface Narrator {
  say(id: string, opts?: { interrupt?: boolean; protect?: boolean }): void; stop(): void;
  setMuted(m: boolean): void; readonly muted: boolean;
  onCaption(cb: (text: string | null) => void): () => void;
  /** 사용자 입력 처리 안에서 부른다. 무음 클립을 한 번 재생해 브라우저 자동 재생 잠금을 푼다. */
  unlock(): Promise<void>;
  /** 클립 길이(ms): manifest의 ms, 없으면 자막 글자 수 × 150ms. 모르는 id나 manifest가 없으면 null. */
  clipMs(id: string): number | null;
  /** 브라우저가 재생을 막았다(NotAllowedError). 막힌 동안 한 번만 알린다. */
  onBlocked(cb: () => void): () => void;
  /** 막힌 상태. 잠금 해제나 재생이 성공하면 풀린다. */
  readonly blocked: boolean;
}
type Timers = { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
interface Entry { id: string; item: NarrationItem; protect: boolean; }

const CAPTION_LINGER_MS = 1500;
const MISSING_MIN_MS = 2500;
/** 클립 길이를 모를 때 자막 한 글자당 읽는 시간 */
export const CHAR_MS = 150;
/** 잠금 해제용 무음 WAV(8kHz 8비트 모노 10ms) */
export const SILENT_WAV = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

const captionMs = (item: NarrationItem): number => [...item.caption].length * CHAR_MS;
const isNotAllowed = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { name?: unknown }).name === "NotAllowedError";

export function createNarrator(
  manifest: NarrationManifest | null,
  deps: { createAudio(): AudioLike; base?: string; timers?: Timers },
): Narrator {
  const base = deps.base ?? "/narration/";
  const timers: Timers = deps.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const listeners = new Set<(t: string | null) => void>();
  const blockedListeners = new Set<() => void>();
  const warned = new Set<string>();
  let blocked = false;
  let audio: AudioLike | null = null;
  let muted = false;
  let current: Entry | null = null;
  let queue: Entry[] = [];
  let token = 0; // 끊긴 재생의 늦은 콜백을 무시하기 위한 번호
  let stepTimer: unknown = null; // 오류 시 다음으로 넘어가기까지의 타이머
  let clearTimer: unknown = null; // 자막 지우기 타이머

  const getAudio = (): AudioLike => (audio ??= deps.createAudio());
  const emit = (t: string | null) => { for (const cb of [...listeners]) cb(t); };
  const markBlocked = () => {
    if (blocked) return;
    blocked = true;
    for (const cb of [...blockedListeners]) cb();
  };
  const cancel = (h: unknown) => { if (h !== null) timers.clear(h); };

  function detach() {
    token++;
    cancel(stepTimer); stepTimer = null;
    if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); }
  }

  function finish(delayCaption: boolean) {
    current = null;
    if (queue.length) { playNext(); return; }
    cancel(clearTimer);
    if (delayCaption) {
      clearTimer = timers.set(() => { clearTimer = null; emit(null); }, CAPTION_LINGER_MS);
    } else { clearTimer = null; emit(null); }
  }

  function playNext() {
    const entry = queue.shift();
    if (!entry) return;
    current = entry;
    cancel(clearTimer); clearTimer = null;
    const my = ++token;
    emit(entry.item.caption);
    const a = getAudio();
    a.muted = muted;
    a.src = base + entry.item.file;
    // 소리가 안 나면 자막만 읽을 만큼 보여 주고 넘어간다.
    const fail = () => {
      if (my !== token) return;
      a.onended = null; a.onerror = null;
      stepTimer = timers.set(() => { stepTimer = null; if (my === token) finish(false); },
        Math.max(entry.item.ms ?? 0, captionMs(entry.item), MISSING_MIN_MS));
    };
    const rejected = (err: unknown) => {
      if (my === token && isNotAllowed(err)) markBlocked();
      fail();
    };
    a.onended = () => { if (my !== token) return; a.onended = null; a.onerror = null; finish(true); };
    a.onerror = fail;
    let p: Promise<void> | undefined;
    try { p = a.play(); } catch (err) { rejected(err); return; }
    p?.then(() => { if (my === token) blocked = false; }, rejected);
  }

  return {
    say(id, opts) {
      if (!manifest) return;
      const item = manifest.items[id];
      if (!item) {
        if (!warned.has(id)) { warned.add(id); console.warn(`narrator: unknown id ${id}`); }
        return;
      }
      const entry: Entry = { id, item, protect: !!opts?.protect };
      if (!opts?.interrupt) { queue.push(entry); if (!current) playNext(); return; }
      if (current?.protect) { queue.unshift(entry); return; }
      if (current) detach();
      current = null;
      queue = [entry];
      playNext();
    },
    stop() {
      detach();
      current = null; queue = [];
      cancel(clearTimer); clearTimer = null;
      emit(null);
    },
    setMuted(m) { muted = m; if (audio) audio.muted = m; },
    get muted() { return muted; },
    onCaption(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async unlock() {
      const a = getAudio();
      // 지금 클립을 재생하는 중이면(재생 시도 중 포함) 건드리지 않는다. 실패해 자막만 보이는 중(stepTimer)이면 시도한다.
      if (current && stepTimer === null) return;
      const my = token;
      const prevSrc = a.src;
      // 무음 파일이라 음소거 없이 재생한다(음소거 재생은 사용자 허락으로 치지 않는 브라우저가 있다).
      a.muted = false;
      a.src = SILENT_WAV;
      let ok = false;
      try { await a.play(); ok = true; } catch { /* 아직 막힘: 다음 사용자 입력에서 다시 */ }
      if (ok) blocked = false;
      if (my !== token) return; // 기다리는 사이 새 클립이 시작됐다
      a.pause();
      a.src = prevSrc;
      a.muted = muted;
    },
    clipMs(id) {
      const item = manifest?.items[id];
      if (!item) return null;
      return item.ms ?? captionMs(item);
    },
    onBlocked(cb) { blockedListeners.add(cb); return () => { blockedListeners.delete(cb); }; },
    get blocked() { return blocked; },
  };
}

export async function loadManifest(fetchImpl: typeof fetch = fetch): Promise<NarrationManifest | null> {
  try {
    const res = await fetchImpl("/narration/manifest.json");
    if (!res.ok) return null;
    const m = await res.json() as NarrationManifest;
    if (!m || m.v !== 1 || typeof m.voice !== "string" || typeof m.engine !== "string") return null;
    if (!m.items || typeof m.items !== "object" || Array.isArray(m.items)) return null;
    for (const it of Object.values(m.items)) {
      if (!it || typeof it.file !== "string" || typeof it.caption !== "string") return null;
    }
    return m;
  } catch { return null; }
}
