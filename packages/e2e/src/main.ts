// e2e 入口：编排两个真实场景——插件动态注册/销毁（sqlite CRUD）+ agent 全链旅程（P12 进默认门）。
// 任一场景失败 → 非零退出码（check 脚本的 e2e 门）。真凭证旅程见 `bun run e2e:real`（opt-in）。
import { runAgentJourney } from "./agent-journey.ts";
import { runCrudScenario } from "./crud-scenario.ts";
import { runDelegationJourney } from "./delegation-journey.ts";

try {
  await runCrudScenario();
  await runAgentJourney();
  await runDelegationJourney();
  console.log("\n场景通过：动态注册 / 使用 / 销毁无法使用 / 重装复活 / agent 全链 / 子代理旅程\n");
} catch (error) {
  console.error("e2e 失败：", error);
  process.exitCode = 1;
}
