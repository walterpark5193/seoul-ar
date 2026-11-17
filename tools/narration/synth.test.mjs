import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { speechHash, buildManifest, synthAll, mergeManifest, backfillMs } from "./synth.mjs";

const lines = [
  { id: "stage-hello", caption: "안녕", speech: "안녕하세요" },
  { id: "map-back", caption: "지도", speech: "다시 지도로" },
];
const BYTES = new Uint8Array([1, 2, 3, 4]);

function fakeClient({ failEngines = [] } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const input = cmd.input;
      calls.push(input);
      if (failEngines.includes(input.Engine)) throw new Error("engine unsupported");
      return { AudioStream: { transformToByteArray: async () => BYTES } };
    },
  };
}
const tmp = () => mkdtempSync(join(tmpdir(), "synth-"));
const opts = (o) => ({ retryDelayMs: 0, log: () => {}, ...o });

describe("synth", () => {
  it("speechHash stable 16 hex", () => {
    const h = speechHash("안녕", "Seoyeon", "generative");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(speechHash("안녕", "Seoyeon", "generative")).toBe(h);
    expect(speechHash("안녕", "Seoyeon", "neural")).not.toBe(h);
  });

  it("buildManifest shape", () => {
    const hashes = { "stage-hello": "aa", "map-back": "bb" };
    const m = buildManifest(lines, { voice: "Seoyeon", engine: "generative", hashes });
    expect(m).toEqual({
      v: 1, voice: "Seoyeon", engine: "generative",
      items: {
        "stage-hello": { file: "stage-hello.mp3", caption: "안녕", hash: "aa" },
        "map-back": { file: "map-back.mp3", caption: "지도", hash: "bb" },
      },
    });
  });

  it("synthesizes and writes mp3", async () => {
    const outDir = tmp(); const client = fakeClient();
    const r = await synthAll(lines, opts({ client, outDir }));
    expect(r.synthesized).toEqual(["stage-hello", "map-back"]);
    expect(r.failed).toEqual([]);
    expect([...readFileSync(join(outDir, "stage-hello.mp3"))]).toEqual([1, 2, 3, 4]);
    expect(client.calls[0]).toMatchObject({ OutputFormat: "mp3", LanguageCode: "ko-KR", VoiceId: "Seoyeon", Engine: "generative", Text: "안녕하세요" });
    expect(r.manifest.items["map-back"].file).toBe("map-back.mp3");
  });

  it("generative failure falls back to neural", async () => {
    const outDir = tmp(); const client = fakeClient({ failEngines: ["generative"] });
    const r = await synthAll(lines, opts({ client, outDir }));
    expect(r.failed).toEqual([]);
    expect(r.fallbacks).toEqual(["stage-hello", "map-back"]);
    expect(r.manifest.engine).toBe("generative");
    expect(r.manifest.items["stage-hello"].engine).toBeUndefined();
    expect(existsSync(join(outDir, "map-back.mp3"))).toBe(true);
    expect(client.calls.some((c) => c.Engine === "neural")).toBe(true);
  });

  it("reports failed when both engines fail", async () => {
    const outDir = tmp(); const client = fakeClient({ failEngines: ["generative", "neural"] });
    const r = await synthAll(lines, opts({ client, outDir }));
    expect(r.failed).toEqual(["stage-hello", "map-back"]);
    expect(Object.keys(r.manifest.items)).toEqual([]);
  });

  it("skips unchanged hash", async () => {
    const outDir = tmp();
    const first = await synthAll(lines, opts({ client: fakeClient(), outDir }));
    const client = fakeClient();
    const r = await synthAll(lines, opts({ client, outDir, previous: first.manifest }));
    expect(client.calls.length).toBe(0);
    expect(r.skipped).toEqual(["stage-hello", "map-back"]);
    expect(r.synthesized).toEqual([]);
    expect(r.manifest.items["stage-hello"].hash).toBe(first.manifest.items["stage-hello"].hash);
  });

  it("resynth when text changed", async () => {
    const outDir = tmp();
    const first = await synthAll(lines, opts({ client: fakeClient(), outDir }));
    const client = fakeClient();
    const changed = [{ ...lines[0], speech: "다른 문장" }, lines[1]];
    const r = await synthAll(changed, opts({ client, outDir, previous: first.manifest }));
    expect(client.calls.length).toBe(1);
    expect(r.synthesized).toEqual(["stage-hello"]);
    expect(r.skipped).toEqual(["map-back"]);
  });

  it("retries twice then succeeds; three failures per engine -> failed", async () => {
    const mk = (failTimes) => {
      let n = 0; const calls = [];
      return { calls, async send(cmd) {
        calls.push(cmd.input);
        if (n++ < failTimes) throw new Error("boom");
        return { AudioStream: { transformToByteArray: async () => BYTES } };
      } };
    };
    const one = [lines[0]];
    const c2 = mk(2);
    const r2 = await synthAll(one, opts({ client: c2, outDir: tmp() }));
    expect(r2.synthesized).toEqual(["stage-hello"]);
    expect(r2.fallbacks).toEqual([]);
    expect(c2.calls.length).toBe(3);
    const c6 = mk(6);
    const r6 = await synthAll(one, opts({ client: c6, outDir: tmp() }));
    expect(r6.failed).toEqual(["stage-hello"]);
    expect(c6.calls.length).toBe(6);
  });

  it("limits concurrency to 4", async () => {
    let inflight = 0, max = 0;
    const client = { async send() {
      inflight++; max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return { AudioStream: { transformToByteArray: async () => BYTES } };
    } };
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, caption: "c", speech: `s${i}` }));
    const r = await synthAll(many, opts({ client, outDir: tmp() }));
    expect(r.synthesized.length).toBe(20);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(4);
  });

  it("resynth when hash equal but file missing", async () => {
    const outDir = tmp();
    const first = await synthAll(lines, opts({ client: fakeClient(), outDir }));
    unlinkSync(join(outDir, "map-back.mp3"));
    const client = fakeClient();
    const r = await synthAll(lines, opts({ client, outDir, previous: first.manifest }));
    expect(r.synthesized).toEqual(["map-back"]);
    expect(r.skipped).toEqual(["stage-hello"]);
    expect(client.calls.length).toBe(1);
  });

  it("fallback item stores neural hash and is retried with generative next run", async () => {
    const outDir = tmp();
    const first = await synthAll([lines[0]], opts({ client: fakeClient({ failEngines: ["generative"] }), outDir }));
    expect(first.manifest.items["stage-hello"].hash).toBe(speechHash("안녕하세요", "Seoyeon", "neural"));
    const client = fakeClient();
    const r = await synthAll([lines[0]], opts({ client, outDir, previous: first.manifest }));
    expect(r.synthesized).toEqual(["stage-hello"]);
    expect(client.calls[0].Engine).toBe("generative");
    expect(r.fallbacks).toEqual([]);
  });

  it("mergeManifest keeps previous item for failed id when file exists", async () => {
    const outDir = tmp();
    const first = await synthAll(lines, opts({ client: fakeClient(), outDir }));
    const r = await synthAll(lines, opts({ client: fakeClient({ failEngines: ["generative", "neural"] }), outDir, previous: { ...first.manifest, items: { ...first.manifest.items, "stage-hello": { ...first.manifest.items["stage-hello"], hash: "old" } } } }));
    expect(r.failed).toEqual(["stage-hello"]);
    const merged = mergeManifest(r, first.manifest, outDir);
    expect(merged.items["stage-hello"]).toEqual(first.manifest.items["stage-hello"]);
    unlinkSync(join(outDir, "stage-hello.mp3"));
    expect(mergeManifest(r, first.manifest, outDir).items["stage-hello"]).toBeUndefined();
  });

  it("write error marks only that item failed", async () => {
    const r = await synthAll(lines, opts({ client: fakeClient(), outDir: join(tmp(), "a") , log: () => {} }));
    expect(r.failed).toEqual([]);
    const outDir = tmp();
    const bad = [{ id: "no/such/dir", caption: "c", speech: "s" }, lines[0]];
    const r2 = await synthAll(bad, opts({ client: fakeClient(), outDir }));
    expect(r2.failed).toEqual(["no/such/dir"]);
    expect(r2.synthesized).toEqual(["stage-hello"]);
  });
});

