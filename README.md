# x-harness

一切皆插件的通用 Agent 运行时——基于 Bun 的 TypeScript monorepo，由独立、可组合的包装配出生产可用的编码 Agent。

## 项目概览

**44 个包 + 4 个应用**，覆盖完整 Agent 技术栈：主循环（`agent-loop`）、子 Agent 分工与工作流编排、上下文压缩、权限与沙箱、会话持久化（检查点 + 邮箱）、工具集、插件体系、token 计量与遥测，以及跨进程可远程接入的宿主架构（`host-hub` / `hub-gateway` / `hub-relay`）。

所有能力——包括 LLM 层、工具层、遥测层——都通过同一个插件接口（`@x-harness/core`）注册。没有硬接线：运行时在启动时由插件装配而成，任何一层都可以替换或扩展，不动内核。

392 个测试文件，约 3,300 个用例。

## 基准测试

在 [sample-agentic-coding-harness-benchmarks](https://github.com/aws-samples/sample-agentic-coding-harness-benchmarks)（AWS 开源 Agent harness 基准套件）上评测——数据集 `mcp-gateway-registry-v2`：21 个真实编码任务，取自 `mcp-gateway-registry` 项目已关闭的上游 issue，难度分档 5 trivial / 5 low / 6 medium / 5 high，由 6 工件 rubric judge 判分。原始运行数据：[`benchmark/results/`](benchmark/results/)。

x-harness CLI 无监督模式（`-p --mode json`），模型 glm-5.3-flash，单次运行，2026-09-27（逐任务工具轨迹见 [`benchmark/results/`](benchmark/results/)；每任务 15M 的 token 流文件未入库）：

| 指标 | 结果 |
| --- | --- |
| task_score 均分 | **80.39 / 100**（21/21 任务完成，其中 20 个 6/6 工件齐全）|
| 分档均分 | trivial 87.32 · low 85.40 · medium 83.03 · high 82.36 |
| 成本 | 约 $0.93/任务（按 glm-5.3 公开价折算；flash 实际免费）|
| 缓存命中 | 141.2M / 145.6M 输入 tokens = 97.0% |
| 时延 | 单任务中位 27 分钟 / 最长 53 分钟 |

同数据集官方榜单参照（均为 claude-code harness）：claude-opus-5 得 82.83、$11.95/任务；glm-5.3 得 80.11、$7.04/任务。读数口径：本轮 judge 为 glm-5.3（与被测模型同家族），跨 harness 分数对比存在 ±1~3 分的 judge 宽严偏移；稳妥的结论是 x-harness 与官方头部 harness 处于同一质量档，成本约为其 1/8，且 97% 缓存命中使低成本成为结构性的，不是偶然。

基准结果反哺了运行时改进——usage/缓存计量修复、轮次收敛、工具结果截断——并由复测验证（[`benchmark/RESULTS.md`](benchmark/RESULTS.md)）。

## 目录结构

```
.
├── packages/             # 44 个包，命名 @x-harness/<name>，exports 直指 src/index.ts
│   ├── agent-loop/       # Agent 主循环
│   ├── agent-delegation/ # 子 Agent 分工
│   ├── agent-workflow/   # 工作流编排
│   ├── compaction/       # 上下文压缩（+ autocompact）
│   ├── permission/       # 权限决策（+ permission-modes / sandbox）
│   ├── session-*/        # 会话持久化（jsonl）/ 检查点 / 邮箱
│   ├── llm*/             # LLM 抽象 + retry / repetition-guard / replay-guard
│   ├── tool-*/           # bash / read / write / edit / grep / plan 等工具
│   ├── plugin-*/         # 插件协议与管理器
│   └── token-*/          # token 计量与分析（+ telemetry-sqlite）
├── apps/                 # cli / host-hub / hub-gateway / hub-relay
└── benchmark/            # 基准数据集与原始运行结果
```

约定：

- 新包放在 `packages/<name>/`，命名 `@x-harness/<name>`，`exports` 直接指向 `src/index.ts`——Bun 直接运行 TS 源码，无构建产物。
- 跨包引用走 workspace 包名，如 `import { clamp } from "@x-harness/core"`。
- 测试从 `vitest` 导入 `describe / it / expect`，模块单测放同目录 `__test__/`。

## 技术栈

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| [Bun](https://bun.com/docs) | 1.4.2（`packageManager` 固定） | 包管理 + 运行时 |
| TypeScript | 7.x | `tsc --noEmit` 仅做类型检查 |
| vitest | 5.x | 测试运行器：`bun run test` = `vitest run --coverage` |
| [oxlint](https://oxc.rs/docs/guide/usage/lint) | 1.x | lint，规则见 `.oxlintrc.json` |

## 快速开始

```bash
bun install            # 安装依赖
bun test               # 运行全部测试 + 覆盖率（bun 运行时）
bun run typecheck      # tsc --noEmit
bun run lint           # oxlint
bun run e2e            # 端到端
bun run check          # typecheck + 内核依赖校验 + lint + build + test + e2e 全检
```
