# PERMISSION V3 施工图（IMPLEMENTATION）

> 状态：**已实施**（阶段一/二/三落地 2026-09-28；行为等价验证：full 逐字节（mode:full 归因面 U7 有意变更——allow 规则命中归因重写）、plan 宿主富策略经 planKit 覆盖缺省、纯直调方严格缺省）
> 偏离记录（含对抗审查 D1-D11 处置，2026-09-28 §7 独立审查后补全）：
> ① 编排序 ask 规则×模式分派**三面不一致**（审查 D4）：tool 面 ask 规则先于模式（U5 P-bug-1 规格），
>   path/bash 面模式先于 ask 规则（full 越过 ask，V2 基线同）——接受为现状，跨面统一挂账；
> ② P-dup 收敛仅做零风险面（isFull 双写消、死代码删——含 settleDomainAsk 随 D7 删），basename 四份/路径归四写挂账；
> ③ **红线 2（hard-deny/injection 最低保障钳制）未实现**（审查 D2）：与「full 逐字节等价」互斥
>   （full 对 injection 放行是 V2 现口径有钉）——本批次取等价，钳制面（含第三方插件护栏、
>   判决函数同步性的注册期执法）挂账后续波次；
> ④ U7 归因重写落地（handwritten 命中重写、习得 grant 不重写——permission-v2.test 钉）；
>   「MIGRATION 行为映射表」以本偏离记录 + plan-mode.ts 头注三差异（①归因序②dynamic 段
>   B-bug-5③读保护聚合序）为准，不另立文档（审查 D3/D6 处置）；
> ⑤ bash 面 deny 规则改全段先行（审查 D5）：跨段交错序变严（旧段1 hard-deny ask 先返→
>   新段2 deny 规则先返）——与红线 1 同向，接受；
> ⑥ D1 已修（词面提权兜底门回解析失败面——`grep sudo README.md` 假拒回归，audit-v3 套件钉）；
> ⑦ 性能（审查 D10）：bash 面每裁决 parse×2 + 无模式档也产全量 facts——量级同阶，
>   「不新增分配热点」按字面违约挂账；⑧ 注册表无 register 期 unrestricted 重估（D11，运行期动态注册场景）挂账。
> 上游：PERMISSION-V3-DESIGN.md。审计结论引用编号（P-bug/P-dup/P-mix/B-*/C-*）不重复抄写。

## 1. 目标结构

```
packages/permission/src/
  ├─ 机制核心（不动语义，重组接线）：
  │   decide.ts / plugin.ts / grants.ts / classifier.ts / sensitive.ts / rules/
  │   bash/{ast,hard-deny,injection,wrappers}.ts
  │   facts.ts（新——AdjudicationFacts/BashFacts 聚合，B-mix-9 的 BashFacts 上提）
  │   modes.ts（新——ModePlugin 协议 + 模式注册表服务 + 内置模式注册）
  ├─ 内置模式插件（同包、依赖核心——U2/U6）：
  │   mode-full.ts（新）——full 判决（P-mix-2/7：短路+unrestricted 属性）
  │   mode-plan-default.ts（新）——plan 严格缺省（写拒+bash 全拒——tool-plan 缺席世界的保底）
  │   auto/edit-confirm/sandboxed-auto —— 首期不设插件（返回 undefined 走核心 fallback，U6）
  └─ bash/adjudicate.ts —— 档位分派改为注册表查询；planBash 移出（→ tool-plan）

packages/tool-plan/（策略消费方——plan 模式插件本体）
  └─ plan 模式 decide：Write 族拒（P-mix-1）+ bash 研究通道（P-mix-12——planBash 语义整体迁入，
     消费 BashFacts 不再自聚合——B-bug-1/5 的结构性根治）
```

## 2. 核心协议（modes.ts）

```ts
export interface ModePlugin {
  readonly id: string;
  /** 判决函数：同步、无 IO（DESIGN §1.2）。undefined = 让位核心 fallback（U6） */
  decide(facts: AdjudicationFacts): Decision | undefined;
  /** full 档总括授权属性（P-mix-7——setUnrestricted 的注册表达） */
  readonly unrestricted?: boolean;
}
```

