# F0-INTERCEPTION 迁移文档

> 状态：草稿。契约草案见 SDK-DESIGN §6/§7；行为规格 = 现有 1730 测试 + e2e 零改写（纯加法波）。
> 交付/测试矩阵/回滚/验收：实施前按 DESIGN 对应小节定稿（本行为占位骨架，对抗审查后补全）。

## 7. 实施记录（2026-09-20，feat/plugin-platform 分支）

- **交付物**：`PreStepDecision` 改写分支（改写版即落账版；step0 改写空=闭 turn——领取项被中间件显式清除，与 reject[回灌] 的差异为文档化语义）；`agent/assistant-settle` waterfall（settle→append 之间，content/stopReason/interrupted 可纠，usage **不进载荷**——session/event 已覆盖，最少面原则）；`llm/stream` waterfall（包 adapter.stream，注入/截断帧）；plugin.ts 双 dispatch 接线（final 透传）；barrel 导出补齐。
- **门禁数字**：typecheck ✓ lint ✓（嵌套回调抽 prefixStream/rewrite 平铺）test **146 文件/1734 用例**（1730 + F0 专测 4）e2e 全旅程 ✓。
- **等价锚**：final 透传缺省 = 零中间件时全链路行为不变（既有 1730 零改写通过）。
- **挂账**：F0+P1 设计审查进行中（收口后处置台账补记本节）。
