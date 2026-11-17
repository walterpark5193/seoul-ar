import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { speechHash, buildManifest, synthAll } from "./synth.mjs";

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
});
