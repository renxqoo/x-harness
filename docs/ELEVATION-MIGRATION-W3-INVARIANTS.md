# W3 迁移文档：运行时不变量 + 指纹观测 + 收尾核销

> 状态：定稿（2026-09-20 对抗审查处置后——V10/F-12 三口径补齐）
> 迁移单元：「模型可见必落盘」断言（debug 可开）+ 指纹观测面 + 全仓收口
> 旧实现：落盘链路已存在（F1：anchorSystem append/replace/去重 + deriveMessages 重放 + lineage 播种 + compaction 感知）；断言与观测缺失
> 关联：ELEVATION-DESIGN §1 D1/§5；依赖 W2A（schemas 数据源）/W2C（assemble 参会）

## 1. 行为规格基线

- 现行：step 期 `anchorSystem` 装配→比对锚点→append/replace/no-op；请求体 `messages = session.deriveMessages()`（step.ts:114/256 纯折叠不变量）。
- W3 全部加法，零行为变更；断言关态热路径零开销。
- **可判定性（审查 V10 核查结论）**：replace 按位置端点折叠、多次 replace 锚点恒落原位、/compact 不制造多锚、dormant 空文本锚含于谓词——多步形态可判定，断言成立。

## 2. 审计结论引用

IMPLEMENTATION §1 F1/F7；DESIGN §7 台账（V10/F-12 处置）。

## 3. 逐模块裁决表（含断言三口径）

| 模块 | 裁决 | 动作 |
|---|---|---|
| agent-loop step.ts | **加法** | debug 断言（旋钮形态实施期按现有 debug 面定，补录 API 表），**三口径**（V10/F-12 处置）：①**静态串通道**：`options.systemPrompt` 在场时比对对象 = 落盘文本 == options.systemPrompt（assemble 不参与，记「静态通道」标记）；②**no-op 分支重验**：锚点文本相同≠装配未漂——no-op 分支下**重算 assemble 比对指纹**（这才是 W1 fn 段步间漂移的真探测器——「模型可见==当步落盘」近重言检不出）；③**执行时点排除面**：断言在 dispatch 前瞬时执行，autocompact 步中介入面实施期排查并记排除清单。失配 → throw（fail-loud） |
| agent-loop / token-meter | **加法** | 指纹观测：assemble fingerprint 进现有计量面（不进 session 事件体——DESIGN §2.4） |
| tool-bash bash.test.ts host-exit 用例 | **根治或隔离标注** | 环境性（Bun.spawn+exit-handler 时序）则 describe.skip + 挂账理由；禁止静默删用例 |
| docs 全量 | 同步 | SYSTEM-PROMPT.md/CLI.md/AGENTS.md + 本套状态推进「已核销」 |

## 4. API 对照表

无破坏性变更；断言旋钮形态实施期定后补录。

## 5. 测试迁移矩阵

| 旧测试 | 去处 | 动作 |
|---|---|---|
| （新增）断言正例：一致零动作；篡改锚点→throw；静态串口径；no-op 漂移（fn 段文本变了锚未换）→throw | agent-loop | 新增 |
| （新增）指纹：同内容稳定/变更即变/进计量面 | agent-loop 或 token-meter | 新增 |
| host-exit 用例 | 原位 | 根治或 skip+挂账 |

## 6. 回滚方案

单波提交可 revert；断言默认关。

## 7. 验收（含全仓核销清单）

- [ ] 四门全绿；断言开关双态测试（开态三口径/关态零开销）
- [ ] e2e 全旅程绿；快照无漂移（apps/cli prompt 与基线逐字节一致）
- [ ] ELEVATION 全套文档状态推进；IMPLEMENTATION §5 波次表逐波勾选
- [ ] DESIGN §3「不处理」逐项确认无留白转化；重启条件清单复核
- [ ] 对抗审查终轮：文档 vs 代码一致性（说到的都在、没说的没加）
