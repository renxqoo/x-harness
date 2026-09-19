# W2C 迁移文档：system-prompt 会话层（机制就绪，等价重构）

> 状态：定稿（2026-09-20 对抗审查处置后；依赖 W2A；可独立于 W2B 排期）
> 迁移单元：prompt registry 会话层 section 机制（锚定子集规则 + 双向缓存）——**本波零消费方**（fork 不注册会话段、typed 走静态串），属机制铺底等价重构
> 旧实现：世界级单 Map（registry.ts sections/variables），assemble() 无参会话无关
> 关联：ELEVATION-DESIGN §2.1（锚定子集/缓存双向失效——审查 F-3/F-4/V7 处置）

## 1. 行为规格基线

**M-1（改判——审查 F-11/V11 处置）**：本波为**等价重构非行为变更**——`assemble()` 缺省参会话无关（纯根层），全部现有调用点输出逐字节不变。原「收窄子代理 prompt 投影」描述降级：fork 子代理 assemble({id}) = 根层∪空层 = 与 assemble() 同文本，**可观察行为零变更**；验收断言为等价（两形态文本相同）而非差异。

**锚定子集规则不变量**（DESIGN §2.1）：
1. 会话段锚只指根层段名；会话段间不互锚 → 跨层环构造性不存在；
2. 会话段位次派生根段当前位次（δ/2ⁿ 的 n 按会话层内注册序）→ 根段位次/根缓存不因会话注册漂移；
3. 无锚会话段 = 全部根段后按会话层注册序；
4. 同名会话层覆盖根层（沿用根层注册序位）；身份守卫注销双层各自成立；
5. 缓存：键=(根版本,会话版本)；根层变异→全部合并缓存失效；会话变异→仅该会话失效。

## 2. 审计结论引用

DESIGN §7（V7/F-3/F-4/V8/F-11 处置）；IMPLEMENTATION §1 F2（scope 原语与 `agent:<id>` 层键——registry 层键用 SessionId）。

## 3. 逐模块裁决表

| 模块 | 裁决 | 动作 |
|---|---|---|
| system-prompt registry.ts | **重构** | 根层 Map（现结构原样）+ `Map<SessionId, 层>`；`scoped(id).section(spec)`（**无 variable**——DESIGN §3 裁决）；`assemble({sessionId})` 合并投影；环检测=注册期对「根层∪本会话层」跑同款 wouldCycle（锚定子集下兜底）；缓存双向失效 |
| agent-loop step.ts anchorSystem | **改写** | `deps.prompt.assemble()` → `assemble({ sessionId: session.id })`（等价：子层空/未注册时同文本——§1 M-1） |
| （消费方） | 无 | typed-persona 迁静态串→scoped complete section = **重启条件触发项**（连同世界级变量插值错配一并裁决，DESIGN §3） |

## 4. API 对照表

| 旧 | 新 | 理由 |
|---|---|---|
| `assemble()` | `assemble(options?: { sessionId? })` | D2 分层；缺省向后兼容 |
| — | `scoped(id).section(spec)` | 会话层注册面（无 variable） |

## 5. 测试迁移矩阵

| 旧测试 | 去处 | 动作 |
|---|---|---|
| prompt.test.ts 全部 | 原位 | **移植零改写**（缺省参会话无关——等价锚） |
| （新增）同名覆盖/锚定子集违规（会话段锚会话段→throw）/无锚会话段落尾序 | system-prompt | 新增 |
| （新增）确定性：同参两次 assemble 逐字节相等；根层变异→会话投影即时变；会话变异→他会话投影不变 | system-prompt | 新增（V7/F-4 专项） |
| （新增）M-1 等价断言：assemble({id}) ≡ assemble()（无会话注册时） | system-prompt | 新增 |

## 6. 回滚方案

单波提交可 revert；零消费方=回滚零波及。

## 7. 验收

- [ ] 四门全绿；prompt.test.ts 零改写全绿（缺省路径等价锚）
- [ ] 锚定子集违规 throw 专测绿；缓存双向失效专测绿
- [ ] 性能预算实测（DESIGN §4：assemble ≤1ms @100 段含合并）

## 8. 实施记录（2026-09-20）

- **交付物**：registry 会话层（`scoped(id).section`——锚定子集门「会话段只锚根层段名」注册期 throw；同名会话段经根槽顶替不双发；层内同名后者胜由 Map 语义承担）；合并投影 `mergedOrder`（根序缓存复用 + 会话段按锚分桶插位——δ/2ⁿ 与根层代数同款，n 按会话层注册序；无锚/缺席锚落全部根段之后）；双向缓存失效（根变异→全部会话合并缓存清空；会话变异→仅本会话版本号自增；注册/注销统一走 wrapper 失效面）；`assemble({sessionId})`（缺省参会话无关向后兼容）；anchorSystem 传 session.id。
- **实施期自抓缺陷（W2C-1）**：初版两处——①根名同名的会话段双发（桶位+根位）②disposer 不失效缓存；③`overridden` 集合误标全部会话段（Map 已按键去重，集合多余且致病——测试先行抓出后定位）。三者均修复并有专测钉死。
- **门禁数字**：typecheck ✓ lint ✓（mergedOrder 拆 bucketLayer）test **144 文件/1723 用例**（1716 + 分层 7）e2e 全旅程 ✓ 内核门禁 ✓。
- **等价锚核对**：prompt.test.ts 既有用例**零改写全绿**（缺省参会话无关）；M-1 等价断言（assemble({id}) ≡ assemble() 无会话注册时）专测成立。
- **新增裁决补录**：无偏离定稿。
- **显式挂账**：无。
