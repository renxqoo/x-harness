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
