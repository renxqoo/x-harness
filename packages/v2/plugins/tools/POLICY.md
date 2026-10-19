# 接入权限策略

权限插件使用普通definePlugin和ctx.guard，不需要专用插件工厂。toolAccess负责list/get/execute基础准入；toolExecutionAccess收到完整计划，负责本次执行许可。下面的普通插件将执行审批交给宿主函数；宿主可以根据actions只对文件写入询问，也可以接入独立审批服务。

```ts
import { definePlugin } from "@x-harness/core";
import { toolAccess, toolExecutionAccess } from "@x-harness/tools";
import type { ToolExecutionPlan } from "@x-harness/tools";

export function applicationPermission(
  askUser: (plan: ToolExecutionPlan, signal: AbortSignal) => Promise<boolean>,
) {
  return definePlugin({
    name: "application-permission",
    requires: { toolAccess, toolExecutionAccess },
    setup(ctx) {
      const access = ctx.guard("toolAccess", () => ({
        ok: true,
        value: { kind: "allow" },
      }));
      if (!access.ok) return access;
      return ctx.guard("toolExecutionAccess", async (authorization, call) => {
        const approved = await askUser(authorization.plan, call.signal);
        if (!approved || call.signal.aborted) {
          return { ok: true, value: { kind: "deny", reason: "not-approved" } };
        }
        return authorization.allow({ signal: ctx.signal });
      });
    },
  });
}
```

搭配createToolsPlugin()默认required模式安装。基础准入允许不会替代完整计划许可：无权限插件、无授予许可的guard、异常、拒绝或无效grant都不能执行。裸kind:allow表示不否决；授权执行须返回authorization.allow({signal:ctx.signal})。任一guard拒绝优先，其他允许不能覆盖。access:allow只用于宿主明确选择全部允许的应用，它登记默认许可，仍不能覆盖其他策略拒绝或已撤销许可。

authorization.allow只在本次检查期间有效，最多128次登记。signal绑定授予者安装生命周期；revocation可接外部授权的AbortSignal；isValid在实际提交前必须同步返回true。保存到检查结束后的allow只返回拒绝，不再保留请求状态。权限插件卸载撤销已经准备的许可；required模式失去唯一授予者后新请求也拒绝。运行中撤销请求取消，资源锁和容量等实际执行结束才释放。

等待用户不占执行槽或资源锁，但受调用signal和deadline约束，宿主应取消已经结束的问题并丢弃迟到回答。用户身份来自宿主可信认证服务，不能从工具input自报。硬限制适合放在toolAccess或完整计划guard中；审批展示完整效果和实际修改差异，不能仅凭工具名称或一个允许路径判断整条命令。文件插件负责规范化路径和执行前的文件状态检查，沙箱负责隔离。

createToolPolicyPlugin是可选便利封装，内部也通过同一公开authorization.allow登记ctx.signal及外部撤销条件；普通插件获得相同的校验、撤销和执行边界。
