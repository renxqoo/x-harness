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

## 6. 实施记录（2026-09-20）

- **交付物**：core `Plugin.softInject`（topo 软边——在场 visit/缺席跳过/软-软环 throw/混合环 visiting 栈抓到/自软锚 throw/硬软重复 done 短路——六语义各有专测）；tool-core 采纳三软名（system-prompt/sandbox-local/permission——F-01 清单）；delegation 采纳（permission/session-persistence-jsonl + mailbox 条件软名）。
- **乱序装配探针**：tool-* 列前 systemPrompt 列后 → guidance 仍停靠（D6 陷阱结构性消灭）；permission 列后 → grants 闭包捕获命中（GRANTS-CAPTURED 标记判别——缺席对照为空数组）。
- **门禁数字**：typecheck ✓ lint ✓ test **146 文件/1742 用例**（1735 + core 软依赖 5 + 乱序探针 2）e2e 全旅程 ✓；既有 1735 零改写（纯放宽——现行数组序本满足软约束，topo 同序）。
- **挂账**：数组序头注勘误（build-world D6 表述降级为 softInject 说明）随 F1 dogfood 一并落。
