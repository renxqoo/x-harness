# Tools 插件

定义工具、校验参数并在插件生命周期内执行。工具层不调用模型、不保存会话。每个工具通过普通插件安装；卸载时停止准入、取消并排空，不另建注册表。

```ts
import { createHost } from "@x-harness/core";
import { createToolsPlugin, createToolPlugin, tools } from "@x-harness/tools";

const registry = createToolsPlugin({ access: "allow" });
const echo = createToolPlugin({
  name: "echo",
  description: "Return the supplied text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 4096 } },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(input, call) {
    const sent = await call.progress("processing");
    if (!sent.ok) return sent;
    return { ok: true, value: { content: [{ type: "text", text: input.text }] } };
  },
});
const opened = createHost({ limits: { callTimeoutMs: 60000, maxCallDepth: 256 } });
if (!registry.ok || !echo.ok || !opened.ok) throw new Error("Invalid configuration");
const app = opened.value;
try {
  const installed = await app.install([registry.value, echo.value]);
  if (!installed.ok) throw new Error("Installation failed");
  const selected = app.use(tools);
  if (!selected.ok) throw new Error("Tools unavailable");
  const result = await selected.value.execute({
    name: "echo",
    callId: "example-call",
    input: { text: "hello" },
    onProgress(delta) { console.log(delta); },
  });
  if (result.ok) console.log(result.value.content);
  else console.error(result.error.code);
} finally {
  await app.close();
}
```

`list({})` 返回按名称排序的不可变声明；`get({name})` 返回声明或null。两者只返回权限允许的工具。`execute({name,callId,input,signal?,timeoutMs?,onProgress?})`返回最终结果，输入是JSON对象，不接受未解析的模型参数字符串。模型工具调用还需agent-loop依据完整结束原因决定是否执行。

`access`默认required，没有策略就拒绝；示例的allow是宿主明确允许全部已安装工具。独立权限/人工审批插件通过普通guard接入；toolAccess负责基础准入，toolExecutionAccess负责完整计划许可，拒绝优先。校验的operation为list/get/execute；origin来自外层core调用，不从工具参数推断身份。列举过滤不代替执行授权。策略中的审批存储、用户认证及沙箱由对应插件负责；in-process插件是受信任应用代码。

作者参数从受支持的JSON Schema推断；动态生成schema的作者应自行收窄未知字段。requires/optional按core规则声明，execute里的call.deps只含本工具依赖，不能捕获初始化门面。call保留core的effect、spawn、resource、signal和deadline；caller明确表示外层调用者，内部链的origin有它自己的执行语义。

输出content为文本或图片块数组，支持显式HTTP(S) URL和image/png、jpeg、gif、webp的base64来源；工具层不代拉取URL。structured可携带JSON对象，outputSchema声明时必须存在并满足该schema。isError:true表示工具显式返回的业务失败；它与设施错误Result分开。工具层不自动把progress拼入content，也不把任意异常文案返回模型。

progress(delta)返回Promise<Result<void>>，作者须等待并处理失败。单条和累计进度有预算，禁止并发或遗留进度；失败锁存，不能忽略后伪装成功。onProgress(delta,signal)有取消与消费者期限。保存已经结束的progress函数只得到closed，不再持有请求与服务。超时/取消回执不等于函数实际退出；不合作的代码仍占并发槽和core工作记录，需宿主进程监督。

默认总并发32、每工具concurrency为1、无等待队列，满即busy。输入64KiB、输出1MiB；进度单条16KiB、累计1MiB/10000条；总期限60s、消费者30s，同时受宿主更短期限约束。预算可配置但受硬上限约束。不要用工具读写标签推断并发安全。

schema在创建插件时用Ajv编译，支持type（含nullable）、properties、required、additionalProperties布尔、items、enum/const标量、min/maxLength、min/maxItems、minimum/maximum、description/title。根必须object；不转换类型、不补默认、不删除字段。schema最多16KiB、1024节点、16层schema嵌套，拒绝引用/远程加载、正则、format、组合和递归；不声称完整JSON Schema支持。

动态目录通过core处理链发现，按准入快照固定一次安装身份。同名冲突使新请求失败；已经准入的请求不被后来安装重定向，原安装卸载则取消。目录和路由遍历为O(工具插件数)，默认目录32、上限128，仍受core.maxCallDepth限制，大工具集应显式配置足够的宿主深度。范围隔离沿用core可见性；根tools实例不承诺自动发现子范围贡献。

Bun部署保留完整包目录或应用整体打包；源码和构建入口共享公开及内部token身份，不能只复制dist目录。可运行工作区四门、test:tools:mutations和benchmark:tools复核行为。

需要等待名额、批量并发、调用依赖或优先级时，使用独立[tool-scheduler](../tool-scheduler/README.md)。`@x-harness/tools/validation`公开readToolJson(raw,limits)、readToolOutput(raw,maxBytes)和readToolError(raw)，供其他插件复用同一份有界数据与输出契约验证。

工具效果声明、可撤销权限、资源读写协调与独立命令执行见 [受控执行与权限扩展](./EXECUTION.md)。默认 maxPreparedPlans 为 256；资源等待使用 prepare/checkPrepared/executePrepared，不在直接 execute 中增加隐式队列。

普通插件可直接使用公开处理链贡献工具，见[工具作者示例](./AUTHORING.md)；完整授权与询问见[权限策略](./POLICY.md)。所有执行校验位于tools边界，工厂只提供便利封装。
