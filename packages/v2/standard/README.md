# 标准插件

本包通过 core 公开入口实现日志、定时器和 JSON 配置，不进入内核。所有工厂返回 Result，插件通过 Host.install 安装。

## 日志

createLoggerPlugin({ write, level?, now? }) 创建日志插件。logger 是共享服务 token，提供 debug/info/warn/error，参数为 { message, fields? }。默认级别 info；write 接收冻结 LogRecord 和取消 signal，宿主决定输出到控制台、文件或远端。记录最多64KiB，消息最多4096代码单元；异常转换为中性错误。

## 定时器

createTimerPlugin({ scheduler? }) 提供 timer.sleep({ ms })，等待受当前调用期限和取消信号控制。延迟为0至2147483647的整数。

createTimer(ctx, { scheduler? }) 创建绑定当前插件的定时器工具。timeout({ ms, run, label?, timeoutMs? }) 和 interval(...) 返回 ScheduledTask，提供 cancel、state、finished。run 的 call 保留 ctx 的依赖类型；默认每次任务使用宿主调用期限。interval 的间隔至少1毫秒，按上一次任务真实完成后的间隔安排，不重叠；任务失败停止续调。它由资源持有定时器，每次触发才创建有限任务，因此可跨多次调用期限持续运行。TaskHandle.finished 会等待子工作；超时和取消不能提前启动下一轮。

关闭插件会停止定时器、取消当前任务并等待实际结束。ScheduledTask.finished 等待操作和资源清理，取消结果为cancelled。无法强制结束的回调会保留真实工作及资源账本，由宿主关闭期限报告。

## 配置

createConfigPlugin({ name, initial, validate }) 返回 { plugin, config, admin, changed }。validate 是 core.Validator，只接收已经安全复制的 JSON；初始值和更新结果均再次复制冻结。

config.get(undefined) 返回 { revision, value }。admin.update(value) 校验并提交配置。读写 token 分开，读者不声明 admin 即无法写入。changed 发出 { revision }；队列无法接受通知时不提交更新。初始revision为0，每次有效更新递增。重复安装同一plugin定义时，各实例状态独立。

服务协议保持 Promise<Result>。配置文件读取、日志持久化和自动重装由宿主或外围插件承担。

## 组合示例

```ts
import { createHost, definePlugin } from "@x-harness/core";
import { createLoggerPlugin, logger, createTimer, createConfigPlugin } from "@x-harness/standard";
const settings = createConfigPlugin({
  name: "demo",
  initial: "hello",
  validate: (value) => ({ ok: true, value: String(value) }),
});
const logging = createLoggerPlugin({
  write(record) {
    console.log(record.level, record.message);
  },
});
const created = createHost();
if (created.ok && settings.ok && logging.ok) {
  const app = created.value;
  try {
    await app.install([
      logging.value,
      settings.value.plugin,
      definePlugin({
        name: "heartbeat",
        requires: { logger },
        setup(ctx) {
          const timers = createTimer(ctx);
          if (!timers.ok) return timers;
          return timers.value.interval({
            ms: 1000,
            run(call) {
              return call.deps.logger.info({ message: "alive" });
            },
          });
        },
      }),
    ]);
  } finally {
    await app.close();
  }
}
```

定时工具本身不登记宿主取消监听；每个实际 schedule 由资源拥有。丢弃工具不会在长期宿主上积累监听和 scheduler。插件/工作撤销时，派生作者能力和依赖门面释放 token 与上下文引用，保留旧工具或门面仍不能使用已关闭能力。
