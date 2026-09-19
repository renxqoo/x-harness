# 架构升格施工图（ELEVATION-IMPLEMENTATION）

> 状态：**定稿**（2026-09-20 三路对抗审查处置完毕）。设计基线：docs/ELEVATION-DESIGN.md（同一决策只在彼处定义）。

## 1. 现状事实核查结论（「旧实现审计」对应物）

- **F1** system/message 落盘链路完整：step.ts:135-151（anchorSystem：无锚 append/漂移 replace[seq,seq]/相同 no-op）、step.ts:114+256（deriveMessages 纯折叠）、agent-delegation lineage.ts（forkSeed :59-73 / recastSurface :78 起）、compaction serialize.ts:156+estimate.ts:35、session gates.ts:126+types.ts:45+surface.ts。**修正早前对表结论「prompt 不落盘」——缺口不存在。**
- **F2** scope 链原语在 core（create-context.ts:426 `scope(filter)`、服务沿链解析 :291-295）**有消费方**：agent-loop plugin.ts:116/137（`ctx.scope({ agentId: "agent:<sessionId>" })` 前缀映射层键）；plugin-manager install.ts:148/worker host.ts:252。**registry 无分层消费**（system-prompt registry.ts 单 Map；tools registry.ts 单 Map）——「分层是移植不是重写」就 registry 而言成立。
- **F3** `AgentOptions.tools` 通道**消费方全集**（行为官核查）：agent-loop step.ts:204（投影）+ **step.ts:335（→ tool-calls.ts:27-48/80/93/108 `allowedTools`/`denyNotAllowed` 执行面拦截，配对落账 tool-not-allowed；types.ts:20「双执法」契约注释；delegation.test.ts:333-353 X15 专测）**；apps/cli resolve-agent-options.ts；agent-delegation spawn.ts:142（narrowTools，tools 写入 :146）+ plugin.ts:138（parentToolsOf 读取）+ revive.ts:82（消费）；**apps/cli run-repl.ts:138-172（baseOptions spread 隐式继承——typecheck 盲区）**；main.ts:305（baseOptions 装配）。e2e/冷门包（checkpoint/mailbox/todo/compaction）零命中（compaction summarize.ts:185 `tools:[]` 为 LLM 请求参数）。
- **F4** tool-core 四条功能性停靠边（execEnv:40/permissionGrants:46/sessionDisposed:55/toolRegistry:54）；guidance 投稿为表现性依赖——D3 后合法（上层→内核方向）。
- **F5** workspaces `packages/*`+`apps/*`（package.json:6-9）；包名不含目录→src import 零变更；**但**路径字面量引用存在：vitest.config.ts:5,8、tsconfig.json include、根 build 脚本、tool-bash bash.test.ts:185-187 与 tool-grep grep.test.ts:293-295 子进程脚本（W0 §3 全列）。
- **F6** `check` = typecheck+lint+build+test+e2e（package.json:17）；144 测试文件静态计数；覆盖率 92.1% 语句/1704 用例（2026-09-20 实测）。
- **F7** tool-bash host-exit 用例（bash.test.ts:177 起）时序敏感偶发红（预存，stash 验证）。
- **F8** `ToolDefinition.guidance`（tools/src/types.ts:41）+ apps/cli `toolGuidanceBridge`（build-world.ts:66-83）已实施（2026-09-20）。
- **F9** llm 层不校验 tool_use 名（pi-context 仅块整形）——「模型不可见即不可调」前提为假（设计官核证）。
- **F10** permission 包无工具名白名单机制（mode/路径门禁）——原「执行门禁归 permission」为空归属。

## 2. 逐模块裁决表

### 2.1 包迁移（W0）

28 包中迁 5 入 `packages/core/*`：context（现 core，名不变）、tools、system-prompt、exec-env、session——判据「被全体依赖的稳定契约面+零领域知识」。其余 23 包原位（agent-loop 依赖 llm 非内核；session-checkpoint/persistence 为 session 契约提供方属上层）。详表见 MIGRATION-W0 §3。

### 2.2 代码模块（W1/W2A/W2B/W2C/W3）

| 模块 | 裁决 | 动作 | 单元 |
|---|---|---|---|
| tool-core 停靠 + 桥删除 + wellKnown + text 函数形 + e2e 四 journey 重排 + 两处陈旧注释勘误 | 改写/删除/扩展 | 见 MIGRATION-W1 §3 | W1 |
| tools registry 分层 + restrictionOf + step 双点改喂投影（**执行面保留**） + delegation 三点 | 重构/改写 | MIGRATION-W2A §3 | W2A |
| 删通道字段 + resolve-agent-options 改写 + main 初始注册 + **run-repl makeNext 单点重注册** | 删/改写 | MIGRATION-W2B §3 | W2B |
| prompt registry 会话层（锚定子集+双向缓存）+ anchorSystem 传参 | 重构/改写 | MIGRATION-W2C §3 | W2C |
| 断言三口径 + 指纹观测 + host-exit 处置 + 文档收口 | 加法/标注 | MIGRATION-W3 §3 | W3 |

## 3. 拆分决策

- **依赖门禁（强形式——审查 V5 处置）**：`scripts/check-kernel-deps.ts` 扫 `packages/core/*/src` 的 **import 说明符**（非仅 package.json 声明——devDeps 藏边是真实违规形态，仓内 agent-delegation 已有先例形态），断言每个外部/@x-harness 说明符 ∈ 允许集 = {core 组五包, node 内置, `@sinclair/typebox`（D5）}；再断言 src 无未声明说明符。挂 check 流水 typecheck 之后。
- **wellKnown 词汇表**落 system-prompt 包；`baseCore` 别名一个版本周期。
- **缓存**：根层缓存独立 + 合并缓存键=(根版本,会话版本) 双向失效（DESIGN §2.1）。

## 4. 测试计划

- 行为等价基准：现有 1704 测试全绿为每波必要条件；**W2A 锚 = delegation X15 双执法专测零改写**。
- 新增必测清单分列各 MIGRATION §5（W0 门禁四用例/W1 fn 段三用例/W2A restriction 泄漏与执行面/W2B REPL×flag 矩阵/W2C 锚定子集与确定性/W3 断言三口径）。
- 覆盖率 ≥92.1% 语句；禁止调低阈值换绿。

## 5. 实施顺序（波次与验收点）

| 波 | 单元 | 验收点 | 文档 |
|---|---|---|---|
| W0 试运行 | 内核分组+门禁 | **144/1704 逐项相等**（否决级）+ rename 100% + 门禁四用例 + 对抗审查 | W0 |
| W1 | 投稿式 | CLI prompt 逐字节一致 + 桥零残留 + D6 约束下停靠必中 | W1 |
| W2A | tools restriction+读回+执行面 | X15 专测零改写 + 孙代收窄 + 泄漏 | W2A |
| W2B | 删通道+CLI/REPL 迁移 | §1 七条矩阵 + grep 通道死透 + REPL×flag | W2B |
| W2C | prompt 分层机制 | prompt.test 零改写 + 锚定子集 throw + 确定性 | W2C |
| W3 | 不变量+观测+核销 | 三口径双态 + 全套核销清单 | W3 |

每波：四门 → 对抗审查（独立上下文）→ 处置 → 提交；**每波单提交独立可 revert**（W2 拆三波后该口径成立）。
