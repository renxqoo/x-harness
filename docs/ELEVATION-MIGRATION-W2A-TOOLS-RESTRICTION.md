# W2A 迁移文档：tools restriction + 读回面 + 执行面门禁保留

> 状态：定稿（2026-09-20 对抗审查处置后）
> 迁移单元：ToolRegistry 会话层 restriction、`restrictionOf` 读回、执行面 allowedTools 改喂投影名集（**门禁不删**——审查 V1/F-1/H-1 处置）
> 旧实现：`AgentOptions.tools` 双消费（step.ts:204 投影 + step.ts:335→tool-calls.ts:42-48 执行拦截配对落账）；delegation X15 沿树收窄（spawn.ts:142 narrowTools / plugin.ts:138 parentToolsOf / revive.ts:82）
> 关联：ELEVATION-DESIGN §2.2/§3；先行：W0/W1

## 1. 行为规格基线（等价判定标准）

ScopeKey = SessionId（身份唯一：fork 铸新 id spawn.ts:107-125、revive 沿用同 id；ctx.scope 层键为其加前缀 `agent:<id>`——两键映射在此注明，registry 层键与 dispatch `ToolExecContext.session` 对齐）。

1. `--tools a,b --exclude-tools c` → 可见面 = 注册集∩{a,b}−{c}；`--no-tools` → 空集（resolve-agent-options.ts resolveToolNames 纯函数保留不动）。
2. delegation 收窄：`narrowTools(父当前白名单, typeTools)` 沿树只收窄（X15）；复活重放同口径。
3. **执行面双执法**：白名单外 tool_use → `denyNotAllowed` 拦截，落 `tool/call`+`tool/result(isError: "tool-not-allowed:<name>")` 配对（delegation.test.ts:333-353「白名单双执法（X15）」专测为规格锚）。
4. resume 无工具 flag = 显式全集（现状即放开；resolve-agent-options.test.ts:47-50 钉死——原「不静默放开」注释词不达意，W2B 一并勘误）。
5. `--system-prompt` 静态串优先（step.ts:138）不变。

## 2. 审计结论引用

IMPLEMENTATION §1 F3（消费方全集含 step.ts:335/plugin.ts:138/run-repl spread）；DESIGN §7 台账。

## 3. 逐模块裁决表

| 模块 | 裁决 | 动作 |
|---|---|---|
| tools/src/registry.ts | **重构** | 会话层 `Map<SessionId, {filter}>`；`scoped(id).restrict(filter\|"deny-all")`（disposer 挂调用方）；`restrictionOf(id)`；`schemas({sessionId})` 投影=根层−restriction（`get/dispatch` 世界视图不变） |
| agent-loop step.ts:204 | **改写** | `allowedSchemas(deps.tools.schemas(), deps.options.tools)` → `deps.tools.schemas({ sessionId: session.id })`（**通道暂不删**——W2A 与 W2B 间过渡态：step 仍读 options.tools 存在时优先？**否**——W2A 即切换数据源，options.tools 读取点本波从 step 移除，通道字段留 W2B 删） |
| agent-loop step.ts:335 + tool-calls.ts | **改写（门禁保留）** | `allowedTools` 改喂 `schemas({sessionId})` 投影名集（或 restrictionOf 展开含 deny-all→[]）；`denyNotAllowed` 拦截与配对落账**逐字节不动** |
| agent-delegation spawn.ts:142 | **改写** | `narrowTools(registry.restrictionOf(parent.session.id), spec.named?.tools)` → `scoped(child.session.id).restrict(结果)`；disposer 挂子代理 sessionDisposed |
| agent-delegation plugin.ts:138 + revive.ts:82 | **改写** | `parentToolsOf` 改读 `registry.restrictionOf(session)`；revive 后 `scoped(id).restrict(重放值)` |

## 4. API 对照表

| 旧 | 新 | 理由 |
|---|---|---|
| — | `scoped(id).restrict(...)` / `restrictionOf(id)` | D2 机制统一；X15 输入源（V2） |
| `allowedTools: options.tools`（step 传入） | `allowedTools: schemas({sessionId})` 名集 | 执行面门禁保留（V1 反转裁决） |
| `schemas()` | `schemas(options?)` | 分层投影；缺省根层向后兼容 |

## 5. 测试迁移矩阵

| 旧测试 | 去处 | 动作 |
|---|---|---|
| delegation.test.ts「白名单双执法（X15）」 | 原位 | **移植零改写**（本波等价锚——改一字即回退方案） |
| narrowTools 单元用例 | 原位 | 移植（纯函数不动） |
| （新增）restrict/restrictionOf/deny-all 往返、disposer 注销、泄漏（sessionDisposed 后投影复原） | tools | 新增 |
| （新增）执行面：白名单外调用经新数据源仍配对落账 | agent-loop | 新增 |

## 6. 回滚方案

单波提交可 revert；options.tools 通道字段在本波**仍在**（仅 step 不再读），回滚即恢复两读取点。

## 7. 验收

- [ ] 四门全绿；§1 清单 1-5 逐条等价（对抗审查对照 X15 专测零改写）
- [ ] `restrictionOf` 供 delegation 血缘（孙代收窄有专测：父 restrict 后 spawn typed 子，交集语义=现状）
- [ ] 泄漏回归绿；性能预算实测记录（DESIGN §4）

## 8. 实施记录（2026-09-20）

- **交付物**：tools registry 会话层（restrict 身份守卫覆盖/restrictionOf 读回/schemas({sessionId}) 投影/deny-all 空投影/dropRestriction 内部面）；toolsPlugin 挂 sessionDisposed 自动注销；step.ts 双点切换（dialStep 投影 + allowedTools 喂投影名集——**双执法保留**，denyNotAllowed 零改动）；delegation 三点（spawn restrictChildTools 读父 restrictionOf / plugin parentToolsOf / revive X15 重放）；narrowTools 放宽 ToolFilter（deny-all ∩ 任何 = 空，X15 单调）；CLI main 初始注册（create 恒注册全量快照、resume 带 flag 才注册）+ REPL makeNext 单点重注册（F-2 三分支）。
- **裁决补录（偏离定稿的切割调整）**：CLI main 与 REPL makeNext 从 W2B 挪入本波——step 切数据源后所有现行 options.tools 写点必须同波迁移，否则 W2A/W2B 之间 --tools 用户丢白名单（过渡态行为保持）。W2B 收窄为：删通道字段 + resolve-agent-options 改写 + 注释勘误 + grep 死透。
- **门禁数字**：typecheck ✓ lint ✓（buildChild 复杂度拆 restrictChildTools）test **144 文件/1716 用例**（1712 + registry 3 + 泄漏 1）e2e 全旅程 ✓ 内核门禁 ✓。
- **等价锚核对**：delegation.test.ts「白名单双执法（X15）」执行面用例**零改写通过**；「沿树只收窄」内部态断言按迁移矩阵改读 restrictionOf（唯一真相迁移）；resolve-agent-options.test.ts 零改写通过。
- **新增裁决补录**：无其他。
- **显式挂账**：无。
