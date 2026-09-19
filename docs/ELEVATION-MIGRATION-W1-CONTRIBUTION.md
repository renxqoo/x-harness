# W1 迁移文档：system-prompt 投稿式（内核公共贡献服务）

> 状态：**已核销**（实施完毕 + 收口对抗审查处置完毕；定稿/审查/实施记录见各节）
> 迁移单元：guidance 通路从「数据位+组合层桥」改为「内核投稿直达」；wellKnown 词汇表；SectionSpec.text 函数形
> 旧实现：`ToolDefinition.guidance`（tools/src/types.ts:41）+ apps/cli `toolGuidanceBridge`（build-world.ts:66-83，inject topo）+ tool-core guidance 输入位（tool-plugin.ts）
> 关联：ELEVATION-DESIGN §2.1/§1 D6；IMPLEMENTATION §2.2

## 1. 行为规格基线

现行行为（2026-09-20 实施、全绿）：
- build-world.test.ts（apps/cli/src/__test__/）：guidance 在场 → section `tool/<name>`（锚 base/core，「## Output Format」之后）；缺席零段；拆卸回收。
- tool-core tool-plugin.test.ts：guidance 落 def；函数形收 env；空串不落 def；不进 schemas()。
- tool-bash service.test.ts：`bashGuidance` 非 sandbox 返回 ""。
- system-prompt base-plugin.test.ts：base/core + 五 facts 变量 + 入口归一。

**等价范围（修正——审查 F-5）**：逐字节等价承诺限 **apps/cli 世界**；e2e journey 世界本无桥，W1 后**新增** `tool/bash` 段（仅 sandbox 世界显现；local env bashGuidance 空串不落段）——journey 断言若有 prompt 内容比对需同步（实施期核查四个 journey）。

## 2. 审计结论引用

IMPLEMENTATION §1 F4/F8；DESIGN §1 D6（时序裁决）。

## 3. 逐模块裁决表

| 模块 | 裁决 | 动作 |
|---|---|---|
| tool-core tool-plugin.ts | **改写** | apply 内停靠：`ctx.tryUse(systemPrompt)` 在场且文本非空 → `section({ name: "tool/"+def.name, after: wellKnown.baseCore, text })`；disposer 入链 |
| tool-core tool-plugin.ts 头注/guidance 注释 | **勘误** | 「本包不认识 prompt（工具层不依赖表现层）」→ 改为投稿式裁决表述（D3；该边为上层→内核边，门禁不查此方向——修正「同组合法」旧表述） |
| apps/cli build-world.ts | **删除+勘误** | 桥（:66-83 + 数组位）删除；头注「guidance 桥必须排在 tool-* 之后」改「system-prompt 必须排在带 guidance 的 tool-* 之前（D6 数组序硬约束，sandbox/execEnv 同款）」；systemPromptPlugin 前置从「非硬约束」改**硬约束** |
| e2e 四 journey（toolbox/agent/delegation/compaction） | **改写** | 数组序重排：systemPromptPlugin 前置于 tool-*（D6） |
| `ToolDefinition.guidance` 字段 | **保留** | 数据位+停靠消费点；schemas 投影仍排除 |
| apps/cli build-world.test.ts | **改写** | 语义并入 tool-core 测试（含「数组序颠倒探针」：systemPromptPlugin 后置 → 段缺失**可观测**？**否**——tryUse 静默。探针改为：正确序世界断言段在场（正向防回退），错序形态记 D6 已知边界） |
| system-prompt 导出 | **改写** | `wellKnown` 表；`baseCore` 别名一个版本周期 |
| registry.ts | **扩展** | text 函数形：assemble 期求值，抛错 → `[section <name> render error: <msg>]` 占位（段级降级） |
| packages/tool-core/package.json | **改写** | + `@x-harness/system-prompt: workspace:*`（上层→内核边） |

**D6 否决项记录**：inject 硬依赖（9 个无 prompt 测试世界 throw）；waitFor 停靠（异步拆卸竞态，disposer 链复杂化）。**F-10 交互记录**：fn 段须会话内确定；间歇抛错 → anchorSystem 逐步 replace 事件（日志膨胀可观测=告警面，不静默）。

## 4. API 对照表

| 旧 | 新 | 理由 |
|---|---|---|
| `ToolPluginInput.guidance` | 不变 | 输入稳定，消费点从桥移入停靠 |
| `SectionSpec.text: string` | `string \| (() => string)` | 惰性文本；段级降级 |
| `toolGuidanceBridge` | （删除） | D3 |
| — | `wellKnown.baseCore` | 锚点词汇表内核所有 |

