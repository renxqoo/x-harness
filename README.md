# x-harness

bun 多包（monorepo）项目——生产可用的通用 Agent harness。

> 设计文档：[docs/DESIGN.md](docs/DESIGN.md)（讨论定案记录；`packages/core` 的模块规划见其 §5）。

## 技术栈

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| [Bun](https://bun.com/docs) | 1.4.2（`packageManager` 固定） | 包管理 + 运行时 |
| TypeScript | 7.x | `tsc --noEmit` 仅做类型检查 |
| vitest | 5.x | 测试运行器：`bun run test` = `vitest run --coverage`（行/语句/函数 ≥90、分支 ≥85 门禁） |
| [oxlint](https://oxc.rs/docs/guide/usage/lint) | 1.x | lint，规则见 `.oxlintrc.json` |

## 目录结构

```
.
├── package.json          # workspace 根：scripts + devDependencies
├── tsconfig.json         # 全仓唯一 TS 配置（覆盖 packages/*）
├── .oxlintrc.json        # oxlint 规则
└── packages/
    └── core/             # @x-harness/core——按 DESIGN.md §9 承载 context/session/llm/agent/agent-loop 模块边界
        ├── package.json  # exports 直接指向 src/index.ts（源码直出，无构建步骤）
        ├── src/          # 当前为种子代码（验证工具链用），实现随 M1+ 里程碑进入
        └── test/
```

约定：

- 新包放在 `packages/<name>/`，命名 `@x-harness/<name>`，`exports` 直接指向 `src/index.ts`——bun 直接运行 TS 源码，不需要构建产物。
- 跨包引用走包名（workspace 符号链接），如 `import { clamp } from "@x-harness/core"`。
- 测试统一从 `vitest` 导入 `describe / it / expect`，用 `bun test` 执行。

## 常用命令

```bash
bun install          # 安装依赖
bun test             # 运行全部测试（bun 运行时）
bun run test:coverage  # 测试 + 覆盖率报表
bun run typecheck    # tsc --noEmit
bun run lint         # oxlint
bun run lint:fix     # oxlint 自动修复
bun run check        # typecheck + lint + test 一键全检
```
