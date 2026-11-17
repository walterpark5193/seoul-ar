// 해설 음성 합성 (Polly). CONTRACTS-stage 5.1 manifest, 5.3 synth 시그니처.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONCURRENCY = 4;
const RETRIES = 2;

export function speechHash(text, voice, engine) {
  return createHash("sha1").update(`${voice}\n${engine}\n${text}`).digest("hex").slice(0, 16);
}

export function buildManifest(lines, { voice, engine, hashes }) {
  const items = {};
  for (const l of lines) {
    const item = { file: `${l.id}.mp3`, caption: l.caption };
    if (hashes?.[l.id]) item.hash = hashes[l.id];
    items[l.id] = item;
  }
  return { v: 1, voice, engine, items };
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function callPolly(client, SynthesizeSpeechCommand, text, voice, engine, retryDelayMs) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await client.send(new SynthesizeSpeechCommand({
        OutputFormat: "mp3", LanguageCode: "ko-KR", VoiceId: voice, Engine: engine, Text: text,
      }));
      return await res.AudioStream.transformToByteArray();
    } catch (e) {
      lastErr = e;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function synthAll(lines, {
  client, outDir, voice = "Seoyeon", engine = "generative", fallbackEngine = "neural",
  previous, log = console.log, retryDelayMs = 400,
}) {
  const { SynthesizeSpeechCommand } = await import("@aws-sdk/client-polly");
  mkdirSync(outDir, { recursive: true });
  const synthesized = [], skipped = [], failed = [], fallbacks = [];
  const hashes = {};
  const ok = new Set();

  const work = async (line) => {
    const hash = speechHash(line.speech, voice, engine);
    const file = join(outDir, `${line.id}.mp3`);
    if (previous?.items?.[line.id]?.hash === hash && existsSync(file)) {
      hashes[line.id] = hash; ok.add(line.id); skipped.push(line.id);
      return;
    }
    let bytes, usedFallback = false;
    try {
      bytes = await callPolly(client, SynthesizeSpeechCommand, line.speech, voice, engine, retryDelayMs);
    } catch (e) {
      log(`[synth] ${line.id}: ${engine} 실패(${e?.message ?? e}), ${fallbackEngine}로 대체`);
      try {
        bytes = await callPolly(client, SynthesizeSpeechCommand, line.speech, voice, fallbackEngine, retryDelayMs);
        usedFallback = true;
      } catch (e2) {
        log(`[synth] ${line.id}: 실패(${e2?.message ?? e2})`);
        failed.push(line.id);
        return;
      }
    }
    writeFileSync(file, bytes);
    hashes[line.id] = hash; ok.add(line.id); synthesized.push(line.id);
    if (usedFallback) fallbacks.push(line.id);
  };

  let next = 0;
  const runner = async () => { while (next < lines.length) await work(lines[next++]); };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lines.length) }, runner));

  const order = new Map(lines.map((l, i) => [l.id, i]));
  const byOrder = (a, b) => order.get(a) - order.get(b);
  synthesized.sort(byOrder); skipped.sort(byOrder); failed.sort(byOrder); fallbacks.sort(byOrder);

  const manifest = buildManifest(lines.filter((l) => ok.has(l.id)), { voice, engine, hashes });
  return { manifest, synthesized, skipped, failed, fallbacks };
}

function arg(argv, name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}

async function main(argv) {
  const scriptsPath = arg(argv, "scripts", "tools/narration/scripts.json");
  const dataDir = arg(argv, "data", "frontend/public/data");
  const month = arg(argv, "month", "202611");
  const outDir = arg(argv, "out", "frontend/public/narration");

  const { templateLines } = await import("./templates.mjs");
  const index = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
  const lines = templateLines(index.gus, month);
  if (existsSync(scriptsPath)) {
    const scripts = JSON.parse(readFileSync(scriptsPath, "utf8"));
    for (const [id, s] of Object.entries(scripts.items ?? {})) lines.push({ id, caption: s.caption, speech: s.speech });
  } else {
    console.warn(`[synth] ${scriptsPath} 없음: 구 해설 없이 템플릿만 합성`);
  }

  const manifestPath = join(outDir, "manifest.json");
  let previous;
  if (existsSync(manifestPath)) {
    try { previous = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { previous = undefined; }
  }
  const { PollyClient } = await import("@aws-sdk/client-polly");
  const client = new PollyClient({ region: "us-east-1" });
  const r = await synthAll(lines, { client, outDir, previous });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(r.manifest, null, 2));
  console.log(`합성 ${r.synthesized.length}, 건너뜀 ${r.skipped.length}, neural 대체 ${r.fallbacks.length}, 실패 ${r.failed.length}`);
  if (r.failed.length) { console.error("실패:", r.failed.join(", ")); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
