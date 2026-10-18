# Tool scheduler

进程内工具调度：有界排队、批量并发、调用者轮转、优先级及显式依赖。工具作者继续编写普通工具插件；调度器通过公开tools服务执行。

```ts
import { createHost } from "@x-harness/core";
import { createToolsPlugin, createToolPlugin } from "@x-harness/tools";
import { createToolSchedulerPlugin, toolScheduler } from "@x-harness/tool-scheduler";

const opened = createHost({ limits: { callTimeoutMs: 60000, maxCallDepth: 256 } });
const tools = createToolsPlugin({ access: "allow" });
const scheduler = createToolSchedulerPlugin({ access: "allow", limits: { concurrency: 4 } });
const echo = createToolPlugin({
  name: "echo", concurrency: 2,
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  async execute(input) { return { ok: true, value: { content: [{ type: "text", text: input.text }] } }; },
});
if (!opened.ok || !tools.ok || !scheduler.ok || !echo.ok) throw new Error("Invalid configuration");
const app = opened.value;
try {
  const installed = await app.install([tools.value, scheduler.value, echo.value]);
  if (!installed.ok) throw new Error("Installation failed");
  const selected = app.use(toolScheduler);
  if (!selected.ok) throw new Error("Scheduler unavailable");
  const result = await selected.value.batch({
    calls: [
      { callId: "first", name: "echo", input: { text: "hello" } },
      { callId: "second", name: "echo", input: { text: "world" }, dependsOn: ["first"] },
    ],
    concurrency: 2,
    timeoutMs: 30000,
    onProgress(event) { console.log(event.callId, event.delta); },
  });
  if (result.ok) console.log(result.value.results);
  else console.error(result.error.code);
} finally {
  await app.close();
}
```

execute接受name/callId/input以及signal、timeoutMs、onProgress、priority和mode。mode默认wait，容量允许时开始；immediate没有马上取得调度名额就busy，参与相同公平轮转。batch返回按输入顺序排列的{results:[{callId,result}]}；单个工具的Result失败或isError:true阻止其依赖后代，其他任务继续。整批参数、循环和悬空依赖在执行前拒绝；不自动把前一结果注入后一参数，调用者自行构造输入。

已准入请求按不同origin(scopeId/pluginName)轮流获得名额；同origin内priority为-10到10，默认0，最多连续3次优先选择后取最早可运行节点。被依赖或单工具名额阻塞的任务不挡住其他可运行工具。优先级不跨调用者压制其他lane。公平保证以名额释放次数度量，不保证不合作工具下的墙钟等待上界。

默认并发8、最多256个已准入未实际退出节点、32个在途请求、单批128项；完整calls输入及依赖元数据1MiB（最多20万JSON节点、40层嵌套）、报告4MiB、整体期限60秒。预算可配置，受硬上限与宿主更短期限约束。请求期限包含授权和排队；节点timeoutMs覆盖准备、权限等待、资源等待及执行，工具准备产生的 lease 不因分阶段重试续期。满额原子返回queue-full，不部分加入批次。inspect({})只返回running/queued/requests；running只统计实际提交后执行与取消后尚未退出的工作；最多32个准备/权限检查任务独立受限，不占执行槽。

取消和整体期限能先返回失败，真正退出前保留容量；普通批次报告等待已启动节点实际结束。进度通过tools的await背压和消费期限传递；不同节点的进度可以交错，以callId区分。结果超过累计预算取消剩余节点，返回capacity-exceeded，不静默截断；不合作工作可能先触发整体期限。卸载取消排队与运行工作，未退出工作仍在core.inspect可见。

默认要求toolScheduleAccess策略，示例allow是宿主显式信任委托。提交及每个节点执行前都检查原始调用者；工具实际执行时toolAccess看到的是tool-scheduler身份，因此权限策略需分别批准提交者及调度器委托。详见POLICY.md。不从input自报身份，不绕过tools检查。

排队按工具名称委托，在真正执行时绑定当前安装；排队期间替换同名工具会使用当时可用的安装，并重新经tools授权与schema校验。每工具并发从准入时tools.get取得，实际tools在全部资源和容量原子提交时执行最终保护。直接tools调用、其他调度器及动态配置可能竞争名额而返回tools/busy，此时保持失败，不自动重试。resource-busy/admission-busy 则保留准备计划等待 tools.watch 可靠通知，不忙循环；排队写意图阻止后来冲突读者插队。需要统一公平性时，通过同一个调度器实例提交调用。

没有持久任务、自动重试、跨进程或跨机器统一队列。调度器不调用模型、不写会话、不提供沙箱。Bun部署保留完整包目录或应用整体打包；源码和构建入口共享公开token，不能只复制dist目录。

工具内部嵌套调用同一调度器时，使用immediate并处理busy，或直接调用已声明服务。父工具占满容量又等待新任务的wait调用会等到整体期限；调度器不会突破并发限制来递归执行。批次先后关系应通过dependsOn表达。

资源、命令与完整效果权限由 tools 统一协调，多个 scheduler 和直接调用共用相同资源表；调度器不猜测 bash/run_code 能否并行。见 [受控执行](../tools/EXECUTION.md)。
