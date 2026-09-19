import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/__test__/**/*.test.ts", "packages/core/*/src/**/__test__/**/*.test.ts",  "apps/*/src/**/__test__/**/*.test.ts", "scripts/__test__/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["packages/*/src/**/*.ts", "packages/core/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      // 不进分母的四类：__test__ 整目录（含装置等非 .test.ts 辅助文件）；barrel 出口；
      // worker/ 目录（host.ts 在真实 worker 线程执行——v8 进程内插桩不可达，行为由 worker 用例背书；
      // protocol.ts 为纯类型）；packages/e2e（真实场景宿主程序——由 `bun run e2e` 退出码背书，
      // 不在 vitest 运行期内执行，计数无意义）。
      // 注意：coverage 必须嵌在 test 下——挂在顶层会被静默忽略（include/exclude/thresholds 全失效）。
      exclude: [
        "**/__test__/**",
        "**/src/index.ts",
        "packages/*/src/**/worker/**", "packages/core/*/src/**/worker/**",
        "packages/e2e/**",
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
