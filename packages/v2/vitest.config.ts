import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 8,
    globalSetup: ["./plugins/session/src/__test__/start-postgres.ts"],
    include: ["plugins/*/src/**/__test__/*.test.ts", "core/src/**/__test__/*.test.ts", "standard/src/**/__test__/*.test.ts", "application/src/**/__test__/*.test.ts", "loader/src/**/__test__/*.test.ts", "create/src/**/__test__/*.test.ts", "sdk/src/**/__test__/*.test.ts", "fixtures/**/*.test.ts", "scripts/benchmark/**/__test__/*.test.ts"],
    testTimeout: 5000,
    coverage: {
      provider: "v8",
      include: ["plugins/*/src/**/*.ts", "core/src/**/*.ts", "standard/src/**/*.ts", "application/src/**/*.ts", "loader/src/**/*.ts", "create/src/**/*.ts", "sdk/src/**/*.ts"],
      exclude: ["plugins/*/src/**/__test__/**", "core/src/**/__test__/**", "core/src/**/types.ts", "standard/src/**/__test__/**", "application/src/**/__test__/**", "loader/src/**/__test__/**", "create/src/**/__test__/**", "sdk/src/**/__test__/**"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 90,
        branches: 88,
        functions: 95,
        lines: 96,
      },
    },
  },
});