## 5. 测试迁移矩阵

| 旧测试 | 去处 | 动作 |
|---|---|---|
| build-world.test.ts 三用例 | tool-core（加载 systemPromptPlugin+base 后断言段/位置/回收） | 改写 |
| build-world.test.ts「不进 schemas()」 | 原位 | 移植 |
| （新增）fn 段：每次 assemble 重算/抛错降级占位/与变量插值共存 | system-prompt prompt.test.ts | 新增 |
| （新增）e2e journey prompt 断言核查（tool/bash 段新增的同步） | e2e | 核查改写 |

## 6. 回滚方案

单波提交可 revert；桥在 git 历史（2026-09-20 提交）可参照恢复。

## 7. 验收

- [ ] 四门全绿；apps/cli 世界 prompt 与 W0 基线逐字节一致（e2e 快照或专测）
- [ ] grep `toolGuidanceBridge` 零命中；两处陈旧注释已勘误
- [ ] 依赖门禁绿（tool-core→system-prompt 为上层→内核边，门禁管 core 组纯净性不查此向——表述已修正）
- [ ] 对抗审查重点：停靠时序（D6 约束下 tryUse 必中）、disposer 链序（段先于 prompt 服务回卷）、段级降级与变量降级不冲突
- [ ] docs/SYSTEM-PROMPT.md §1.4 更新（桥→停靠；D6 约束补记）

## 8. 实施记录（2026-09-20）

- **交付物**：tool-core 投稿停靠（`dockGuidance`：tryUse + `tool/<name>` + wellKnown.baseCore，disposer 入链先于 register 回卷）；apps/cli 桥删除（含数组位/导出/build-world.test.ts 迁语义至 tool-core）；build-world 头注与行注 D6 硬约束化；toolbox-journey systemPromptPlugin 前置（其余三旅程无 guidance 工具不动）；SectionSpec.text 函数形 + 段级降级 `[section <name> render error: <msg>]`；wellKnown 词汇表导出 + baseCore 别名；SYSTEM-PROMPT.md §1.4 / CLI.md 同步。
- **门禁数字**：typecheck ✓ lint ✓（registry 复杂度拆分 textSpecError）test **144 文件/1712 用例**（1710 + fn 形 2 + 停靠 2 − 桥测试文件 1 含 2 用例）e2e 全旅程 ✓（toolbox localEnv → bashGuidance 空串 → journey prompt 逐字节等价成立）内核门禁 ✓。
- **验收核对**：grep `toolGuidanceBridge` 代码零命中（ELEVATION 文档内 4 处为合法历史引用）；两处陈旧注释勘误完成；tool-core→system-prompt 为上层→内核边（门禁管 core 组纯净性，方向正确）。
- **新增裁决补录**：无偏离定稿。
- **显式挂账**：无。

## 9. 收口对抗审查处置（2026-09-20）

审查结论：核心通路（桥→停靠等价/D6 数组序/disposer 链序/text 函数形/空串缺席分支/门禁）**零行为缺陷**——等价静态成立。处置：

- **M-1（中）等价验收缺工件**：补 CLI 形态世界 prompt 组合金测试（cli-prompt-sections.test.ts——生产序世界 base 全段游标在序 + facts 全插值 + local env bash 零停靠段 + 追加段落尾），未来组合回归有网。
- **L-1（低）guidance 消费面收窄**：make() 自带 guidance 字段不再触发停靠（仅工厂参数投稿）——types.ts 注释记录该语义边界（当前仓内生产者唯 tool-bash 工厂参数，无实际差异）。
- **L-2（低）五处「组合层桥接」陈旧注释**：全部勘误（tool-plugin.test.ts describe 标题与同块新用例的正面矛盾、tools/types.ts、tool-bash plugin/service.test、cli 测试措辞）。
- **L-3（低）SYSTEM-PROMPT.md 两处口径**：错误占位格式补 `<msg>`；baseCore「唯一跨包锚点常量」改 wellKnown 词汇表口径 + 别名事实。
- **L-4（低）**：baseCore 导出改 `typeof wellKnown.baseCore` 保字面量类型。
- **I-1（信息）**：段级 vs 变量级降级方向差异、占位文本经插值的边缘二次替换、undefined 分支死防御——文档记录不修。
- 用例数：1716 → 1717（+1 金测试）。
