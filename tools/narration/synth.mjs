// 해설 음성 합성 (Polly). CONTRACTS-stage 5.1 manifest, 5.3 synth 시그니처.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mp3DurationMs } from "./mp3.mjs";

const CONCURRENCY = 4;
const RETRIES = 2;

export function speechHash(text, voice, engine) {
  return createHash("sha1").update(`${voice}\n${engine}\n${text}`).digest("hex").slice(0, 16);
}

export function buildManifest(lines, { voice, engine, hashes, durations }) {
  const items = {};
  for (const l of lines) {
    const item = { file: `${l.id}.mp3`, caption: l.caption };
    if (hashes?.[l.id]) item.hash = hashes[l.id];
    if (durations?.[l.id] > 0) item.ms = durations[l.id];
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
      if (attempt < RETRIES) await sleep(retryDelayMs * (attempt + 1));
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
  const durations = {};
  const ok = new Set();
  const measure = (data) => { try { return mp3DurationMs(data); } catch { return 0; } };

  const work = async (line) => {
    const hash = speechHash(line.speech, voice, engine);
    const file = join(outDir, `${line.id}.mp3`);
    if (previous?.items?.[line.id]?.hash === hash && existsSync(file)) {
      hashes[line.id] = hash; ok.add(line.id); skipped.push(line.id);
      const prevMs = previous.items[line.id].ms;
      durations[line.id] = Number.isInteger(prevMs) && prevMs > 0 ? prevMs : measure(readFileSync(file));
      return;
    }
    let bytes, usedFallback = false, usedEngine = engine;
    try {
      bytes = await callPolly(client, SynthesizeSpeechCommand, line.speech, voice, engine, retryDelayMs);
    } catch (e) {
      log(`[synth] ${line.id}: ${engine} 실패(${e?.message ?? e}), ${fallbackEngine}로 대체`);
      try {
        bytes = await callPolly(client, SynthesizeSpeechCommand, line.speech, voice, fallbackEngine, retryDelayMs);
        usedFallback = true; usedEngine = fallbackEngine;
      } catch (e2) {
        log(`[synth] ${line.id}: 실패(${e2?.message ?? e2})`);
        failed.push(line.id);
        return;
      }
    }
    try {
      writeFileSync(file, bytes);
    } catch (e) {
      log(`[synth] ${line.id}: 파일 쓰기 실패(${e?.message ?? e})`);
      failed.push(line.id);
      return;
    }
    hashes[line.id] = usedFallback ? speechHash(line.speech, voice, usedEngine) : hash; ok.add(line.id); synthesized.push(line.id);
    durations[line.id] = measure(bytes);
    if (usedFallback) fallbacks.push(line.id);
  };

  let next = 0;
  const runner = async () => { while (next < lines.length) await work(lines[next++]); };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lines.length) }, runner));

  const order = new Map(lines.map((l, i) => [l.id, i]));
  const byOrder = (a, b) => order.get(a) - order.get(b);
  synthesized.sort(byOrder); skipped.sort(byOrder); failed.sort(byOrder); fallbacks.sort(byOrder);

  const manifest = buildManifest(lines.filter((l) => ok.has(l.id)), { voice, engine, hashes, durations });
  return { manifest, synthesized, skipped, failed, fallbacks };
}

// 이번 실행이 실패한 항목은 이전 manifest의 항목(파일이 남아 있을 때)을 유지한다.
export function mergeManifest(result, previous, outDir) {
  const items = { ...result.manifest.items };
  for (const id of result.failed) {
    const prev = previous?.items?.[id];
    if (prev && existsSync(join(outDir, prev.file))) items[id] = prev;
  }
  return { ...result.manifest, items };
}

// 이미 있는 manifest의 항목마다 mp3 파일 길이를 재서 ms를 채운다(재합성·AWS 호출 없음). 원본은 바꾸지 않는다.
export function backfillMs(manifest, outDir) {
  const items = {};
  const filled = [], missing = [], bad = [];
  for (const [id, item] of Object.entries(manifest?.items ?? {})) {
    const file = join(outDir, item.file);
    if (!existsSync(file)) { missing.push(id); items[id] = item; continue; }
    const ms = mp3DurationMs(readFileSync(file));
    if (ms > 0) { items[id] = { ...item, ms }; filled.push(id); } else { bad.push(id); items[id] = item; }
  }
  return { manifest: { ...manifest, items }, filled, missing, bad };
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
  const manifestPath = join(outDir, "manifest.json");

  if (argv.includes("--backfill-ms")) {
    let current;
    try {
      current = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      console.error(`[synth] ${manifestPath}를 읽을 수 없습니다(${e.message}).`);
      process.exit(1);
    }
    const r = backfillMs(current, outDir);
    writeFileSync(manifestPath, JSON.stringify(r.manifest, null, 2));
    console.log(`ms 채움 ${r.filled.length}, 파일 없음 ${r.missing.length}, MP3 아님 ${r.bad.length}`);
    if (r.missing.length || r.bad.length) {
      console.error("길이를 못 잰 항목:", [...r.missing, ...r.bad].join(", "));
      process.exitCode = 1;
    }
    return;
  }

  const { templateLines } = await import("./templates.mjs");
  const index = JSON.parse(readFileSync(join(dataDir, "index.json"), "utf8"));
  const lines = templateLines(index.gus, month);
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(scriptsPath, "utf8"));
  } catch (e) {
    console.error(`[synth] --scripts ${scriptsPath}를 읽을 수 없습니다(${e.message}). 구 해설 없이 manifest를 쓰지 않으므로 중단합니다. 먼저 write.mjs를 실행하세요.`);
    process.exit(1);
  }
  for (const [id, s] of Object.entries(scripts.items ?? {})) lines.push({ id, caption: s.caption, speech: s.speech });

  let previous;
  if (existsSync(manifestPath)) {
    try { previous = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { previous = undefined; }
  }
  const { PollyClient } = await import("@aws-sdk/client-polly");
  const client = new PollyClient({ region: "us-east-1" });
  const r = await synthAll(lines, { client, outDir, previous });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(mergeManifest(r, previous, outDir), null, 2));
  console.log(`합성 ${r.synthesized.length}, 건너뜀 ${r.skipped.length}, neural 대체 ${r.fallbacks.length}, 실패 ${r.failed.length}`);
  if (r.failed.length) { console.error("실패:", r.failed.join(", ")); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
