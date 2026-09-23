# PLUGINS：正式插件区与 host-hub 装载 方案

> 状态：已核销（实施于 622efe9/e9e9ae9/本提交；两轮对抗审查 13+9 项发现全处置）
> 级别：中（跨层新增外部契约：插件包 / hub 设置 / worker 装配 / 协议命令）

首个正式插件 `token-analytics` 从 plugin-examples 示例集升格为独立包，host-hub 经
`@x-harness/plugin-manager` 在装配期装载，读侧以新命令 `get_token_analytics` 消费。
本机制为后续所有内置正式插件复用（词表驱动）。

## 契约

### 1. 插件包 `@x-harness/token-analytics`（packages/token-analytics/）

- 命名导出与现 plugin-examples 实现逐字等价（零行为变化）：
  `tokenAnalyticsPlugin(options: TokenAnalyticsOptions): Plugin`、
  `tokenAnalyticsService: ServiceToken<TokenAnalyticsService>`、
  类型 `TokenBreakdown / TokenAnalyticsOptions / TokenAnalyticsService`；
- 新增 `export default`：零参构造的 Plugin 实例——plugin-manager `validateModule`
  的装载形状（`{ name: "token-analytics", apply }`）。装载面不收 options：
  `contextWindow` 三级兜底（参数 > llmRuntime.contextWindowOf > 200k）已覆盖无参场景；
- `inject: ["system-prompt", "tools", "session"]`、`softInject: ["llm"]` 不变；
- **不变式：模块级零可变状态**——模块实例与 default 导出 Plugin 跨 world 共享
  （见并发预算），一切 per-world 状态只许住在 apply 闭包。

### 2. hub-settings 新键 `"plugins.disabled": string[]`

- 名单语义与 `skills.disabled` 先例一致：**缺省空 = 全部内置插件装载**（内置件随
  宿主依赖树分发 = 受信，缺省在场）；合并规则 = user ∪ project（并集）。
- 校验位点（与 skills.disabled 刻意不同）：**词表校验进 `validateSettingValue`
  单点**——形状（非空字符串数组）+ 成员 ∈ 内置词表；文件直读面与 `settings/set`
  命令面同判定，未知名成员 → 整键丢弃/拒收（安全向：回到全装载）。

### 3. host-hub 内置插件词表（src/shared/plugins-catalog.ts）

```ts
export const BUILTIN_PLUGINS = { "token-analytics": { module: "@x-harness/token-analytics" } } as const;
```

- 封闭集：settings 校验、装配装载、文档词表三方单一真相；
- 解析：`fileURLToPath(import.meta.resolve(module))` —— `import.meta.resolve` 在
  Bun 返回 **file:// URL 字符串**，必须经 fileURLToPath 规范化为绝对路径；roots、
  approveInstall 白名单、install path 三处**同源派生自同一次规范化结果**；
