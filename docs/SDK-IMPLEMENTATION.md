# SDK 施工图（平台化修订——用户裁决 S2'）

> 状态：草稿（对抗审查前）。设计基线：docs/SDK-DESIGN.md。

## 1. 事实核查结论（审计证据）

- **A1** apps/cli/src/build-world.ts（130 行）= 事实上的装配参考：19 插件数组（systemPrompt 前置 D6 硬约束 + basePlugin 条件位 + session/persist 条件 + tools/permission/sandbox/broker/read/write/bash/grep/task-tools/tokenMeter/llm-retry/llm/agentLoop/checkpoint/delegation/skill）；adapters 后置 register 循环；`World` 接口七字段；失败 `ctx.dispose()` 兜底。
- **A2** 数组序硬约束两条：sandbox/execEnv 先于 tool-*（三级解析 tryUse）；system-prompt 先于带 guidance 的 tool-*（D6）。均只在 build-world 头注释。
- **A3** e2e 四 journey 各持私有样板：textScript 生成器、假 adapter（calls/scripts 捕获）、fake tool、7 插件子集装配——testkit 提炼源。
- **A4** tools/permission/sandbox/delegation/skill 工厂参数：permission `{root, mode}`；sandbox `{root}`；delegation/skill 无参（CLI 形态）；read/write `{gate, observed}`；bash `{gate}`；grep `{gate}`。
- **A5** 无任何作者入口文档；docs/ 21 份均为内部设计文档。

## 2. 逐模块裁决表

| 模块 | 裁决 | 动作 | 单元 |
|---|---|---|---|
| packages/harness（新上层包） | **新建** | build-world 逻辑迁入：createAgentWorld + World 接口 + RETRY_POLICY 缺省；选项化 adapters/broker/prompt{basePlugin,appends}/persist/retryPolicy | F0 |
| apps/cli build-world.ts | **改写为消费者** | 保留 adapterOptionsOf/buildAdapters（providers 探测归宿主）+ broker 装配 + 薄封装（re-export World/createAgentWorld 或直接转调）；main.ts 不动接口 | F0 |
| apps/cli base-prompt.ts | 原位 | basePlugin 经 options.prompt 注入门面 | F0 |
| packages/testkit（新） | **新建** | textScript/scriptedAdapter/fakeTool；纯函数零装置 | F2 |
| e2e 四 journey | **改写** | 样板换 testkit（断言零语义变化） | F2 |
| docs/PLUGIN-AUTHORING.md | **新建** | 五块结构（DESIGN §2.3）；Where-new-behavior-goes 总表 | F1 |

## 3. 拆分决策

- harness 包依赖 = CLI 现依赖减 apps 层（broker/providers/facts）；**不依赖** apps/cli（S3：basePlugin 注入）。
- appends 注册逻辑（无边落尾链）从 apps/cli cli-prompt-sections.ts **迁入 harness**（机制归门面）；`registerAppendSections` 留 CLI 转用或直接内联——迁入后 CLI 删除本地版。
- testkit 依赖 llm（类型 LlmChunk/LlmAdapter/LlmRequest）+ tools（ToolDefinition）+ typebox（devDep 不需要——inputSchema 手写对象？否：fakeTool 用 Type.Object({})，需 typebox 依赖）。

## 4. 测试计划

- F0 等价锚：apps/cli 全部测试 + e2e 全旅程**零改写**通过；新增 harness 单测（装配形状/条件位/adapters 注册/失败自清理）。
- F2 等价锚：四 journey 断言零语义变化；testkit 自身三用例。
- 覆盖率阈值不动。

## 5. 实施顺序

| 波 | 单元 | 验收点 | 文档 |
|---|---|---|---|
| S0 | 内核 softInject 原语 + tool-core 采纳（数组序约束结构性消灭） | 乱序装配探针 + 1730 用例零改写 | S0-SOFT-INJECT |
| F1 | @x-harness/harness kit 目录 + createAgentWorld + CLI dogfood | CLI/e2e 零改写 + 乱序插件集用例 | F1-HARNESS-KITS |
| F2 | PLUGIN-AUTHORING.md 作者入口 | 五块齐 + 总表零死链 + 事实核对 | F2-AUTHORING |
| F3 | @x-harness/testkit + e2e 换用 | journey 断言零语义变化 + testkit 用例 | F3-TESTKIT |

每波单提交可 revert。
