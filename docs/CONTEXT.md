# CONTEXT：Context/插件契约

> 状态：**重建中**。初版（M1 地基，455 行）随 `feat: plugin` 批次的文档清理删除；本文件按
> **现行实现**重建，本节先落「依赖解析宪法」与「装配边界护栏」——装配接线的唯一裁决表。
> 全量契约（总线四模式 / scope 层链 / effect 账本 / 插件加载器语义矩阵）重建归后续件；
> 代码内历史 § 引用按本文件重锚。

## 1. 依赖解析宪法（2026-09-19 定——「共享一个对象一天走了三种接法」的实证后收敛）

| 需求形态 | 接法 | 语义 | 实例 |
| --- | --- | --- | --- |
| **硬依赖**：缺了本插件无意义 | `inject: ["插件名"]` + apply 内 `ctx.use(token)` | 拓扑序保证先行；缺席/迟到 = 装配期 throw | task-tools→tools；agent-delegation→task-tools |
| **可选服务**：在场即用、缺席是另一种合法形态、**允许对方晚装** | `ctx.waitFor(token)` 停靠 | 可见即解析，否则停靠至服务在可见层出现；等待层 dispose = reject（停靠作废） | task-tools→backgroundTasks（tool-bash 可不在场） |
| **可选事实**：只取「此刻在不在场」，缺席不等待 | `ctx.tryUse(token)` | nearest-first 立即查；缺席 = undefined，降级语义归调用方 | createToolPlugin→permissionGrants（缺席=无扩展根） |
| **配置注入**（覆盖/显式） | 工厂参数 | 宿主显式传值，优先于服务解析 | env 工厂参数 > execEnv 服务；bashTasks 显式参 > 停靠 |

裁决规则（冲突时的唯一取舍）：

1. **共享对象一律服务**：提供方 `provide`，消费方按上表解析。禁止两个插件经工厂参数共享
   同一实例——装配序依赖 + 无单主生命周期；工厂参数只表达「覆盖/显式配置」。
2. **可选依赖一律 waitFor**：tryUse 仅当消费方对「此刻不在场」本身有语义（如 permission
   缺席=无扩展），否则会错过迟到装配者。
3. **inject 与 use 成对声明**：inject 是插件名（加载序约束），服务 token 是解析键。只
   inject 不 use = 声明未兑现；只 use 不 inject = 时序赌注。

## 2. 装配边界护栏（2026-09-19）

loadPlugins 是插件进入 ctx 的唯一入口，边界处 fail-fast：

- **工厂函数冒充插件**：具名函数自带 `name` 与 `Function.prototype.apply`，结构上满足
  Plugin 接口骗过类型检查——装配期 throw 并点名调用法（`plugin is a factory function,
  not a plugin — call it: xxx()`）。症状（无护栏时）：apply 变成「无参调用工厂」，副作用
  不发生 + 返回对象进 unwind 链。
- **apply 返回值必须是 disposer 函数或 void**：其他形态装配期 throw（否则 dispose 期
  深处 `unwind is not a function`）。
- **已知缺口（落档）**：Plugin 无编译期品牌位——具名函数仍能通过类型检查（结构类型的
  固有洞，运行时护栏兜底）。根治 = 品牌位 + `definePlugin` 铸造，需扫全部插件字面量
  （产线 24 + 测试 92 处），待 llm 在途批次落地后独立件实施。

## 3. 契约速查（按现行实现，全量重建前的事实锚）

- `provide/use/tryUse/waitFor`：服务 nearest-first 遮蔽；waitFor 停靠到可见层出现。
- `on/emit`：四模式总线（emit 错误隔离 / waterfall 洋葱 / serial 顺序 / guard 否决 /
  parallel 异步屏障）。
- `effect`：账本串行逆序回卷，单个 disposer 抛错不中止（聚合上抛）。
- `loadPlugins`：inject 拓扑序 apply；单插件 throw → 整体 ctx.dispose 回卷；apply 返回
  disposer 与层回卷共用哨兵绝不双跑。
