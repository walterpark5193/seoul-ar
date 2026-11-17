#!/usr/bin/env node
// Compile the MindAR image target (.mind) from target.png — in Node, no browser.
//
//   node tools/marker/compile-target.mjs [--in frontend/public/marker/target.png] [--out frontend/public/marker/target.mind]
//
// Uses mind-ar's own OfflineCompiler (mind-ar/src/image-target/offline-compiler.js) with the
// @tensorflow/tfjs CPU backend. The compiler wants an HTML-Image-like object it can drawImage();
// we decode the PNG with sharp to raw RGBA and hand it a @napi-rs/canvas Canvas (the `canvas`
// package is aliased to @napi-rs/canvas via npm overrides because node-canvas does not build here).
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import * as tf from "@tensorflow/tfjs";
import { createCanvas, ImageData } from "canvas";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { OfflineCompiler } from "mind-ar/src/image-target/offline-compiler.js";

const here = dirname(fileURLToPath(import.meta.url));
const MARKER_DIR = resolve(here, "../../frontend/public/marker");
export const DEFAULT_IN = resolve(MARKER_DIR, "target.png");
export const DEFAULT_OUT = resolve(MARKER_DIR, "target.mind");
export const MIND_FORMAT_VERSION = 2; // CompilerBase CURRENT_VERSION in mind-ar 1.2.5

/** Decode a PNG/JPEG buffer into a Canvas the compiler can drawImage(). */
export async function imageToCanvas(imageBuffer) {
  const { data, info } = await sharp(imageBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const canvas = createCanvas(info.width, info.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height), 0, 0);
  return canvas;
}

/**
 * Compile one image into .mind bytes.
 * Returns { bytes, width, height, seconds, matching: [{width,height,scale,maxima,minima}], tracking: [{width,height,scale,points}] }.
 */
export async function compileTargetImage(imageBuffer, { onProgress = () => {} } = {}) {
  await tf.setBackend("cpu");
  await tf.ready();
  const canvas = await imageToCanvas(imageBuffer);
  const compiler = new OfflineCompiler();
  const t0 = performance.now();
  const [data] = await compiler.compileImageTargets([canvas], onProgress);
  const bytes = compiler.exportData();
  return {
    bytes,
    width: canvas.width,
    height: canvas.height,
    seconds: (performance.now() - t0) / 1000,
    matching: data.matchingData.map((k) => ({ width: k.width, height: k.height, scale: k.scale, maxima: k.maximaPoints.length, minima: k.minimaPoints.length })),
    tracking: data.trackingData.map((t) => ({ width: t.width, height: t.height, scale: t.scale, points: t.points.length })),
  };
}

/** Sanity-check .mind bytes the way MindAR's importData() will read them. */
export function inspectMind(bytes) {
  const content = msgpackDecode(new Uint8Array(bytes));
  if (content.v !== MIND_FORMAT_VERSION) throw new Error(`unexpected .mind version ${content.v}`);
  return content.dataList.map((d) => ({
    width: d.targetImage.width,
    height: d.targetImage.height,
    matchingKeyframes: d.matchingData.length,
    trackingSets: d.trackingData.length,
  }));
}

export async function compileTargetFile({ inPath = DEFAULT_IN, outPath = DEFAULT_OUT, log = () => {} } = {}) {
  const png = await readFile(inPath);
  let lastShown = -10;
  const result = await compileTargetImage(png, {
    onProgress: (pct) => { if (pct - lastShown >= 10 || pct >= 100) { lastShown = pct; log(`  ${pct.toFixed(0)}%`); } },
  });
  await writeFile(outPath, result.bytes);
  const summary = inspectMind(result.bytes);
  log(`compiled ${result.width}x${result.height} in ${result.seconds.toFixed(1)}s -> ${outPath} (${result.bytes.length} bytes)`);
  for (const k of result.matching) log(`  matching ${k.width}x${k.height} scale=${k.scale.toFixed(3)} maxima=${k.maxima} minima=${k.minima}`);
  for (const t of result.tracking) log(`  tracking ${t.width}x${t.height} scale=${t.scale.toFixed(3)} points=${t.points}`);
  log(`  .mind v${MIND_FORMAT_VERSION}: ${JSON.stringify(summary)}`);
  return { ...result, outPath, summary };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : dflt; };
  compileTargetFile({ inPath: arg("--in", DEFAULT_IN), outPath: arg("--out", DEFAULT_OUT), log: console.log }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
