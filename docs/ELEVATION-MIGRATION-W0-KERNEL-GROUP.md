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

- [ ] 四门全绿；**测试文件数/用例数 = 144/1704 逐项相等**（否决级）
- [ ] `git diff -M100%` rename 相似度全 100%（§3 白名单外零内容变更）
- [ ] 门禁脚本四用例绿；人为注入 V5 形态（devDeps 藏边上层 import）时 check 失败（手动验证记录）
- [ ] 对抗审查：对照移动前后 diff 找行为偏差，找不到明说找不到
- [ ] docs 内旧路径引用勘误（AGENTS.md 及 docs/*.md 中 packages/core、packages/tools 等字样）
