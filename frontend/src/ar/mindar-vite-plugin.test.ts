import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mindArThreeCompat } from "./mindar-vite-plugin";

const require = createRequire(import.meta.url);
const bundlePath = require.resolve("mind-ar/dist/mindar-image-three.prod.js");
const bundleFirstLine = readFileSync(bundlePath, "utf8").split("\n", 1)[0]!;

type TransformFn = (this: { error(msg: string): never }, code: string, id: string) => { code: string; map: null } | null;
function runTransform(code: string, id: string) {
  const plugin = mindArThreeCompat();
  const transform = plugin.transform as unknown as TransformFn;
  const ctx = {
    error(msg: string): never {
      throw new Error(msg);
    },
  };
  return transform.call(ctx, code, id);
}

describe("mindArThreeCompat (mind-ar 1.2.5 bundle vs three >= r162)", () => {
  it("the installed bundle really does import sRGBEncoding from three on its first line", () => {
    expect(bundleFirstLine).toMatch(/^import \{.*\bsRGBEncoding as \w+.*\} from "three";$/);
  });

  it("rewrites the real bundle's import line: drops sRGBEncoding and defines the legacy constant", () => {
    const out = runTransform(bundleFirstLine, bundlePath);
    expect(out).not.toBeNull();
    const local = /sRGBEncoding as (\w+)/.exec(bundleFirstLine)![1];
    expect(out!.code.startsWith(`const ${local} = 3001;\n`)).toBe(true);
    expect(out!.code).not.toMatch(/sRGBEncoding/);
    expect(out!.code).toMatch(/\} from "three";/);
    expect(out!.code).not.toMatch(/,\s*\} from "three"/); // import list still well-formed
    expect(out!.code).toMatch(/\bPerspectiveCamera as \w+/); // neighbours survived
  });

  it("also matches the dev-server id with a version query", () => {
    const out = runTransform(bundleFirstLine, `${bundlePath}?v=abc123`);
    expect(out?.code).toMatch(/= 3001;/);
  });

  it("leaves every other module alone", () => {
    expect(runTransform('import { sRGBEncoding as X } from "three";', "/x/node_modules/other/index.js")).toBeNull();
  });

  it("fails the build loudly if the bundle matched but no longer has the import (stale plugin)", () => {
    expect(() => runTransform('import { Matrix4 as T } from "three";', bundlePath)).toThrow(/sRGBEncoding/);
  });

  it("excludes mind-ar from dependency pre-bundling so the transform also runs in dev", () => {
    const plugin = mindArThreeCompat();
    const config = (plugin.config as unknown as () => { optimizeDeps: { exclude: string[] } })();
    expect(config.optimizeDeps.exclude).toContain("mind-ar");
  });
});
