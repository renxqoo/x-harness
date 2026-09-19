# F1 迁移文档：@x-harness/harness kit 目录 + createAgentWorld + CLI dogfood

> 状态：草稿。依赖 S0。迁移单元：装配机制从 apps/cli 提升为任意插件集平台；CLI 换用证通用。

## 1. 行为规格基线
- CLI 全部测试 + e2e 全旅程**零改写**通过（dogfood 等价锚）。
- World 七字段形状不变；main.ts/run-repl 消费面零改动。

## 2. 交付（DESIGN §2.2 全量）
- kit 目录：inlineSession/durableSession/llm(adapter 注册插件化)/toolbox(gate+observed 接线)/fence/delegation(含 checkpoint)/skill/meter/prompt(base+appends)。
- createAgentWorld({plugins, broker?}): loadPlugins + World 提取 + 失败自清理——任意插件集。
- CLI build-world 改 kit 组合；adapterOptionsOf/buildAdapters 留宿主；registerAppendSections 迁 promptKit。

## 3. 测试：harness 单测（各 kit 形状/llm adapter 注册插件化等价/promptKit 追加链/失败自清理/乱序插件集仍正确——软约束生效）；CLI 零改写锚。

## 4. 回滚：单波 revert（CLI 内联装配在 git 历史）。

## 5. 验收：四门 + CLI/e2e 零改写 + 乱序装配用例 + 对抗审查（kit 边界不吸业务/接线等价）。

## 7. 实施记录（2026-09-20）

- **交付物**：packages/harness——十 kit（inlineSession/durableSession/loop/prompt(base?)/toolbox(root 必选，gate/observed 缺省内包)/fence/delegation/checkpoint(独立)/skill/meter/llm(adapter 注册插件化名铸唯一 index-<name>，retry per-provider map)）+ `createAgentWorld({plugins})`（五服务提取 fail-closed + 失败自清理）。
- **CLI dogfood**：build-world 重写为 kit 消费者——宿主只剩 IO 面（providers 探测/broker/facts→basePlugin/持久化根）；World 自 harness 导入（本地接口删除）；D6/sandbox 头位硬约束头注撤除（S0 声明式消灭后的勘误随构落地）。
- **门禁数字**：typecheck ✓ lint ✓ test **149 文件/1758 用例**（+kit 4：乱序集端到端/五服务缺席 fail-closed/坏插件自清理/缺省接线）e2e 全旅程 ✓ 内核门禁 ✓；**CLI 全部测试零改写通过**（dogfood 等价锚）。
- **裁决补录**：toolboxKit 的 root 改必选（read/write 工厂要求 gate——kit 职责即内包缺省接线）；loopKit 单列（五服务提取的显式成员）。
