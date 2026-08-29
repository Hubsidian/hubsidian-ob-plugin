import { defineConfig } from "vitest/config";

// Plain node environment: only the pure modules (planner, davxml) are under
// test here — anything importing "obsidian" stays out.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
