# 接入权限策略

策略使用普通core guard，list/get/execute分别授权。这里展示仅允许一个名称的确定性策略；真实用户身份应来自宿主受信任的认证服务，不能从工具input自报。

```ts
import { definePlugin } from "@x-harness/core";
import { toolAccess } from "@x-harness/tools";

export const policy = definePlugin({
  name: "tool-policy",
  requires: { toolAccess },
  setup(ctx) {
    return ctx.guard("toolAccess", (input) => ({
      ok: true,
      value: input.tool.name === "echo"
        ? { kind: "allow" }
        : { kind: "deny", reason: "tool-not-allowed" },
    }));
  },
});
```

搭配createToolsPlugin()默认required模式安装该插件。多个guard由core合并，任何deny优先；规则异常不会自动放行。审批等待受调用signal与deadline约束，规则实现也须合作取消。
