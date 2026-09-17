import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/__test__/**/*.test.ts"],
    environment: "node",
  },
  coverage: {
    include: ["packages/*/src/**/*.ts"],
    exclude: ["packages/*/src/**/__test__/**", "packages/*/src/index.ts"],
    thresholds: {
      lines: 90,
      statements: 90,
      functions: 90,
      branches: 85,
    },
  },
});
