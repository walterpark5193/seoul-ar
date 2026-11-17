import { defineConfig } from "vitest/config";
import { mindArThreeCompat } from "./src/ar/mindar-vite-plugin.ts";

export default defineConfig({
  plugins: [mindArThreeCompat()],
  build: { target: "es2022", sourcemap: false },
  test: { environment: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"] },
});
