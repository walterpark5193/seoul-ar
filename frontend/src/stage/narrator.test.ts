import { describe, it, expect, vi } from "vitest";
import { createNarrator, loadManifest, type AudioLike, type NarrationManifest } from "./narrator";

class FakeAudio implements AudioLike {
  src = ""; muted = false; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  played: string[] = []; pauses = 0;
  async play() { this.played.push(this.src); }
  pause() { this.pauses++; }
}
function fakeTimers() {
  let now = 0, seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn: () => void, ms: number) { const h = ++seq; q.set(h, { at: now + ms, fn }); return h; },
    clear(h: unknown) { q.delete(h as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
const manifest: NarrationManifest = {
  v: 1, voice: "Seoyeon", engine: "neural",
  items: {
    a: { file: "a.mp3", caption: "에이" }, b: { file: "b.mp3", caption: "비" },
    c: { file: "c.mp3", caption: "씨" }, m: { file: "m.mp3", caption: "없음", ms: 4000 },
  },
};
function setup(mf: NarrationManifest | null = manifest) {
  const audio = new FakeAudio(); const timers = fakeTimers();
  const n = createNarrator(mf, { createAudio: () => audio, timers });
  const caps: (string | null)[] = []; n.onCaption((t) => caps.push(t));
  return { audio, timers, n, caps };
}

describe("narrator", () => {
  it("plays file from base", () => {
    const { audio, n } = setup(); n.say("a");
    expect(audio.src).toBe("/narration/a.mp3"); expect(audio.played).toEqual(["/narration/a.mp3"]);
  });
  it("caption on start and cleared 1500ms after end", () => {
    const { audio, timers, n, caps } = setup(); n.say("a");
    expect(caps).toEqual(["에이"]);
    audio.onended!(); timers.advance(1499); expect(caps).toEqual(["에이"]);
    timers.advance(1); expect(caps).toEqual(["에이", null]);
  });
  it("interrupt stops current", () => {
    const { audio, n, caps } = setup(); n.say("a"); n.say("c"); n.say("b", { interrupt: true });
    expect(audio.pauses).toBe(1); expect(audio.src).toBe("/narration/b.mp3");
    expect(caps).toEqual(["에이", "비"]);
    audio.onended!(); expect(audio.played).toEqual(["/narration/a.mp3", "/narration/b.mp3"]); // 큐 비워짐
  });
  it("protected not interrupted", () => {
    const { audio, n } = setup(); n.say("a", { protect: true }); n.say("c");
    n.say("b", { interrupt: true });
    expect(audio.src).toBe("/narration/a.mp3"); expect(audio.pauses).toBe(0);
    audio.onended!(); expect(audio.src).toBe("/narration/b.mp3");
    audio.onended!(); expect(audio.src).toBe("/narration/c.mp3");
  });
  it("queue order", () => {
    const { audio, n } = setup(); n.say("a"); n.say("b"); n.say("c");
    audio.onended!(); audio.onended!();
    expect(audio.played).toEqual(["/narration/a.mp3", "/narration/b.mp3", "/narration/c.mp3"]);
  });
  it("missing file shows caption then continues", () => {
    const { audio, timers, n, caps } = setup(); n.say("a"); n.say("b");
    audio.onerror!(); timers.advance(2499); expect(audio.src).toBe("/narration/a.mp3");
    timers.advance(1); expect(audio.src).toBe("/narration/b.mp3"); expect(caps).toEqual(["에이", "비"]);
  });
  it("missing file waits item.ms when longer", () => {
    const { audio, timers, n } = setup(); n.say("m"); n.say("b");
    audio.onerror!(); timers.advance(3999); expect(audio.src).toBe("/narration/m.mp3");
    timers.advance(1); expect(audio.src).toBe("/narration/b.mp3");
  });
  it("unknown id skipped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { audio, n, caps } = setup(); n.say("zzz"); n.say("zzz"); n.say("a");
    expect(warn).toHaveBeenCalledTimes(1); expect(caps).toEqual(["에이"]); expect(audio.played).toEqual(["/narration/a.mp3"]);
    warn.mockRestore();
  });
  it("muted still captions", () => {
    const { audio, timers, n, caps } = setup(); n.setMuted(true); n.say("a"); n.say("b");
    expect(n.muted).toBe(true); expect(audio.muted).toBe(true); expect(caps).toEqual(["에이"]);
    audio.onended!(); expect(caps).toEqual(["에이", "비"]); timers.advance(0);
  });
  it("null manifest is silent", () => {
    const { audio, n, caps } = setup(null); n.say("a"); n.stop();
    expect(audio.played).toEqual([]); expect(caps).toEqual([null].slice(0, 1));
  });
  it("stop clears queue and caption; late ended ignored", () => {
    const { audio, n, caps } = setup(); n.say("a"); n.say("b"); const end = audio.onended; n.stop();
    expect(caps).toEqual(["에이", null]); expect(audio.onended).toBeNull(); end?.();
    expect(audio.played).toEqual(["/narration/a.mp3"]);
  });
  it("unlock plays muted and restores", async () => {
    const { audio, n } = setup(); await n.unlock();
    expect(audio.played.length).toBe(1); expect(audio.pauses).toBe(1); expect(audio.muted).toBe(false);
  });
});

describe("loadManifest", () => {
  const f = (r: Partial<Response> & { json?: () => Promise<unknown> }) => (async () => r as Response) as unknown as typeof fetch;
  it("returns manifest", async () => {
    expect(await loadManifest(f({ ok: true, json: async () => manifest }))).toEqual(manifest);
  });
  it("404 -> null", async () => { expect(await loadManifest(f({ ok: false, status: 404 }))).toBeNull(); });
  it("bad shape -> null", async () => {
    expect(await loadManifest(f({ ok: true, json: async () => ({ v: 2, items: {} }) }))).toBeNull();
    expect(await loadManifest(f({ ok: true, json: async () => ({ v: 1, voice: "x", engine: "y", items: { a: { file: 1 } } }) }))).toBeNull();
  });
  it("network error -> null", async () => {
    expect(await loadManifest((async () => { throw new Error("x"); }) as unknown as typeof fetch)).toBeNull();
  });
});
