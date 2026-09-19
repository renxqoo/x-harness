# W2B 迁移文档：删 AgentOptions.tools 通道 + CLI/REPL/delegation 迁移

> 状态：定稿（2026-09-20 对抗审查处置后；依赖 W2A）
> 迁移单元：白名单唯一真相迁至 registry 会话层；REPL 切换路径单点重注册（审查 F-2 处置）
> 旧实现：`AgentOptions.tools`/`ResolvedOptions.tools`（types.ts:21 / step.ts:42）；CLI 合成（resolve-agent-options.ts）；REPL spread 继承（main.ts:305 baseOptions → run-repl.ts:138-172 makeNext）
> 关联：ELEVATION-DESIGN §2.3；MIGRATION-W2A

## 1. 行为规格基线

等价矩阵（每条迁移后逐项成立，含 REPL 三场景——审查 F-2）：

| # | 场景 | 现行 | 迁移后 |
|---|---|---|---|
| 1 | create（任意 flag 组合） | options.tools 恒定义（无 flag=全量快照，resolve-agent-options.ts:26） | create 后恒注册 restriction（无 flag=全量名单——**恒注册是 narrowTools 语义保真必要条件**，保持「父名单恒可读」） |
| 2 | resume 无 flag | tools undefined → 全集（放开） | 不注册 → restrictionOf=undefined → narrowTools(undefined)=typeTools（同现状） |
| 3 | resume 带 flag | 显式名单 | resume 后注册 restriction |
| 4 | REPL `/new` | baseOptions.tools spread 继承 | makeNext create 分支：从 CLI flag 状态重注册（新 session id） |
| 5 | REPL `/model`（dispose→同 id resume） | spread 继承 | dispose 触发 sessionDisposed→restriction 注销；resume 分支 makeNext **重注册**（同 id） |
| 6 | makeNext 兜底（resume 失败→create） | spread 继承 | create 分支重注册 |
| 7 | `--system-prompt` 静态串优先 | step.ts:138 | 不变 |

**关键裁决（F-2 处置）**：REPL 的 `makeNext`（run-repl.ts:142-172）是**单点重注册咽喉**——create/resume/兜底三分支统一「从 CLI flag 状态重演 restriction」。disposer 维持挂 sessionDisposed（与 W2A 一致）：/model 的 dispose→resume 闭环由重注册补齐；/new 的新 id 由 create 分支补齐。**两种挂法各丢一头的两难不存在**。

## 2. 审计结论引用

IMPLEMENTATION §1 F3（run-repl spread 路径 typecheck 不报错）；DESIGN §6。

## 3. 逐模块裁决表

| 模块 | 裁决 | 动作 |
|---|---|---|
| agent-loop types.ts:21 + step.ts:42 | **删字段** | `tools` 通道移除（此刻 typecheck 全仓暴露残留引用=W2A 漏网） |
| apps/cli resolve-agent-options.ts | **改写** | 删 tools 合成；`resolveToolNames` 纯函数保留（re-registration 消费）；**注释勘误**：「不静默放开」→「无 flag=显式全集（与现状等价）」 |
| apps/cli main.ts | **改写** | create/resume 成功后注册初始 restriction（§1.1/1.3） |
| apps/cli run-repl.ts | **改写** | makeNext 三分支统一重注册（§1.4-1.6）；slash 面（slash-commands.ts:86/93/110/126/135）不动 |
| agent-delegation | 核查 | W2A 已迁；本波 typecheck 复核零残留 |
| checkpoint/session-mailbox/todo-tools/compaction | 核查 | 行为官已确认零命中（compaction summarize.ts:185 `tools:[]` 是 LLM 请求参数非通道）——预期 no-op，如实记录 |

## 4. API 对照表

| 旧 | 新 | 理由 |
|---|---|---|
| `AgentOptions.tools` | （删除） | D2 通道统一 |
| baseOptions spread 继承 | makeNext 重注册 | F-2：spread 路径 typecheck 盲区 |

## 5. 测试迁移矩阵

| 旧测试 | 去处 | 动作 |
|---|---|---|
| resolve-agent-options.test.ts 工具矩阵 | 拆分：resolveToolNames 纯函数测原位；options 形态测改写（无 tools 字段断言） | 改写 |
| resolve-agent-options.test.ts:47-50（resume 无 flag） | 原位语义保持 + 注释勘误 | 改写 |
| （新增）REPL×flag 矩阵：/new、/model、兜底三分支白名单保持 | apps/cli | 新增（F-2 专项——**typecheck 抓不到的路径**） |
| （新增）e2e：--tools 全旅程（create→/new→/model）工具面不放宽 | e2e | 新增 |

## 6. 回滚方案

单波提交可 revert；W2A 的 registry 面独立成立（回滚本波仅恢复通道字段）。

## 7. 验收

- [ ] 四门全绿；§1 矩阵 7 条逐项等价核对（对抗审查对照）
- [ ] grep `options.tools` 全仓零命中（通道死透）
- [ ] REPL×flag 矩阵全绿（F-2 闭环）
