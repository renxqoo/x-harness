# M1-Context 实施方案（packages/core/src/context/）

> 状态：**已核销**（2026-09-18：四门全绿 + 对抗审查 13 项处置清零 + 验收清单逐项核销）
> 级别：中（新子模块 + 全新外部契约 + 并发/一致性语义；绿地无不可逆变更）
> 方案主体：[CONTEXT.md](./CONTEXT.md)（已多轮对抗审查定稿）——本文件只补实施两节与裁决，**契约语义以 CONTEXT.md 为单一真相**。

## 契约（引用）

CONTEXT.md §1（服务注册表）、§2（事件总线：token 形态 / 四模式语义矩阵 / 冻结 / 错误 sink / 重入）、§3（scope 层链）、§4（effect 账本与 dispose）、§5（插件加载器）、§6.1（自举域 + 通用信封词表）。本轮规格修订（2026-09-18，随本实现同提交落档）：

1. guard 执行语义消歧：**全部执行不短路**（deny 与错误都不跳过他人），结果 = 注册序首个 deny（§2.2 矩阵已改）；
2. 冻结三档 `deep | shell | none`（§2.1 defineEvent opts + §2.3）；
3. `plugin/event` 信封 = 壳冻结（一级字段冻结、`data` 原引用）。

## 问题域

- 处理：Context 原语全部——服务注册表（provide/use/tryUse/nearest-first 遮蔽）、事件总线四模式（emit/waterfall/serial/guard 的次序、错误、冻结、next 纪律）、scope（层链视图、chain-up 定向、遮蔽、入父账本）、effect 账本（串行逆序回卷、unwind 边界）、匿名链（createChain/onChain 层归属）、插件加载器（inject topo、循环/重名/缺依赖拒、失败整体回卷）、自举词表常量。
- 不处理：
  - session/llm/agent/loop/tools 件（M1 后续批次，各自的施工图已立）；
  - logger 服务（错误 sink 即归宿，C5）；
  - parallel 派发模式（推迟裁决，CONTEXT.md §10 风险 2）；
  - ScopeFilter 的谓词扩展形态（本轮按 `{ agentId: string }` 落地，见裁决 1）。

## 并发/一致性预算

- dispose：串行逆序 await，无并发上限（装配期一次性动作）；
- waterfall next 纪律：同中间件内**并发**调用（上次未 settle）→ throw；settle 后串行重调合法；
- emit：同步、可重入、监听器错误隔离（单监听器耗时上限无硬约束——同步契约由词表设计者自责，C 系列既定）；
- 冻结：deep 递归一层不复制（原对象冻结，非拷贝）——派发方不得复用已冻结可变对象。

## 拆分

```
packages/core/src/
  index.ts            # barrel（替换种子代码，种子删除）
  context/
    types.ts          # token/Context/Plugin/Disposer/GuardDeny/Chain/ScopeFilter 类型
    tokens.ts         # defineService/defineEvent/defineWaterfall/defineSerial/defineGuard（名字校验）
    freeze.ts         # deepFreeze / shellFreeze
    create-context.ts # createContext + scope 视图 + 四模式派发 + 服务注册 + effect 账本
    load-plugins.ts   # 预扫描（重名/循环/缺依赖）+ topo + 逐个 apply + 失败整体回卷
    vocab.ts          # 自举词表常量（service/provided、plugin/loaded、plugin/error、context/disposing、plugin/event）
    __test__/         # 单测 + 预演集成测试（同目录纪律）
```

依赖方向：全部文件零外部依赖（仅 TS 内建）；index.ts 汇出。

## 实施顺序（单批次一提交，内部步骤独立可验）

1. 脚手架：devDeps（typescript/vitest/@vitest/coverage-v8/oxlint/bun-types）、vitest.config（覆盖率 90/85 门禁）、根 scripts 四门、删种子（test/index.test.ts、src/index.ts 的 clamp/sum）；
2. 实现 types/tokens/freeze → create-context → load-plugins → vocab（顺序即依赖序）；
3. 测试先行口径见下节，随实现同批落齐；
4. 四门 → 对抗审查（独立 agent）→ 收口提交。

