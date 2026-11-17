// Vite plugin: make mind-ar 1.2.5's three.js bundle build against three >= r162.
//
// `mind-ar/dist/mindar-image-three.prod.js` does `import { ..., sRGBEncoding as X, ... } from "three"`.
// three removed `sRGBEncoding` in r162 (0.187 here), so Vite/Rolldown fails the build with
// MISSING_EXPORT and the dev pre-bundler fails the same way. The bundle's only use of the symbol is
// `renderer.outputEncoding = sRGBEncoding`, a no-op on modern three (outputColorSpace already
// defaults to SRGBColorSpace). We drop the import binding and define the legacy constant locally.
//
// Usage (vite.config.ts): `plugins: [mindArThreeCompat()]`. The plugin also excludes mind-ar from
// dependency pre-bundling so this transform runs in dev as well as in `vite build`.
import type { Plugin } from "vite";

const MINDAR_THREE_BUNDLE = /mind-ar[\\/]dist[\\/]mindar-image-three\.prod\.js(?:\?.*)?$/;
const SRGB_IMPORT = /\bsRGBEncoding as ([A-Za-z_$][\w$]*)\s*,?\s*/;
const LEGACY_SRGB_ENCODING = 3001; // three < r162: export const sRGBEncoding = 3001

export function mindArThreeCompat(): Plugin {
  return {
    name: "seoul-ar:mindar-three-compat",
    enforce: "pre",
    config() {
      return { optimizeDeps: { exclude: ["mind-ar"] } };
    },
    transform(code, id) {
      if (!MINDAR_THREE_BUNDLE.test(id)) return null;
      const match = SRGB_IMPORT.exec(code);
      if (!match) return null;
      const local = match[1];
      return {
        code: `const ${local} = ${LEGACY_SRGB_ENCODING};\n${code.replace(SRGB_IMPORT, "")}`,
        map: null,
      };
    },
  };
}
