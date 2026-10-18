# 受控执行与权限扩展

```mermaid
flowchart LR
  A[宿主或业务插件] --> B[tool-scheduler]
  B --> C[tools 准备不可变计划]
  C --> D[自定义权限插件]
  D --> E[资源读写协调与容量提交]
  E --> F[工具 execute]
  F --> G[call.execution.run]
  G --> H[独立执行提供者]
  H --> I[实际进程与输出结束]
  I --> J[释放全部资源]
```

下面的完整示例把权限判断交给宿主函数。该函数可以连接人工审批服务、确定性规则或模型评估；这些业务实现不属于 tools 或 core。

```ts
import { createHost } from "@x-harness/core";
import { createToolsPlugin, createToolPlugin, createToolPolicyPlugin } from "@x-harness/tools";
import type { ToolExecutionPlan } from "@x-harness/tools";
import { createToolSchedulerPlugin, toolScheduler } from "@x-harness/tool-scheduler";
import { createSandboxPlugin } from "@x-harness/sandbox";

export async function readDocument(
  workspace: string,
  path: string,
  authorize: (plan: ToolExecutionPlan, signal: AbortSignal) => Promise<boolean>,
) {
  const registry = createToolsPlugin({ access: "allow" });
  const scheduler = createToolSchedulerPlugin({ access: "allow" });
  const sandbox = createSandboxPlugin({ profiles: { documents: { cwd: workspace } } });
  const policy = createToolPolicyPlugin({
    name: "application-permission",
    async authorize(plan, call) {
      const allowed = await authorize(plan, call.signal);
      return { ok: true, value: { kind: allowed ? "allow" : "deny" } };
    },
  });
  const reader = createToolPlugin({
    name: "read-document",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", maxLength: 4096 } },
      required: ["path"],
      additionalProperties: false,
    },
    async prepare(input) {
      return { ok: true, value: {
        actions: { filesystem: { read: input.path } },
        execution: { profile: "documents", argv: ["/bin/cat", input.path] },
      } };
    },
    async execute(_input, call) {
      if (!call.execution) return { ok: true, value: { content: [], isError: true } };
      const output = await call.execution.run();
      if (!output.ok) return { ok: true, value: { content: [], isError: true } };
      return { ok: true, value: {
        content: [{ type: "text", text: output.value.stdout }],
        isError: output.value.exitCode !== 0,
      } };
    },
  });
  const opened = createHost({ limits: { callTimeoutMs: 60000, maxCallDepth: 256 } });
  if (!opened.ok || !registry.ok || !scheduler.ok || !sandbox.ok || !policy.ok || !reader.ok)
    throw new Error("Invalid configuration");
  const app = opened.value;
  try {
    const installed = await app.install([registry.value, scheduler.value, sandbox.value, policy.value, reader.value]);
    if (!installed.ok) throw new Error("Installation failed");
    const service = app.use(toolScheduler);
    if (!service.ok) throw new Error("Scheduler unavailable");
    return await service.value.execute({ name: "read-document", callId: "read", input: { path } });
  } finally {
    await app.close();
  }
}
```

`prepare` 声明动作、资源和命令，不执行命令。提供者将命令规范化为 `plan.execution`，策略看到真实的 argv/cwd/env、只读/可写目录及网络限制。`execute` 里的 `call.plan` 是同一计划；`call.execution.run()` 没有参数，只能执行批准的目标一次。结束后保存的门面返回 closed，并释放调用引用。

`actions` 是业务 JSON 命名空间。工具作者可以声明文件、数据库、支付或任意自定义动作；框架不会依据工具名字猜测效果。直接在宿主 JavaScript 中调用 fs、fetch 或子进程的插件是受信任代码，声明资源本身不会把 JavaScript 隔离进沙箱。需要隔离的命令必须通过 execution 提供者运行。

`createToolPolicyPlugin({name,requires?,optional?,authorize})` 支持普通 core 服务依赖。`authorize` 返回 `{ok:true,value:{kind:"allow",signal?,isValid?}}` 或 deny；抛错、无效结果、任何一个插件拒绝都阻止执行。异步等待审批不占执行槽或资源锁。允许之后、真正提交之前同步检查 `isValid() === true`；需要及时撤销时提供 AbortSignal，权限插件卸载也会撤销已有许可。运行中撤销会请求取消，但锁和容量仍保留到实际结束。LLM 评估插件与普通策略一样参与 deny-wins 合并，不能覆盖其他限制。

`plan.origin`/`originId` 表示实际委托者及其安装身份；`plan.initiator` 表示 core 记录的调用链发起者。调度委托时两者可以不同。它们都不是登录用户，用户身份由宿主的受信任服务映射；不能相信 input 自报身份。原有 `toolAccess` 仍负责目录可见性及执行前授权，`toolExecutionAccess` 负责完整效果计划；两层拒绝均生效。没有配置 toolAccess 时，默认 required 模式拒绝全部请求。

资源声明为 `{domain,path:[...分段],scope:"exact"|"subtree",mode:"read"|"write"}`。读读并行，重叠写互斥，全部资源一起提交。较早的冲突写意图阻止新读者插队；无关资源不阻塞。提供者自动加入文件根与可执行文件声明，工具补充的资源与之合并，最终最多 128 个。自定义工具须把资源转换成该领域的统一身份；例如直接使用宿主文件 API 的工具，应在 prepare 中通过自己的文件服务解析真实路径，不能把不同的路径别名当成不同资源。该协调范围是同一个 tools 实例，外部进程和跨机器事务由相应系统协调。

直接 `execute` 忙时返回 busy。自定义调度器可调用 `prepare` 获得不可伪造的 PreparedTool，读取 plan 和 `status()`（ready/waiting 或终态错误）；用 `checkPrepared` 完成最终异步 toolAccess 检查并取得单次 ToolCommit，再 `executePrepared({prepared,commit?,capacities?})`。resource-busy/admission-busy 保留计划和原意图顺序，其他终态关闭计划。`createToolCapacity(limit)` 创建共享有界容量；`watch({onChange})` 是最多 128 个、绑定调用者安装生命周期的可靠通知，关闭 disposer 立即解除引用；`toolAvailability(null)` 仅供观察。保存句柄不能转让给另一个调用者安装。不用的计划调用 `discard`；默认最多 256 个准备计划，每个最多 60 秒，不因重试续期。
