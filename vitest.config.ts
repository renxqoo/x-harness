import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/__test__/**/*.test.ts", "packages/core/*/src/**/__test__/**/*.test.ts",  "apps/*/src/**/__test__/**/*.test.ts", "scripts/__test__/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["packages/*/src/**/*.ts", "packages/core/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: [
        "**/__test__/**",
        "**/src/index.ts",
        "packages/*/src/**/worker/**", "packages/core/*/src/**/worker/**",
        "packages/e2e/**",
      ],
    },
  },
});
