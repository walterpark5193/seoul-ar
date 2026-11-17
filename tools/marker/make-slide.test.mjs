import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  renderMarkerAssets,
  buildTargetSvg,
  buildSlideSvg,
  TARGET_SIZE,
  SLIDE_SIZE,
  TITLE,
  HINT,
} from "./make-slide.mjs";
import { hasGlyph } from "./glyphs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const COMMITTED_DIR = resolve(here, "../../frontend/public/marker");

/** Luminance standard deviation across channels; a flat image is ~0. */
async function contrastOf(file) {
  const { channels } = await sharp(file).stats();
  return Math.max(...channels.slice(0, 3).map((c) => c.stdev));
}

describe("make-slide: freshly rendered assets", () => {
  let out;
  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "seoul-ar-marker-"));
    await renderMarkerAssets({ outDir: out });
  }, 120_000);

  it("target.png is 1024x1024 PNG and not empty", async () => {
    const file = join(out, "target.png");
    expect((await stat(file)).size).toBeGreaterThan(0);
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(TARGET_SIZE);
    expect(meta.height).toBe(TARGET_SIZE);
    expect(TARGET_SIZE).toBe(1024);
  });

  it("slide.png is 1920x1080 PNG and not empty", async () => {
    const file = join(out, "slide.png");
    expect((await stat(file)).size).toBeGreaterThan(0);
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(SLIDE_SIZE.width);
    expect(meta.height).toBe(SLIDE_SIZE.height);
    expect(SLIDE_SIZE).toEqual({ width: 1920, height: 1080 });
  });

  it("both images have real contrast (not a blank canvas)", async () => {
    expect(await contrastOf(join(out, "target.png"))).toBeGreaterThan(20);
    expect(await contrastOf(join(out, "slide.png"))).toBeGreaterThan(20);
  });

  it("target art fills its edges with texture (no large flat margins)", async () => {
    // Each 128px edge strip must carry contrast; MindAR features come from corners/blobs, not flat colour.
    const strips = [
      { left: 0, top: 0, width: TARGET_SIZE, height: 128 },
      { left: 0, top: TARGET_SIZE - 128, width: TARGET_SIZE, height: 128 },
      { left: 0, top: 0, width: 128, height: TARGET_SIZE },
      { left: TARGET_SIZE - 128, top: 0, width: 128, height: TARGET_SIZE },
    ];
    for (const region of strips) {
      const { channels } = await sharp(join(out, "target.png")).extract(region).stats();
      expect(Math.max(...channels.slice(0, 3).map((c) => c.stdev))).toBeGreaterThan(10);
    }
  });
});

describe("make-slide: SVG construction (pure)", () => {
  it("is deterministic", () => {
    expect(buildTargetSvg()).toBe(buildTargetSvg());
    expect(buildSlideSvg()).toBe(buildSlideSvg());
  });

  it("uses no <text> elements (this machine has no fonts; everything is drawn as paths)", () => {
    expect(buildTargetSvg()).not.toMatch(/<text[\s>]/);
    expect(buildSlideSvg()).not.toMatch(/<text[\s>]/);
  });

  it("declares the exact pixel dimensions", () => {
    expect(buildTargetSvg()).toMatch(/<svg[^>]*\swidth="1024"[^>]*\sheight="1024"/);
    expect(buildSlideSvg()).toMatch(/<svg[^>]*\swidth="1920"[^>]*\sheight="1080"/);
  });

  it("has a stroke glyph for every character of the title and the hint", () => {
    expect(TITLE).toBe("서울이 선다");
    expect(HINT).toBe("폰 카메라로 비춰 보세요");
    for (const ch of TITLE + HINT) {
      if (ch === " ") continue;
      expect(hasGlyph(ch), `missing glyph for "${ch}"`).toBe(true);
    }
  });
});

describe("committed marker assets in frontend/public/marker", () => {
  it("target.png is 1024x1024", async () => {
    const meta = await sharp(join(COMMITTED_DIR, "target.png")).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1024]);
  });

  it("slide.png is 1920x1080", async () => {
    const meta = await sharp(join(COMMITTED_DIR, "slide.png")).metadata();
    expect([meta.width, meta.height]).toEqual([1920, 1080]);
  });

  it("target.png matches what make-slide renders today (regenerate with: node tools/marker/make-slide.mjs)", async () => {
    const committed = await readFile(join(COMMITTED_DIR, "target.png"));
    const fresh = await sharp(Buffer.from(buildTargetSvg())).png().toBuffer();
    const [a, b] = await Promise.all([sharp(committed).raw().toBuffer(), sharp(fresh).raw().toBuffer()]);
    expect(a.equals(b)).toBe(true);
  }, 60_000);
});
