# S0 迁移文档：内核 softInject 原语 + tool-core 采纳

> 状态：草稿。迁移单元：Plugin.softInject（在场则排后）+ tool-core 双软依赖声明——数组序硬约束结构性消灭。

## 1. 行为规格基线
- 1730 测试 + e2e 全旅程**零改写**通过（原语为纯放宽：现行数组序本就满足软约束，topo 结果不变）。
- inject 现行语义不变（缺席 throw/环检测/优先序）。

## 2. 裁决表
| 模块 | 动作 |
|---|---|
| core/context types.ts Plugin | + `softInject?: readonly string[]` |
| core/context load-plugins.ts topoOrder | 软名在场则 visit、缺席跳过（不进未知名校验） |
| tool-core tool-plugin.ts | + `softInject: ["system-prompt", "sandbox-local"]`（guidance 停靠与 execEnv 停靠必中；env 缺席 fail-closed throw 不变） |
| apps/cli build-world 头注 | 硬约束表述降级为 softInject 说明（历史注释勘误） |

## 3. 测试：softInject 在场排序/缺席无约束/缺席不 throw/与 inject 混合/软环检测（经 inject 参与的环）；**乱序装配探针**（tool-* 列前、systemPrompt 列后 → guidance 仍停靠）。

## 4. 回滚：单波 revert（纯加法）。

## 5. 验收：四门 + 上述用例 + 对抗审查（topo 语义完备性：软缺省/重复名/自软锚）。
