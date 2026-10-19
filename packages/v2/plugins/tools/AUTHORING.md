# 使用普通插件贡献工具

工具扩展由公开toolCatalog、toolPreparation、toolDispatch三个处理链组成。目录声明形状为{signal,tool,limits?}，无需注册工厂或生成安装id。tools负责schema编译、输入输出校验、并发、进度预算和取消。同一ctx.signal与工具名形成稳定安装身份，等值的新声明对象也复用该身份；同一安装内更换描述或limits会拒绝，更新应重新安装插件。每个ctx.signal最多128个不同名称，卸载时释放索引。首次发现会快照并缓存描述/schema，重复发现不重新编译。

```ts
import { definePlugin } from "@x-harness/core";
import { toolCatalog, toolPreparation, toolDispatch } from "@x-harness/tools";
import type { ToolContribution } from "@x-harness/tools";

export const echo = definePlugin({
  name: "echo-tool",
  requires: { toolCatalog, toolPreparation, toolDispatch },
  setup(ctx) {
    const entry = Object.freeze({
      signal: ctx.signal,
      tool: {
        name: "echo",
        concurrency: 1,
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    } satisfies ToolContribution);
    const catalog = ctx.middleware("toolCatalog", (query, next) => {
      const sent = query.visit(entry);
      return sent.ok ? next(query) : sent;
    });
    if (!catalog.ok) return catalog;
    const preparation = ctx.middleware("toolPreparation", (request, next) => {
      if (request.ownerSignal !== ctx.signal || request.name !== "echo") {
        return next(request);
      }
      return { ok: true, value: {} };
    });
    if (!preparation.ok) return preparation;
    return ctx.middleware("toolDispatch", (request, next) => {
      if (request.ownerSignal !== ctx.signal || request.name !== "echo") {
        return next(request);
      }
      return {
        ok: true,
        value: { content: [{ type: "text", text: String(request.input.text) }] },
      };
    });
  },
});
```

处理器必须共同检查ownerSignal和name；重新安装同一插件会产生新的ctx.signal，因此旧请求不能进入新安装的处理器。同名目录冲突使新请求失败，已经准入的调用保持原安装身份。准备与派发请求由tools颁发并冻结，不接受复制对象后next({...request})；需要委托时传回原request。

准备处理器返回actions/resources/execution声明，暂不执行业务。执行处理器收到同一批准plan，可await request.progress(delta)，也可用request.execution.run()执行批准的命令；call.deps仍由普通middleware调用上下文提供。tools统一校验结果与outputSchema，进度超限失败会锁存，忽略失败不能伪装成功。贡献者自报bytes或未知字段被拒绝，目录预算由tools计算。

createToolPlugin提供参数类型推断与较少的模板代码，它使用同一公开处理链，普通插件无需依赖它。
