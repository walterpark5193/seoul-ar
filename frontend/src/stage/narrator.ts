// 해설 재생기: manifest의 id로 MP3를 재생하고 자막을 알린다. 오디오와 타이머는 주입받는다.
export interface NarrationItem { file: string; caption: string; hash?: string; ms?: number; }
export interface NarrationManifest { v: 1; voice: string; engine: string; items: Record<string, NarrationItem>; }
export interface AudioLike { src: string; muted: boolean; play(): Promise<void>; pause(): void; onended: (() => void) | null; onerror: (() => void) | null; }
export interface Narrator {
  say(id: string, opts?: { interrupt?: boolean; protect?: boolean }): void; stop(): void;
  setMuted(m: boolean): void; readonly muted: boolean;
  onCaption(cb: (text: string | null) => void): () => void;
  unlock(): Promise<void>;
}
type Timers = { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
interface Entry { id: string; item: NarrationItem; protect: boolean; }

const CAPTION_LINGER_MS = 1500;
const MISSING_MIN_MS = 2500;

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
  const warned = new Set<string>();
  let audio: AudioLike | null = null;
  let muted = false;
  let current: Entry | null = null;
  let queue: Entry[] = [];
  let token = 0; // 끊긴 재생의 늦은 콜백을 무시하기 위한 번호
  let stepTimer: unknown = null; // 오류 시 다음으로 넘어가기까지의 타이머
  let clearTimer: unknown = null; // 자막 지우기 타이머

  const getAudio = (): AudioLike => (audio ??= deps.createAudio());
  const emit = (t: string | null) => { for (const cb of [...listeners]) cb(t); };
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
    const fail = () => {
      if (my !== token) return;
      a.onended = null; a.onerror = null;
      stepTimer = timers.set(() => { stepTimer = null; if (my === token) finish(false); },
        Math.max(entry.item.ms ?? 0, MISSING_MIN_MS));
    };
    a.onended = () => { if (my !== token) return; a.onended = null; a.onerror = null; finish(true); };
    a.onerror = fail;
    let p: Promise<void> | undefined;
    try { p = a.play(); } catch { fail(); return; }
    p?.catch(() => fail());
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
      if (current) return;
      a.muted = true;
      try { await a.play(); } catch { /* 무시 */ }
      if (!current) a.pause();
      a.muted = muted;
    },
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
