# 委托权限

原始调用者提交任务和调度器调用tools分别授权。以下策略仅允许名为worker的插件提交，执行委托仅允许tool-scheduler调用echo；不信任工具参数中的身份声明。

```ts
import { definePlugin } from "@x-harness/core";
import { toolAccess } from "@x-harness/tools";
import { toolScheduleAccess } from "@x-harness/tool-scheduler";

export const policy = definePlugin({
  name: "scheduler-policy",
  requires: { toolScheduleAccess, toolAccess },
  setup(ctx) {
    const schedule = ctx.guard("toolScheduleAccess", (input) => ({
      ok: true,
      value: input.origin.pluginName === "worker" && input.calls.every(call => call.name === "echo")
        ? { kind: "allow" } : { kind: "deny", reason: "submission-not-allowed" },
    }));
    if (!schedule.ok) return schedule;
    return ctx.guard("toolAccess", (input) => ({
      ok: true,
      value: input.origin.pluginName === "tool-scheduler" && input.tool.name === "echo"
        ? { kind: "allow" } : { kind: "deny", reason: "execution-not-allowed" },
    }));
  },
});
```

搭配createToolsPlugin()和createToolSchedulerPlugin()的默认required模式。guard拒绝优先；规则撤销在节点执行前复查时生效，审批等待受整体期限约束。认证与授权数据持久化由宿主或策略插件管理。
