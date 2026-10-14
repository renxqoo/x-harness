import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/src/**/__test__/*.test.ts", "fixtures/**/*.test.ts"],
    testTimeout: 5000,
    coverage: {
      provider: "v8",
      include: ["core/src/**/*.ts"],
      exclude: ["core/src/**/__test__/**", "core/src/**/types.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