过渡态：无（绿地单批收口，无兼容层）。

## 裁决（默认裁决，否决窗口至收口前）

1. **ScopeFilter = `{ agentId: string }`**——按 §9.4 预演形态；谓词扩展留实现期后裁决（CONTEXT.md §8 既挂）。
2. **loadPlugins 失败 = 调用 ctx.dispose() 并 reject**——「整体回卷已加载的」（§5）落在整个 ctx 上；装配阶段宿主不应在 ctx 上持有不可丢弃的注册（装配语义），写进 JSDoc。
3. **匿名链生命周期**：chain 是纯共享对象，不随 owner 层回卷；只有 `onChain` 注册随消费方层回卷（I1 对**注册**闭合，链对象引用归 GC）。
4. **dispose 幂等**：二次 dispose 为 no-op（§4 未定义，补默认）。
5. **inject 引用不存在的插件名 = 装配期 throw**（fail-fast，与循环/重名同口径）。
6. **chain 的中间件次序与 waterfall 同律**（root→leaf 层序 + 注册序），规格未言明处按一致性裁决。
7. **waterfall 输入冻结时点**：dispatch 入口一次（首个中间件见到即已冻结；重调 next 传入的新 input 由下一层 dispatch 冻结）。

## 测试口径（先于实现的验收标准）

**契约级**（CONTEXT.md 语义矩阵逐格）：
- token：五种 define 的 kind/mode/name/freeze；非法名（空/非串）throw；同名重复 define 合法；
- 服务：disposer 退订、同层重复 provide throw、跨层遮蔽 nearest-first、use 缺失 throw（message 含 token 名）、tryUse undefined、`service/provided` 广播；
- emit：注册序、root→leaf 并集、深冻结（strict 写入 throw）、shell/none 豁免档、错误隔离进 sink、disposer 退订、chain-up（祖先可见/兄弟不可见）、同步重入；
- waterfall：洋葱次序（去程+回路）、未调 next throw、**串行重调合法**（重试模式：settle 后再调、final 执行两次）、**并发 next throw**、中间件 throw → dispatch reject、无中间件直达 final、输入 deep 冻结；
- serial：顺序全跑、错误隔离继续；
- guard：**deny 后继续执行全部**、首个 deny（按序）胜出、无 deny → undefined、坏守卫按弃权；
- scope：层链遮蔽/并集次序（root 注册晚于 child 仍先执行）、子层 dispose 只回卷本层、父层 dispose 收编未 dispose 子层、scope 创建入父账本；
- dispose：串行逆序（含 async disposer 依次 await）、幂等、unwind 边界（on/provide/effect/dispatch(w|s|g) throw；emit 允许）、`context/disposing` 先于回卷广播；
- load-plugins：topo 次序、循环 throw、重名 throw、缺依赖 throw、apply disposer 自动入账、apply throw → `plugin/error` + reject + 整体回卷、逐个 `plugin/loaded`；
- vocab：**词表封闭性**（导出常量名集合 == CONTEXT.md §6.1 自举域+信封词表，双向）、plugin/event 壳冻结断言（一级 frozen、data 引用原样）。

**边界与异常**：垃圾 token（非 token 对象经 as 传入）运行时拒；晚订阅不回放；分发中退订（迭代快照安全）；emit 于 dispose 后允许且不炸。

**集成（§9 预演 + §10 风险 3）**：
- 9.1 写插件（provide + on + disposer flush）、9.2 root 观察一切、9.3 重试中间件（faux 流首试 error 终态、串行重调第二次成功）、9.4 scope 遮蔽（restricted 视图）、9.5 匿名链跨插件（服务共享 + onChain 层归属 + 消费方 dispose 后中间件移除）、9.6 回卷；
- **风险 3（M1 必测验收项）**：双 sibling scope 各自 loadPlugins 同一插件（provide 带每层状态的计数器服务）→ 两 scope `use` 各得其实例、互不串、root 无此服务。

**表驱动**：四模式 ×（次序/短路/错误/冻结）矩阵遍历断言。

## 验收清单

