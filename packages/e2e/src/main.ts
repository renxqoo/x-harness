import { runAgentJourney } from "./agent-journey.ts";
import { runCliJourney } from "./cli-journey.ts";
import { runCompactionJourney } from "./compaction-journey.ts";
import { runOutputContinuationJourney } from "./output-continuation-journey.ts";
import { runCrudScenario } from "./crud-scenario.ts";
import { runDelegationJourney } from "./delegation-journey.ts";
import { runWorkflowCrashJourneys } from "./workflow-journeys.ts";
import { runCrossProcessJourney, runReviveJourney, runWorktreeJourney } from "./delegation-journeys.ts";
import { runLongContentJourney } from "./long-content-journey.ts";
import { runToolboxJourney } from "./toolbox-journey.ts";
import { turnReductionJourney } from "./turn-reduction-journey.ts";
import { runTodoJourney } from "./todo-journey.ts";

try {
  await runCrudScenario();
  await runAgentJourney();
  await runCompactionJourney();
  await runOutputContinuationJourney();
  await runDelegationJourney();
  const wfIssues = await runWorkflowCrashJourneys();
  if (wfIssues.length > 0) throw new Error(`workflow 崩溃旅程发现问题：\n${wfIssues.join("\n")}`);
  await runLongContentJourney();
  await runToolboxJourney();
  await turnReductionJourney();
  await runTodoJourney();
  await runCrossProcessJourney();
  await runWorktreeJourney();
  await runReviveJourney();
  await runCliJourney();
  console.log("\n场景通过：动态注册 / 使用 / 销毁无法使用 / 重装复活 / agent 全链 / 压缩防线 / 子代理旅程 / 长内容回传 / toolbox 四工具 / 轮次收敛双旅程 / 跨进程双宿主 / worktree / 复活 / todo 清单 / CLI 宿主子进程\n");
} catch (error) {
  console.error("e2e 失败：", error);
  process.exitCode = 1;
}
