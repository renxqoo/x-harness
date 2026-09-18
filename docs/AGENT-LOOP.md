# Agent Loop 里程碑纲领（执行大方向）

> 状态：定稿（纲领；各件详细方案见独立文档，逐件走完整开发流程）
> 级别：大（六件独立交付物，每件独立文档 + 独立对抗审查 + 独立提交点）
> 参照：deepseek-harness `packages/core/agent-loop` 及其协作者。
> 用户裁决（2026-09-18）：①范围=三件套一次闭环；②收件箱=扩词表落账；③检查点=独立插件；④system prompt=完整 prompt 件；⑤每件独立详细文档、完整流程。

## 1. 交付物清单与文档索引

| # | 交付物 | 独立方案文档 | 状态 |
| --- | --- | --- | --- |
| 1 | session 扩展：inbox 词条 + 可验证续写 + header 覆盖 | docs/SESSION-RESUME.md | 已收口 |
| 2 | @x-harness/tools：注册表 + 执行管线 | docs/TOOLS.md | 已收口 |
| 3 | @x-harness/system-prompt：锚点 sections/变量/指纹 | docs/SYSTEM-PROMPT.md | 已收口（回炉重写：锚点定位） |
| 4 | @x-harness/llm：runtime + openai-compat 适配器 | docs/LLM.md | 已收口（回炉重写：失败契约结构化+SSE 硬化） |
| 5 | @x-harness/agent-loop：循环本体 | docs/AGENT-LOOP-DRIVER.md | 已收口（方案审 20 条 + 代码审 13 条处置） |
| 6 | @x-harness/session-checkpoint + e2e 旅程 | docs/SESSION-CHECKPOINT.md | 已收口（审查 7 条处置） |
| 7 | @x-harness/llm-retry：退避重试 | docs/LLM-RETRY.md | 已收口（新增：审计事件+进程内预算） |
| 8 | @x-harness/token-meter：用量记账+估算 | docs/TOKEN-METER.md | 已收口（新增：失败尝试计费+路线归因） |
| 9 | @x-harness/agent-delegation：子代理 | docs/AGENT-DELEGATION.md | 已收口（异步 spawn+通知唤醒，四路审查处置） |
| 10 | @x-harness/toolbox：read/write/bash/grep 四工具 + 后台任务登记簿 | docs/TOOLBOX.md | 已收口（grep rg 硬依赖 §5；run_in_background 登记簿 §4——task 动词归未来件） |
| 11 | @x-harness/exec-env + permission + sandbox-local：执行环境/本机沙箱/auto 权限（toolbox 全量接入） | docs/EXEC-ENV.md | 已实施（B0–B3 交付；代码审查 A/B 处置见文档 §13；darwin 真内核腿绿，linux 腿 T9 承载） |
| 12 | permission bash 裁决 AST 化：tree-sitter 迁移（段词法器 8 漏洞根治） | docs/EXEC-ENV.md §14 | 已收口（载体原生；方案审三路 §14.9 + 收口审两路 §14.10 全处置）；§14.11 裁决⑤ full 重定义 + bun 子命令修订；§14.12 裁决⑥简化令（wrapper 收敛 + opaque 原则化，wrappers 439→300 行零未覆盖） |

实施顺序 = 表序；每件：独立方案 → 子 agent 对抗审查 → 处置定稿 → 实现 + 单测 → 四门 → 代码对抗审查 → 回归 → 收口提交（引用本文档节号 + 各件文档节号）。

## 2. 全局不变量（六件共同遵守，各件文档引用）

1. **请求体纯折叠**：LLM 请求 messages 恒等于 `session.deriveMessages()`；插件不可直改消息表，只能改日志（append）或收件箱（splice 事件）。
2. **结算先落账**：`agent/assistant-stream` 的 start/chunk 帧实时广播，**end 帧以 durable append 为前提**（观察者看不到未结算的终帧）。
3. **单飞行 turn**：每 agent 相位机结构保证恰一个驱动循环；followup/steer/inject 只是收件箱落账 + 唤醒；disposed 原因下锁存抑制。
4. **数据驱动停轮**：`agent/turn-stopping`（serial）窗口结束后重读收件箱定续航，监听器顺序不影响结果。
5. **单一事实**：工具调用的 callId/name/arguments 唯一事实源是 `assistant/message` 的 tool_use 块；`tool/call` 事件是调度痕迹（派生自块，一致性由 loop 保证）。
6. **fail-closed**：落盘失败不派发（checkpoint）、重用不可验证不续写（persistence）、未知词条读侧拒绝（session——格式身份靠闭合词表 fail-closed，无版本字段）。