- 注册表经 ctx 服务面（`modeRegistry` token）：`register(plugin): Disposer`——**同 id 后注册者胜**
  （tool-plan 在 permission 之后装配 → plan 富策略覆盖严格缺省）；身份守卫注销。
- 编排序（两裁决面同律）：control 直通（红线 5）→ **deny 规则**（红线 1）→ hard-deny/injection
  钳制底线（红线 2：模式判 allow 被核心改写为 ask）→ **模式插件 decide** → ask 规则 →
  allow/习得 → **核心 fallback 梯**（现裁决梯减去已迁分支——auto 族行为本体，U6）。
- exec 推导/ask 落账/记忆/审计归核心执行面（红线 3/4——plugin.ts 不动策略只动接线）。

## 3. 逐模块裁决表

| 旧文件/分支 | 裁决 | 依据 |
|---|---|---|
| decide.ts planWriteGate（L134/157-159） | **迁移** → plan 模式 decide（tool-plan）+ 严格缺省（permission 内置注册） | P-mix-1；行为映射见 MIGRATION |
| decide.ts isFullProfile 短路（L109/137/162） | **迁移** → full 模式插件（U7：deny 规则先行——归因序变更为已裁决有意变更） | P-mix-2 |
| decide.ts confirmAllWrite（L142/171） | **保留核心 fallback**（edit-confirm 无独立插件期） | U6 |
| decide.ts in-root 放行/界外 ask（L143/146） | **保留核心 fallback** | U6/P-mix-4/5 |
| decide.ts ask 规则（P-bug-1 修复面） | **保留核心**（模式插件之后） | 红线 1 序 |
| adjudicate.ts planBash（三段） | **迁移** → tool-plan plan decide（消费 BashFacts）；B-dup-3 死参数随迁清理 | P-mix-12 |
| adjudicate.ts fullDecision/isFull | **迁移** → full 模式插件 | P-mix-2 |
| adjudicate.ts on-failure 围栏代问（L201/218） | **保留核心 fallback**（sandboxed-auto 无独立插件期） | U6/P-mix-8 |
| plugin.ts setUnrestricted（L59/68） | **改接线**：注册表查 `unrestricted` 属性（字面 "full" 比较消失） | P-mix-7 |
| classifier/readonly-verbs/sensitive/ast/rules | **保留核心**（事实面——B-mix-10 词表的档位参数化挂账后置） | §2.1 |
| BashFacts 聚合 | **新建** facts.ts（segment 旗面/分类三态/重定向双面/敏感面/硬拒——B-mix-9 全清单） | B-mix-9 |
| 零消费导出（C 审计清单） | **删除**：mergeCustomProfiles（U8）、死域名面（P-bug-12） | U8 |

## 4. 实施顺序（阶段 = 提交单元，每阶段四门 + 探针回归）

1. **阶段一（试运行切片）**：modes.ts 协议+注册表 → facts.ts → **full 模式插件**抽取
   （decide+unrestricted 属性）→ decide/adjudicate 的 isFullProfile 分支改注册表查询 →
   316 用例全绿（full 行为逐字节等价——含 U7 归因序变更的单例断言更新）。
2. **阶段二**：plan 严格缺省注册（写拒+bash 全拒）+ planBash/planWriteGate 从核心删除 →
   tool-plan 注册 plan 富策略（消费 BashFacts 复刻三段语义）→ plan 攻击探针 15/15 +
   316 全绿 + hosts 装配验证（planKit 覆盖缺省）。
3. **阶段三**：执行面接线收尾——exec/ask/审计对模式判决的统一消费、P-dup 收敛
   （basename/路径归一/规则梯提取）、零消费导出删除、文档状态推进。
4. **对抗审查**（每阶段独立会话对照旧实现）+ e2e（CLI plan/full 腿）。

## 5. 测试计划

- 既有 316 用例 = 行为规格（C-spec-1~21 分流：full/plan 用例随插件迁/重锚，机制用例留核心）；
- 新增：注册表契约（同 id 后胜/身份守卫/缺席 fallback）、full 插件判决矩阵、plan 双形态
  （缺省 vs tool-plan 覆盖）对照、BashFacts 聚合纯函数面；
- 回归锚：bash-loosening reason 全词表、§4.2 执行矩阵、CLI 装配旅程、e2e 两腿、plan 15 攻击探针。