- dist 形态（bun build --external @x-harness/*）：自 dist 产物沿
  apps/host-hub/node_modules 与仓根 node_modules 双层向上解析；dist 冒烟含
  「产物未被内联本机绝对路径」断言（防 bundler 静态解析毁可迁移性——若实测被
  内联，改 `createRequire(import.meta.url).resolve()`，同源派生律不变）。

### 4. worker 装配期装载（src/worker/external-plugins.ts）

- 时序：`createAgentWorld` 成功后、`createSession` 前——usage 计数覆盖会话第一步；
  start/resume/fork 三路径共用 `assembleWorkerAgent`，时序均成立；
- 注入点（唯一）：`assembleThread` 公共腿——`fields.agentDir`（rt.agentDir）+
  `fields.pluginsDisabled` 与 settings 同构注入；**doFork 重装配同经公共腿**——
  start/resume/fork 三路同源**现读** settings（与 skills.disabled 先例一致；快照
  语义仅 thinkingFallback/permissionModeSource）；
- `agentDir` 缺席（测试直连装配等场景）→ 静默跳过外部插件装载（不写 cwd、不挂
  装配；该分支是测试常态路径，不噪）；
- 途经：`loadPlugins(world.ctx, [createPluginManager({ ctx: world.ctx, ... })])` 后
  逐个 `svc.install({ path, mode: "process" })`；
- 安全参数：`roots = [dirname(解析路径)]`、`approveInstall = 解析路径集合精确匹配`、
  `audit = <agentDir>/plugins/audit.jsonl`（显式传——plugin-manager 缺省审计写
  `roots[0]`，会污染插件包源码目录）；
- 失败降级：单件 install 失败（Result 或 **promise 拒绝**——loadModule 抛错）/
  解析失败 / 词表未知名 → stderr 告警 + 跳过（装配不挂；assembly 另有防御性
  兜底捕获）；
- 测试缝：`deps = { resolveModule?, loadModule? }` 可注入（同 AssemblyDeps 形态）——
  降级分支的覆盖率落点；
- 卸载时序：`teardownWorld` 先 `world.ctx.tryUse(pluginManagerService)`（undefined
  = 未装载，跳过）→ 逐个 `uninstall`（**失败仅 stderr 告警，必继续**）→ 再
  `world.unload` + `ctx.dispose`——uninstall 失败不得短路收殓（否则 world 泄漏）。

### 5. 新命令 `get_token_analytics`

- 入参 `{ threadId }`；线程域 + 观察者（不重置 idle）；
- 应答 `data: { breakdown: TokenBreakdown 全 12 字段, sessionOutput: number }`；
- 错误分族：**`requireThread` 先行**——无线程 → `unknown_thread`（消费方自愈语义
  不可劫持）；线程在场而插件缺席（禁用/装载失败/world 缺席）→ `capability_plugin`
  （`capability_*` 先例；进 HUB_ERROR_CODES 码表，`get_host_info.errorCodes` 自动携带）；
- 取用：`world.ctx.use(pluginManagerService).serviceToken("token-analytics")` 按名取
  token（host-hub 源码不 import 插件包符号——类型用本地结构形状；真解耦）；
- 统计域语义（固化现状，非缺陷）：**装配后事件**——resume 线程不含历史 usage
  （tapSessionEvents 只见装配后 append）；子代理会话的 usage 计入全局累计与
  lastReportedInput（per-session 经 sessionOutput 隔离）；
- 数据口径（实报优先律）：`total` = LLM 实报 input（输入侧——cache 读/写计入，
  不含 output；无实报时退 systemPrompt+tools 估算下限）；分项恒为估算
  （messages = 实报 − 前两项估算，负值归零）；估算器 CJK 感知（汉字 1 字 ≈ 1
  token，其余 ≈ 4 chars/token——中文为主的提示词不再被 chars/3.5 系统性低估）；
- 窗口解析序：参数 > 会话拨号查表（`llmRuntime.contextWindowOf(provider, model)`
  ——模型级 contextWindowByModel > 档案级；拨号来源 session/meta{dial} >
  request/context|request/header，与宿主 foldDial 同律）> 200k 兜底；装配后未轮
  的多适配器会话无拨号事实 → 兜底 200k（首轮后即精确）；
- `COMMAND_NAMES` 封闭集 60 → 61（头注同步）。

## 问题域

- 处理：示例插件升格正式包；host-hub 装配期经 plugin-manager 装载内置插件；
  按名 token 取用的读命令面；装载/卸载生命周期审计。
- 不处理（写清归属）：
  - 运行时管理面（`plugins/list|install|uninstall` 协议命令 + 审批 UI）——后续
    host 管理面任务；本次词表封闭集即其地基；
  - 词表外第三方路径装载（settings 文件不可注入任意路径代码——这是用符号名
    而非路径做配置的根因）；
  - 插件 options 经 settings 注入（default 实例零参已覆盖）；
  - resume 历史 usage 重放 / 子代理 usage 按主会话过滤——统计域语义已文档化
    （§5）；若未来要「会话全历史」，属插件能力扩展独立小方案；
  - worker（线程隔离）装载模式——内置受信件无需隔离，process 模式即生产形态；
  - agent-app 侧镜像（错误码表 + 命令清单对拍）——跨仓库挂账同步。

## 并发/一致性预算

- 装载：每 thread world 恰一次；词表基数 N（当前 1）次 install；**跨 world 重装
  （fork）= plain import 模块缓存复用**（loadCounts 是 per-installer 状态，bust
  分支在装载流不可达）——同模块实例、同 token 身份；per-world 隔离靠 apply 闭包
  状态与 per-installer token 表（契约 1 不变式为此存在）；
- tap 回调：O(1)/事件（数值累计 + Map 写），禁 IO；
- `breakdown()`：assemble + schemas JSON 序列化，观察者轮询预算 ≤10ms/次
  （@100 段/50KB prompt 的 assemble ≤1ms 既有实测为下界参照）；
- uninstall 在 teardownWorld 单线程收殓路径，无并发窗口（幂等哨兵既有三重）。

## 拆分

新文件：

| 文件 | 职责 |
|---|---|
| packages/token-analytics/package.json | 包定义（deps: core/plugin-api/session/llm/system-prompt/tools；dev: harness/testkit） |
| packages/token-analytics/src/token-analytics.ts | 插件实现（迁移；注释去版本叙事只留协议事实） |
| packages/token-analytics/src/index.ts | barrel + `export default` Plugin 实例 |
| packages/token-analytics/src/__test__/test-world.ts | 包级测试装置（参照 plugin-examples/src/test-world.ts，testkit scriptedAdapter） |
| packages/token-analytics/src/__test__/token-analytics.test.ts | 包级单测（迁移 round3 用例 + 无参兜底 + 多会话计） |
| apps/host-hub/src/shared/plugins-catalog.ts | 内置词表 + 解析糖 + disabled 判定 |
| apps/host-hub/src/worker/external-plugins.ts | 装配期装载 + teardown 卸载 + 服务取用糖（含 deps 测试缝） |
| docs/PLUGINS.md | 本方案 |

改文件：

| 文件 | 变更 |
|---|---|
| packages/plugin-examples/src/token-analytics.ts | 删（零双轨） |
| packages/plugin-examples/src/index.ts | 删两行导出 |
| packages/plugin-examples/src/__test__/examples-round3.test.ts | 删㉓ 用例块与 import |
| apps/host-hub/package.json | + `@x-harness/plugin-manager`、`@x-harness/token-analytics`（workspace:*；后者仅解析不 import） |
| apps/host-hub/src/shared/settings-store.ts | `plugins.disabled` 键（接口/校验含词表/isKnownKey/mergeSettings 并集） |
| apps/host-hub/src/worker/assembly.ts | AssemblyFields +agentDir?/pluginsDisabled?；装载调用；teardown 卸载 |
| apps/host-hub/src/worker/thread-commands.ts | assembleThread 注入（agentDir/pluginsDisabled）+ rt 快照 + doFork 补 fields |
| apps/host-hub/src/worker/worker-read-commands.ts | get_token_analytics handler + 注册 |
| apps/host-hub/src/protocol/commands.ts | COMMAND_NAMES +1（头注 60→61） |
| apps/host-hub/src/protocol/internal.ts | THREAD_SCOPED + OBSERVER 两集合 |
| apps/host-hub/src/shared/errors.ts | 能力族 + `capability_plugin` |
| apps/host-hub/src/__test__/contracts-frames.test.ts | `length===60` 锚 → 61 |
| apps/host-hub/src/__test__/smoke.test.ts | `length===60` 锚 → 61 |

依赖方向：token-analytics → 内核六包（与原 examples 同面）；host-hub →
plugin-manager（装载机制）+ token-analytics（仅 node_modules 链接供 resolve，
源码零 import）；settings-store → plugins-catalog（shared 内同层）。

## 实施顺序（每阶段独立提交、四门全绿）

1. **阶段 A**：新包落位 + plugin-examples 删净（行为等价迁移，单提交）；
2. **阶段 B**：settings 键 + 词表 + 装配装载/卸载 + 装载测试（单提交）；
3. **阶段 C**：命令面（协议/错误码/读侧/dist 冒烟）+ 测试全量 + 收口（单提交）。

过渡态：无双轨（A 步即删净旧实现——词表装载与示例导出不同时存在）。

## 裁决

- **用户裁决①**：外部落点 = packages/ 内独立包；
- **用户裁决②**：装载机制 = 装配期自动装载（经 plugin-manager，process 模式）；
- **用户裁决③**：消费面 = 新命令 get_token_analytics。
- 默认裁决（否决窗口内可改）：
  - settings 键形取 `plugins.disabled` 名单（非选项文案的 enabled 点名）——内置件
    缺省在场与 skills.disabled 先例对齐；
  - 配置用符号名而非路径——settings 文件是数据不是代码，不可成为任意路径装载入口；
  - 词表校验进 `validateSettingValue` 单点（文件面与命令面同判定，与 skills 的
    admin-commands 位点刻意不同——整键丢弃是安全向）；
  - 错误码 `capability_plugin`，且 `unknown_thread` 分族先行不被劫持；
  - 审计文件 `<agentDir>/plugins/audit.jsonl` 显式注入；
  - agentDir 缺席 = 跳过装载（不兜底 cwd——防审计污染仓根）。
- **审查修订**（对抗审查 13 项全处置）：resolve file:// URL 规范化与三处同源
  派生；agentDir 可选缺席降级；external-plugins deps 测试缝；fork fields 补齐
  （rt 快照同 thinkingFallback）；模块缓存复用机制改写 + 模块级零可变状态不变式；
  dist 内联断言；词表校验单点；错误分族序；两处 `length===60` 锚进改文件表；
  resume/子代理统计域语义固化；uninstall 失败不短路收殓；新包测试装置进拆分表。

## 测试口径

- 契约断言：COMMAND_NAMES 含 `get_token_analytics`（封闭集计数 61）；THREAD_SCOPED
  ∪ OBSERVER 含新名；HUB_ERROR_CODES 含 `capability_plugin`；BUILTIN_PLUGINS 键 ==
  文档词表（封闭性对拍）；
- settings：`plugins.disabled` 表驱动（非数组/空串成员/未知名成员 → 整键拒或丢，
  合法名过）；mergeSettings 并集；坏文件/未知键降级；
- 包级：分项估算 + 实报数字 + 余量/利用率 + 多会话独立计 + 无参兜底（runtime 缺席
  → 200k）+ default 导出形状（name/apply）；
- 装载：缺省全装载（serviceToken 在场）/ disabled 跳过 / agentDir 缺席跳过 /
  resolve 失败降级 / install 失败降级不打挂装配（deps 缝注入坏 loadModule）/
  teardown 后审计含 install+uninstall 恰好各一次 / uninstall 失败不短路收殓；
- 命令：script adapter world prompt（usage 事件）→ get_token_analytics 断言
  lastReportedInput/totalOutputTokens/sessionOutput；插件缺席 → `capability_plugin`；
  无线程 → `unknown_thread`（requireThread 先行回归）；resume 统计域=装配后事件
  （固化现状）；
- dist 冒烟：dist 形态装载解析（node_modules 链）+ 命令应答 + 产物无内联本机
  绝对路径断言；
- 回归：开发中发现的每个 bug 带症状命名用例。

## 验收清单

- [x] 契约 1-5 逐条（包导出面/settings 键/词表/装载时序与降级/命令应答形状与分族）
- [x] 不处理清单归属逐条落档
- [x] 并发/一致性预算逐条（装载恰一次/模块缓存复用与零可变状态/tap O(1)/
      breakdown ≤10ms/uninstall 单线程不短路）
- [x] 四门全绿 + 覆盖率数字如实报告（行/语句/函数 ≥90、分支 ≥85 不降）——
  2436 用例；语句 90.94 / 分支 86.28 / 函数 91.68 / 行 92.99
- [x] 零双轨核验：plugin-examples 无 token-analytics 残留引用（grep 零命中）
- [x] agent-app 侧镜像同步挂账明示（错误码表 capability_plugin + 命令清单
      get_token_analytics + COMMAND_NAMES 计数 61——跨仓库待同步）