// MPEG-2 Layer III 48kbps 24kHz 프레임(24ms) n개
function mp3(n) {
  const out = new Uint8Array(144 * n).fill(0x55);
  for (let i = 0; i < n; i++) out.set([0xff, 0xf3, 0x64, 0xc4], i * 144);
  return out;
}
function mp3Client(n) {
  const calls = [];
  return { calls, async send(cmd) { calls.push(cmd.input); return { AudioStream: { transformToByteArray: async () => mp3(n) } }; } };
}

describe("synth ms", () => {
  it("buildManifest는 durations가 있으면 ms를 적는다", () => {
    const m = buildManifest(lines, { voice: "Seoyeon", engine: "generative", hashes: { "stage-hello": "aa" }, durations: { "stage-hello": 1234 } });
    expect(m.items["stage-hello"]).toEqual({ file: "stage-hello.mp3", caption: "안녕", hash: "aa", ms: 1234 });
    expect(m.items["map-back"].ms).toBeUndefined();
  });
  it("새로 합성한 항목은 MP3 길이를 ms로 기록한다", async () => {
    const r = await synthAll(lines, opts({ client: mp3Client(50), outDir: tmp() }));
    expect(r.manifest.items["stage-hello"].ms).toBe(1200);
    expect(r.manifest.items["map-back"].ms).toBe(1200);
  });
  it("건너뛴 항목은 이전 ms를 쓰고, 없으면 파일에서 잰다", async () => {
    const outDir = tmp();
    const first = await synthAll(lines, opts({ client: mp3Client(10), outDir }));
    const prev = { ...first.manifest, items: { ...first.manifest.items, "map-back": { ...first.manifest.items["map-back"] } } };
    prev.items["stage-hello"].ms = 999;
    delete prev.items["map-back"].ms;
    const client = mp3Client(10);
    const r = await synthAll(lines, opts({ client, outDir, previous: prev }));
    expect(client.calls.length).toBe(0);
    expect(r.manifest.items["stage-hello"].ms).toBe(999);
    expect(r.manifest.items["map-back"].ms).toBe(240);
  });
  it("MP3가 아니면 ms를 적지 않는다", async () => {
    const r = await synthAll([lines[0]], opts({ client: fakeClient(), outDir: tmp() }));
    expect(r.manifest.items["stage-hello"].ms).toBeUndefined();
  });
});

