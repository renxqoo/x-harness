// e2e 入口：编排真实场景——插件动态注册/销毁（sqlite CRUD）+ agent 全链旅程 + 压缩防线 + 子代理旅程
// + toolbox 四工具旅程 + CLI 宿主子进程旅程（docs/CLI.md §4 批E）。任一场景失败 → 非零退出码
// （check 脚本的 e2e 门）。真凭证旅程见 `bun run e2e:real`（opt-in）。
import { runAgentJourney } from "./agent-journey.ts";
import { runCliJourney } from "./cli-journey.ts";
import { runCompactionJourney } from "./compaction-journey.ts";
import { runCrudScenario } from "./crud-scenario.ts";
import { runDelegationJourney } from "./delegation-journey.ts";
import { runCrossProcessJourney, runReviveJourney, runWorktreeJourney } from "./delegation-journeys.ts";
import { runToolboxJourney } from "./toolbox-journey.ts";
import { runTodoJourney } from "./todo-journey.ts";

try {
  await runCrudScenario();
  await runAgentJourney();
  await runCompactionJourney();
  await runDelegationJourney();
  await runToolboxJourney();
  await runTodoJourney();
  await runCrossProcessJourney();
  await runWorktreeJourney();
  await runReviveJourney();
  await runCliJourney();
  console.log("\n场景通过：动态注册 / 使用 / 销毁无法使用 / 重装复活 / agent 全链 / 压缩防线 / 子代理旅程 / toolbox 四工具 / 跨进程双宿主 / worktree / 复活 / todo 清单 / CLI 宿主子进程\n");
} catch (error) {
  console.error("e2e 失败：", error);
  process.exitCode = 1;
}
