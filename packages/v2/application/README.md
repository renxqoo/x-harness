# 声明式插件装配

createApplication 创建独占装配权的宿主。setPlugins 提交完整插件集合，以 Plugin.name 为唯一标识。它返回 Result<ApplicationSnapshot>：ok 表示装配请求已处理；必须检查每个条目的 active/pending/failed，才能判断业务是否全部就绪。无效声明、重复提供者、名称冲突和依赖循环在停止运行中实例前拒绝。

```ts
import { definePlugin, defineService } from "@x-harness/core";
import type { Result } from "@x-harness/core";
import { createApplication } from "@x-harness/application";
const defined = defineService<{ read(input: void): Promise<Result<string>> }>({
  name: "demo/store",
  methods: { read: {} },
});
if (!defined.ok) throw new Error("Invalid contract");
const store = defined.value;
const consumer = definePlugin({
  name: "consumer",
  requires: { store },
  setup() {
    return { ok: true, value: undefined };
  },
});
const provider = definePlugin({
  name: "provider",
  provides: { store },
  setup(ctx) {
    return ctx.service({
      store: {
        async read() {
          return { ok: true, value: "ready" };
        },
      },
    });
  },
});
const created = createApplication();
if (created.ok) {
  const app = created.value;
  try {
    await app.setPlugins([consumer]);
    const assembled = await app.setPlugins([consumer, provider]);
    if (assembled.ok && assembled.value.plugins.every((entry) => entry.state === "active")) {
      const service = app.use(store);
      if (service.ok) await service.value.read();
    }
  } finally {
    await app.close();
  }
}
```

必需依赖缺失时保留 pending，提供者出现后激活。替换、移除提供者会先排空传递消费者，再重新装配；可选依赖出现/消失同样适用。旧服务门面失效，不转向新实例。复用同一冻结插件定义会保留实例；新插件对象代表替换，传入可变对象时也比较已验证声明快照。修改配置可重新构造同名插件后 setPlugins。

snapshot() 只返回不可变状态和受限错误，不含 token、插件对象或函数。inspect()/diagnostics() 是内核诊断视图。use()/dispatch() 用于业务调用，没有绕过装配器的 install/uninstall 入口。

默认最多128个期望插件和32个排队操作；正在执行的操作不占排队数量。操作串行，setPlugins 调用时即校验和复制声明。独立插件激活失败显示 failed，依赖它的条目 pending；refresh() 重试期望集合。旧实例实际工作未结束、清理失败时拒绝替换，不发布重叠实例；工作迟到结束后 refresh() 可以继续。永久清理失败需要排查并重启宿主。

close() 立即阻止新操作并请求取消宿主工作，返回内核关闭结果；取消不能强行终止函数。应用内部创建 Host，宿主能力不向插件泄露。文件监听和进程重启由外围适配器负责。
