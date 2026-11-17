import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  compileTargetImage,
  inspectMind,
  sha256,
  manifestPathFor,
  MIND_FORMAT_VERSION,
  DEFAULT_IN,
  DEFAULT_OUT,
  DEFAULT_MANIFEST,
} from "./compile-target.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("target.manifest.json ties the committed target.png to the committed target.mind", () => {
  it("lives next to the .mind", () => {
    expect(manifestPathFor("/x/marker/target.mind")).toBe("/x/marker/target.manifest.json");
    expect(DEFAULT_MANIFEST).toBe(resolve(here, "../../frontend/public/marker/target.manifest.json"));
  });

  it("hashes match the files on disk (if this fails: node tools/marker/compile-target.mjs after make-slide)", async () => {
    const manifest = JSON.parse(await readFile(DEFAULT_MANIFEST, "utf8"));
    const [png, mind] = await Promise.all([readFile(DEFAULT_IN), readFile(DEFAULT_OUT)]);
    expect(manifest.v).toBe(1);
    expect(manifest.source).toBe("target.png");
    expect(manifest.mind).toBe("target.mind");
    expect(manifest.sourceSha256).toBe(sha256(png));
    expect(manifest.sourceBytes).toBe(png.length);
    expect(manifest.mindSha256).toBe(sha256(mind));
    expect(manifest.mindBytes).toBe(mind.length);
    expect(manifest.mindFormatVersion).toBe(MIND_FORMAT_VERSION);
    expect(manifest.mindAr).toBe("1.2.5");
    expect(manifest.image).toEqual({ width: 1024, height: 1024 });
    expect(manifest.matching.length).toBe(inspectMind(mind)[0].matchingKeyframes);
    expect(manifest.tracking.map((t) => t.width)).toEqual([256, 128]);
  });
});

describe("committed target.mind (frontend/public/marker)", () => {
  it("is a v2 .mind for the 1024x1024 target with matching keyframes and both tracking scales", async () => {
    const bytes = await readFile(DEFAULT_OUT);
    expect(bytes.length).toBeGreaterThan(0);
    const [info] = inspectMind(bytes);
    expect(MIND_FORMAT_VERSION).toBe(2);
    expect(info).toMatchObject({ width: 1024, height: 1024, trackingSets: 2 });
    expect(info.matchingKeyframes).toBeGreaterThanOrEqual(8); // 1024px -> 11 scales down to 100px
  });

  it("was compiled from an image with the same dimensions as the committed target.png", async () => {
    const meta = await sharp(DEFAULT_IN).metadata();
    const [info] = inspectMind(await readFile(DEFAULT_OUT));
    expect([info.width, info.height]).toEqual([meta.width, meta.height]);
    expect(resolve(here, "../../frontend/public/marker/target.mind")).toBe(DEFAULT_OUT);
  });
});

describe("compileTargetImage (Node offline compiler, tfjs CPU backend)", () => {
  it("compiles a small synthetic image end to end and the output decodes", async () => {
    // 160px keeps this under a few seconds; the real 1024px target takes ~20s and is run by the CLI.
    const size = 160;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" fill="#0b1020"/>` +
      `<polygon points="10,20 70,8 55,60 20,50" fill="#fbbf24"/><polygon points="90,30 150,25 140,90 100,70" fill="#38bdf8"/>` +
      `<polygon points="20,90 80,100 60,150 15,140" fill="#f97316"/><circle cx="120" cy="125" r="18" fill="#e5e7eb"/>` +
      `<path d="M30 70L140 110" stroke="#e5e7eb" stroke-width="4"/></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const progress = [];
    const result = await compileTargetImage(png, { onProgress: (p) => progress.push(p) });
    expect(result.width).toBe(size);
    expect(result.height).toBe(size);
    expect(result.bytes.length).toBeGreaterThan(1000);
    expect(progress.at(-1)).toBeCloseTo(100, 3);
    expect(result.matching.length).toBeGreaterThan(0);
    expect(result.tracking.map((t) => t.width)).toEqual([256, 128]);
    const [info] = inspectMind(result.bytes);
    expect(info).toEqual({ width: size, height: size, matchingKeyframes: result.matching.length, trackingSets: 2 });
  }, 60_000);
});
