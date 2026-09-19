# W0 迁移文档：内核分组 + 依赖门禁（试运行单元）

> 状态：定稿（2026-09-20 对抗审查处置后——V3/F-7「纯移动」证伪，裁决表已补全）
> 迁移单元：包布局分层（packages/core/* 内核组成立）+ 依赖方向机器门禁
> 旧实现：本仓 **28 包**平铺布局（`packages/*` glob）；无旧仓库
> 关联：ELEVATION-IMPLEMENTATION §2.1/§3

## 1. 行为规格基线

- 现有 **144 测试文件 / 1704 用例**全绿；typecheck / lint / e2e 全绿。
- **移动不变量（修正版）**：src 文件 git rename 相似度 100%；例外白名单 = §3 裁决表所列**路径字面量改写**（vitest/tsconfig glob、build 脚本、两处子进程测试脚本内的硬编码路径）——除此之外零改写。
- **覆盖不塌缩硬指标**：迁移后 `bun run test` 报告测试文件数/用例数与迁移前**逐项相等（144/1704）**——单层 glob 静默吞掉 core 组测试是本波最大风险（审查 V3），此项为否决级验收。

## 2. 审计结论引用

IMPLEMENTATION §1 F5（glob/包名）、§2.1（裁决表）、§3（门禁强形式）；DESIGN §7 台账（V3/V4/V5 处置）。

## 3. 逐模块裁决表

| 旧位置 | 新位置/动作 | 裁决 |
|---|---|---|
| packages/core/ | packages/core/context/ | git mv（包名 @x-harness/core 不变） |
| packages/tools/ | packages/core/tools/ | git mv |
| packages/system-prompt/ | packages/core/system-prompt/ | git mv |
| packages/exec-env/ | packages/core/exec-env/ | git mv |
| packages/session/ | packages/core/session/ | git mv |
| package.json workspaces | + "packages/core/*" | glob 扩展 |
| **vitest.config.ts:5,8** | include/coverage.include 单层 glob → 兼容双层（`packages/*/src/**` + `packages/core/*/src/**`） | **路径字面量改写**（V3——否则测试/覆盖静默消失、绿灯空洞） |
| **tsconfig.json** | include 同款双层化 | 同上（typecheck 覆盖塌缩） |
| **package.json build 脚本** | `packages/core/src/index.ts` → `packages/core/context/src/index.ts` | 同上（此项会响亮报错，仍入表） |
| **tool-bash bash.test.ts:185-187** | 子进程脚本内 `packages/core|tools|exec-env` 硬编码路径 → 新路径 | 同上（该文件即 F7 偶发红所在，红上加红难归因——改完立即单跑归因） |
| **tool-grep grep.test.ts:293-295** | 同款 | 同上 |
| （新增） | scripts/check-kernel-deps.ts + scripts/__test__/ | 门禁脚本（强形式见 IMPLEMENTATION §3） |
| package.json scripts | check 串入 check:kernel-deps（typecheck 之后） | 流水挂载 |

## 4. API 对照表

无 API 变更（试运行单元价值即验证流程本身）。

## 5. 测试迁移矩阵

| 旧测试 | 去处 | 动作 |
|---|---|---|
| 全部现有测试 | 原位随包 | 移植（除 §3 两处路径字面量） |
| （新增）check-kernel-deps.test.ts | scripts/__test__/ | 新增四用例：①正例（core 组互依+typebox 合法）②反例（core 组 import 上层包**经 dependencies**）③反例（core 组 import 上层包**藏 devDependencies**——V5 真实违规形态）④反例（src import 说明符未声明于 package.json） |

## 6. 回滚方案

两个提交（移动+路径改写 / 门禁脚本），各自可 revert；无数据动作。

## 7. 验收

- [x] 四门全绿；测试文件数/用例数：存量 144/1704 零丢失（否决级达成；门禁测试 +1 文件，用例 1704→1710 含门禁 6 用例）
- [x] `git diff -M100%` rename 88 个 @100%（收口审查逐项复核：numstat 全 0/0；非 rename 19 文件与裁决表一致）
- [x] 门禁脚本用例绿（v1 四用例 → v2 六用例）；V5 注入验证 exit 1（人工记录，静态不可复核——如实标注）
- [x] 对抗审查完成：移动零行为漂移（审查结论）；门禁 v1 绕过面 12 项 → v2 处置（见 §9）
- [x] docs 旧路径勘误（§8 初记「五份」不实——实为 EXEC-ENV/SESSION-RESUME/SESSION/TODO/TOOLS 五份勘误 + SYSTEM-PROMPT.md 一处「旧仓路径未随迁」标注，共六份改动；EXEC-ENV.md:15 漏改已于收口处置补上）

## 8. 实施记录（2026-09-20 收口）

- **交付物**：五包迁入 packages/core/{context,tools,system-prompt,exec-env,session}（88 文件）；workspaces/vitest/tsconfig/build 路径改写；scripts/check-kernel-deps.ts 强形式门禁（扫 src 说明符）+ 四用例；check 流水挂载（typecheck 之后）；docs 路径勘误五份。
- **门禁数字**：typecheck ✓ lint ✓ build ✓ test **145 文件/1708 用例**（存量 144/1704 零丢失 + 门禁测试 +1 文件/+4 用例）✓ e2e 全旅程 ✓ rename **88 个 @100% 相似度** ✓ V5 形态人工注入验证（藏 devDeps 的 upper-layer import → exit 1，复原后绿）✓。
- **实施期发现并修复的真实缺陷（W0-1）**：对抗审查的路径字面量清单不完整——plugin-manager 四个测试文件以**相对路径**引用被迁包（`../../../core/src/index.ts`，经 `new URL`/`resolve` 构造），字符串 grep 不可见。症状：25 用例红（子进程 module-not-found 连锁）。修法：四处相对路径同步改 `../../../core/context/src/index.ts`。教训：路径引用有三形态（整串字面量/glob/相对构造），纯移动审计须三者俱扫——补录为后续波次审计清单项。
- **新增裁决补录**：无（D5 白名单与强形式门禁按定稿实施）。
- **显式挂账**：无。

## 9. 收口对抗审查处置（2026-09-20，W0 修订）

审查结论：**移动纯净**（rename 88@100% 逐项复核、glob 覆盖等价无吞漏、九处路径改写逐字符纯路径、正则对现行 124 说明符零漏报）；**门禁 v1 存在实测绕过面**；文档收口两处不实。处置：

- **门禁 v2**（#1-#8/#12）：弃正则军备竞赛，改词法级说明符提取（`from|import|require + 引号`，含无空格/动态 import()/require/import=require/模板字面量形态；含插值模板截断捕获=fail-closed）；扫描范围扩全包全扩展名（.ts/.tsx/.mts/.cts/.js/.mjs，node_modules/dist 除外）；`./ ../` 外的说明符一律裁决；内核组含子路径匹配。新增两用例锁行为（绕过形态三连检、__test__/.js 目录范围检）。v2 真实仓实跑零误报。
- **#9 裁决**：__test__ 纳入扫描但只查 @x-harness 上层边——测试用 vitest 等外部库与内核纯净性无关（纯净性本质=不依赖上层）。
- **#11**：scripts/ 纳入 tsconfig include（typecheck 覆盖）；coverage 分母维持不含 scripts（门禁代码由六用例背书，记录为已知边界）。
- **#12 接受**：注释/字符串内同形文本会误报——fail-closed 方向，core 组现无此形态，记录不修。
- **文档不实修正**：§8「五份」→ 六份（见 §7 第五项勾选注）；EXEC-ENV.md:15 漏改补上；§7 验收框本轮勾选。
- 用例数：1708 → 1710（+2 绕过形态用例）。