- [ ] CONTEXT.md §2.2 矩阵每格至少一条断言（含本轮消歧的 guard 语义）
- [ ] I1–I5 不变量各有直接测试（I1 回卷、I2 next 纪律、I3 隔离、I4 冻结三档、I5 词表封闭）
- [ ] §9 预演 9.1–9.6 逐段跑通；§10 风险 3 双 scope 隔离测试绿
- [ ] 四门全绿 + 覆盖率（行/语句/函数 ≥90、分支 ≥85）数字如实报告
- [ ] 对抗审查问题清单逐条处置（修掉或驳回附理由）
- [ ] 假绿抽查：无 skip、无被注释断言、断言未为迁就实现被改


---

## 对抗审查处置记录（2026-09-18，独立会话审查 13 项）

| # | 严重度 | 处置 |
|---|---|---|
| 1 | 高（阻断） | **修复**：dispose 回卷容错——单个 disposer 抛错不中止回卷（I1 优先），全部完成后单错抛原错、多错抛 AggregateError；状态必推进 disposed。规格 §4 同步修订 |
| 2 | 中 | **修复**：deepFreeze 以 seen 集防环、去掉 isFrozen 短路——预冻结外壳不再阻断子代递归 |
| 3 | 中 | **修复**：`service/provided` 改**提供层 chain-up**（原实现 root 全局广播越出 C3 隔离对称性）；词表 §6.1 作用域标注同步改正，偏差测试重写为规格语义 |
| 4 | 中低 | **规格授权**：Map/Set/Date 容器只冻外壳写进 §2.3 容器边界（代码行为不变，规格补授权） |
| 5 | 中 | **修复**：registerEffect 自清理——手动退订同步移出账本；注册表空时删除 Map 键 |
| 6 | 低 | **修复**：provide 先入账后广播——监听器内触发 dispose 时本注册可被回卷 |
| 7 | 低 | **修复**：token 形状校验（on/emit 缺 mode/freeze 拒收）；guard 返回非 deny 形状按弃权 |
| 8 | 低 | **修复**：use/tryUse 以 Map.has 判定——provide(undefined) 垃圾输入不穿透遮蔽 |
| 9 | 中低 | **修复**：loadPlugins 失败路径 dispose 抛错不再吞 apply 根因（console.error 记录 + throw 根因） |
| 10 | 中低 | **修复**：next 僵尸围栏——中间件返回后 next 失效（macrotask 形态拦截）；microtask 极限窗口记 §10 已知限制 |
| 11 | 低 | **修复**：dispatch 的 unwind 边界扩为整条祖先链 live 检查（父层回卷中途的子层派发拒绝） |
| 12 | 低（规格洞） | **修复**：emit 异步监听器 rejection 进错误 sink（防 unhandled rejection 崩溃）；§2.5 措辞同步修订 |
| 13 | 流程 | **补齐**：分发中退订快照语义测试（emit/waterfall 各一） |

审查确认干净的方向（不再重复）：waterfall inFlight 时机无假阳/假阴、scope 叔侄隔离、冻结 token 作键、pluginError 次序、环引用冻结、语义矩阵逐格一致。

## 验收清单核销

- [x] CONTEXT.md §2.2 矩阵每格至少一条断言（含消歧后的 guard 语义：全部执行不短路 + 首个 deny 按注册序）
- [x] I1–I5 不变量各有直接测试（I1 回卷/容错、I2 next 纪律含串行重调与僵尸围栏、I3 隔离含 sink 自身失败、I4 冻结三档、I5 词表封闭双向）
- [x] §9 预演 9.1–9.6 逐段跑通（rehearsal.test.ts）；§10 风险 3 双 scope 隔离测试绿（服务/事件/dispose 三面）
- [x] 四门全绿：oxlint 0-0 / tsc --noEmit / bun build / vitest——**100 用例全过，覆盖率 行99.63 语句99.63 分支98.02 函数100**（阈值 90/85，真实强制于 vitest.config）
- [x] 对抗审查问题清单 13 项逐条处置（上表），有代码改动的修复全部带回归用例（review-fixes.test.ts）
- [x] 假绿抽查：无 skip/todo/only、无被注释断言、断言未为迁就实现被改（两条规格语义修正均为测试自身错误，见提交说明）
