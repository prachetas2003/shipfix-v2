import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Fixtures are data, not test files.
    exclude: ["test/fixtures/**", "node_modules/**"],
  },
});