## 3. 总纲审查处置（2026-09-18 对抗审查 17 条，各件文档落实）

| # | 处置（落入哪件文档） |
| --- | --- |
| P1 resume 与排他创建相撞 | →#1：persistence 增**可验证续写模式**：`ax` EEXIST 时校验「磁盘卷 == 当前日志严格前缀 ∧ header 一致」→ append 打开；否则维持重用 fail-closed。resume 复用归档 header 原文（`CreateSessionOptions.header` 覆盖） |
| P2 claim↔user/message 崩溃窗口 | →#1：claim 事件携带 `claimed: readonly string[]`（被领条目 id）；→#5：repair 增回灌规则（尾部 claim 无后续同 turn user/message → 从 insert 事件回灌同 id 条目）；checkpoint 请求侧挂点挪到 `agent/request`（此时 system/user 已落账） |
| P3 flush 失败丢已领输入 | →#6：checkpoint 挪位后输入已在日志（P2）；→#5：pre-step reject 分支先回灌已领批次再 blocked 收尾 |
| P4 cancel/dispose 护栏 | →#5：`cancel(reason, {keepInbox?})` 缺省清收件箱（落 clear 事件）；disposed 原因锁存抑制；whenIdle 收敛循环（do/while 重查） |
| P5 repair 键错 | →#5：repair 以 assistant 块注册 pending；tool/call 有无区分「未启动可重试 / 结果未知需核验」文案；合成 tool/result 带 `isError:true` + `surfaceOp:"append"` |
| P6 中断结算三分支 | →#5：abort+有内容 → `assistant/message{interrupted:true,usage}`；abort+无内容 → attempt；finish error → attempt{error} |
| P7 stopReason 映射 | →#4/#5 显式映射表：stop→"stop"；max-tokens→"max-tokens"；error→（attempt，error=`code:message`） |
| P8 拓扑图修正 | 本文档 §4 |
| P9 claim 批次语义 | →#1：claim = 按 claimed ids 跨队列移除；step0 一条 claim{next-turn} 携带「next-turn 队首 + next-step 全部」的 ids；后续步 claim{next-step} |
| P10 版本机制预埋 | →#1：删除格式版本字段（用户裁决：无历史版本不预埋；闭合词表 fail-closed 即身份判别，语义级变更届时引入判别字段）；SESSION.md 同步 |
| P11 system node0 规则 | →#5：锚点策略——turn 1 step0 恒落 system/message 锚点（文本可空），后续恒 replace [seq,seq]（[0,0] 前置在已交付 surface 语义下不可行，审查修正） |
| P12 e2e/real 门 | →#6：e2e 假适配器全链旅程进默认门；真凭证旅程 `bun run e2e:real`（env 凭证缺席=显式 skip 计数报告）；声明口径「契约级生产可用 + 真凭证 opt-in」 |
| P13 token 计数 | →#5：loop 拥有 7 token（不移植 inbox 生命周期 emit，观察走 session/event + agent/status） |
| P14 LlmChunk 契约 | →#4：流必须恰一个 finish 收尾，违约按 error 结算；index 首现必须带 callId+name（loop 兜底铸 `call-${index}`）；适配器对 user 角色仅取 text 块拼接 |
| P15 流帧时序 | 本文档 §2.2（已并入） |
| P16 杂项 | →#6：checkpoint inject 去掉 llm；→#5：provider/model 缺失显式 `turn/end{error}`；additionalContexts 注入仍驱动下一步（优先级写明） |

## 4. 装配拓扑（修正版）

```
session ──> tools ──> llm ──┐
    │                           ├──> agent-loop ──> session-checkpoint
    └──────> system-prompt ─────┘
（箭头=依赖方向：system-prompt 仅类型依赖 session；llm 类型依赖 tools 的 ToolSchema；无环）
```

## 5. 收口条件（里程碑级）

- 六件各自收口（独立文档核销 + 四门全绿 + 两轮审查清零）；
- e2e 假适配器全链旅程绿 + real 门按 P12 口径执行；
- 里程碑总提交说明引用本文档与各件文档节号，覆盖率数字如实汇报（阈值 90/90/90/85 只升不降）。
