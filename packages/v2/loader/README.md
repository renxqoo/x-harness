# Bun 插件加载与热更新

createLoader({ entries, shared?, watch?, debounceMs?, maxImports?, importTimeoutMs?, application? }) 返回 Promise<Result<Loader, LoaderFault>>。entries 是绝对文件路径列表，每个模块默认导出一个 Plugin。加载器拥有 application，外部通过 use/dispatch 调用业务，通过 snapshot/inspect/status 观察，通过 reload 手动重新构建，通过 close 关闭。依赖 Bun，平台无关的内核不依赖本包。

```ts
import { createLoader } from "@x-harness/loader";
const created = await createLoader({
  entries: ["/srv/example/plugins/database.ts", "/srv/example/plugins/http.ts"],
  shared: {
    "example-contracts": {
      path: "/srv/example/contracts/index.ts",
      directory: "/srv/example/contracts",
    },
  },
  watch: true,
});
if (created.ok) {
  const runtime = created.value;
  const snapshot = runtime.snapshot();
  if (snapshot.plugins.some((plugin) => plugin.state !== "active")) await runtime.reload();
  await runtime.close();
}
```

契约目录独立于可热更的实现目录。宿主从 shared.path 导入自定义 token，插件用配置的 specifier 或该目录中的实际路径导入同一模块。全部官方 SDK 公开入口由 sdk/src/index.ts 统一声明，包含 Agent、LLM、Tools、调度器、会话和执行包；公开包名、源码入口和构建入口统一连接同一源码模块身份，无需额外配置 shared。构建器使用同一清单，平台门禁核对清单与各 package.json 的 exports 完全一致。用户私有实现及其他依赖打进各自的单一 ESM 产物，不拆 chunk。插件私有模块不能自行动态加载其他私有文件。产物用 Acorn 解析，拒绝剩余动态 import、计算式 require、import.meta 非直接 url/main 读取能力（包括 require 解构、动态属性、反射）和未允许的外部静态依赖。普通静态 require/import 可以被完整打包。框架 SDK 和共享契约属于稳定代码，修改 SDK 应重启进程。

运行时识别的 Node 与 Bun 内置模块允许作为静态外部依赖，包含 `node:path`、`path` 和 `bun:sqlite`。构建前后的模块名称统一校验内置身份及 Bun 解析后的内置身份；只有运行时能够解析为内置模块的名称才通过。未知的 `node:`、`bun:` 名称和带路径逃逸的伪造名称不能仅凭前缀通过。其他外部静态依赖仍须属于 SDK 公开入口或显式配置的 shared 边界，动态加载限制保持相同。

LoaderFault 的 phase 标识 sdk、shared、watch、build、import、validate 或 close；定位到某个入口时提供0至127的 entryIndex，对应 options.entries 的零基索引。错误不包含文件路径、源码、构建器输出或异常消息；宿主可用自己的入口配置定位文件。status().error 保留同一有界诊断，成功 reload 后清除；需要重启时后续 reload 保留原诊断。

构建和导入均在发布前完成。语法或导入失败保留当前插件集合；清理未收敛时 application 阻止替换。多个入口的构建/导入失败不发布半份新集合；激活阶段按 application 的逐条 active/pending/failed 状态报告，不宣称跨插件业务事务回滚或零中断。

官方 SDK 源目录和内部平台元数据使用有界内容指纹，排除 `__test__`；最多2048个条目、单文件1MiB、合计16MiB。每次发布前后复核，变化或无法读取时保留当前实例并返回 restart-required。加载 Loader 模块时取得的首个 SDK 指纹通过进程级端口固定，同一 SDK 的源码和构建加载器共享该基线；新建 Loader 不能接受同进程内变化的 SDK。端口最多记录64个 SDK 根，达到上限同样要求进程重启。

watch 合并变更，最多保留一个后续刷新标记。默认延迟25ms。入口、官方 SDK 源目录和 shared 目录递归监听，构建发现的私有依赖目录也监听；构建失败仍登记新目录。按路径、设备号、inode和递归模式复用未变监听，新增登记成功后才关闭过期监听；登记失败只回滚新增项。

运行中的 watch 实例遇到构建或监听失败，会在100/200/400/800/1000ms后复核，后续间隔封顶1000ms且不短于debounceMs。只有一个恢复计时器且构建串行；新文件事件按debounceMs提前触发复核，成功后停止重试并清零退避。无效构建保留当前服务，不消耗新模块的导入预算。导入、插件校验与激活失败不自动重试，避免重复副作用；修正代码后可由尚存监听的文件事件或手动reload触发；这类失败后若全部监听也失效，需要宿主手动reload，成功后重新允许故障补偿。watch=false不启用后台恢复，初始创建失败仍关闭并返回错误。

操作系统事件不是可靠消息；成功状态下静默丢失的变更仍需部署系统主动调用 reload 校验。close 先关闭监听和所有延迟回调，再取消应用并排空正在进行的加载操作，不会在关闭后发布迟到结果。restart-required也停止后续恢复。

JavaScript 模块缓存不能卸载。进程全局 Symbol 端口将所有加载器副本的导入预算合计限制为64，源码与构建入口共享；默认单加载器上限也是64，可通过 maxImports 降低。每次新模块的导入尝试都会占预算，包括导入失败和顶层 await 超期；相同产物不重复导入；单个入口导入成功即保留准备缓存，后续入口构建失败也不会丢弃；已导入但尚未装配成功的定义也保留准备缓存，清理迟到收敛后的重试不额外占预算。初始装配失败且宿主关闭未收敛时要求重启进程。status().imports 是该加载器已使用的尝试预算。达到预算、共享目录改变、导入超过默认5秒期限时返回 restart-required，保留可用实例，由外部进程监督重启。预算不是安全沙箱，模块仅接受可信代码；模块顶层不能创建未登记副作用。无限同步循环和宿主外副作用由进程隔离与监督处理。

单产物最多1MiB。shared最多32项，快照最多1024个文件系统条目、单文件1MiB、总16MiB，拒绝符号链接；shared目录中任意内容或空目录变化要求重启。监听路径最多512个，已删除的私有目录会从监听集合清除，达到界限要求重启。临时构建产物在导入成功、失败和超期后均删除；模块缓存的内存只可通过进程结束释放。

构建接口与扩展点依据 [Bun Bundler](https://bun.sh/docs/bundler) 和 [Bun 插件文档](https://bun.sh/docs/bundler/plugins)，行为由真实 Bun 构建、文件监听和 HTTP 服务切换测试验证。