describe("backfillMs", () => {
  const base = (items) => ({ v: 1, voice: "Seoyeon", engine: "generative", items });
  it("파일에서 길이를 재서 채우고 원본은 바꾸지 않는다", () => {
    const outDir = tmp();
    writeFileSync(join(outDir, "a.mp3"), mp3(25));
    writeFileSync(join(outDir, "b.mp3"), mp3(10));
    const m = base({ a: { file: "a.mp3", caption: "가", hash: "h1" }, b: { file: "b.mp3", caption: "나", hash: "h2", ms: 1 } });
    const r = backfillMs(m, outDir);
    expect(r.manifest.items.a).toEqual({ file: "a.mp3", caption: "가", hash: "h1", ms: 600 });
    expect(r.manifest.items.b.ms).toBe(240);
    expect(r.filled).toEqual(["a", "b"]);
    expect(r.missing).toEqual([]);
    expect(m.items.a.ms).toBeUndefined();
    expect(r.manifest.voice).toBe("Seoyeon");
  });
  it("파일이 없거나 MP3가 아니면 missing·bad로 알리고 항목은 그대로 둔다", () => {
    const outDir = tmp();
    writeFileSync(join(outDir, "bad.mp3"), new Uint8Array([1, 2, 3]));
    const m = base({ gone: { file: "gone.mp3", caption: "가" }, bad: { file: "bad.mp3", caption: "나" } });
    const r = backfillMs(m, outDir);
    expect(r.missing).toEqual(["gone"]);
    expect(r.bad).toEqual(["bad"]);
    expect(r.manifest.items.gone).toEqual({ file: "gone.mp3", caption: "가" });
    expect(r.manifest.items.bad).toEqual({ file: "bad.mp3", caption: "나" });
  });
  it("CLI --backfill-ms는 합성 없이 manifest만 고쳐 쓴다", () => {
    const outDir = tmp();
    writeFileSync(join(outDir, "a.mp3"), mp3(5));
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(base({ a: { file: "a.mp3", caption: "가", hash: "h" } })));
    const script = fileURLToPath(new URL("./synth.mjs", import.meta.url));
    const res = spawnSync(process.execPath, [script, "--backfill-ms", "--out", outDir], { encoding: "utf8", env: { ...process.env, AWS_ACCESS_KEY_ID: "", AWS_PROFILE: "none-such" } });
    expect(res.status).toBe(0);
    const m = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(m.items.a).toEqual({ file: "a.mp3", caption: "가", hash: "h", ms: 120 });
  });
});
