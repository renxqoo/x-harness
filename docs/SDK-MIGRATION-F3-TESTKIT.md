# F3 迁移文档：@x-harness/testkit

> 状态：草稿。迁移单元：e2e 私有样板提炼为共享测试装置包。
> 旧实现：四 journey 各持 textScript/假 adapter/fake tool 样板（A3）。

## 1. 行为规格基线

- 四 journey 断言**零语义变化**（样板替换，剧本/捕获/计数行为同形）。
- testkit 纯函数零副作用（无 IO/定时器）。

## 2. 交付

```ts
textScript(text): AsyncGenerator<LlmChunk>
scriptedAdapter({name?, calls?, scripts}): LlmAdapter   // scripts.shift() 空剧本回落 textScript("(no script)")——journey 现语义
fakeTool(name, run): ToolDefinition                       // Type.Object({}) + run 包装
```

## 3. 测试：testkit 三用例（剧本产出形态/adapter 捕获与回落/fakeTool 计数）；journey 零改写锚。

## 4. 回滚：单波 revert。

## 5. 验收：四门 + journey 断言零语义变化 + 对抗审查（样板等价性）。

## 7. 实施记录（2026-09-20）

- **交付物**：packages/testkit（textScript/scriptedAdapter——**exhausted 回落参数化**[F-10 处置：文本或函数双形态]/fakeTool）+ 四 journey 换用（agent/toolbox/todo/compaction——delegation 系保留 error-finish 帧私有形态，属 exhausted 函数形态的可表达范围，暂不强制换用记为后续机械项）。
- **门禁数字**：typecheck ✓ lint ✓ test 149 文件/1758 用例 ✓ e2e 全旅程 ✓（**journey 断言零语义变化**——仅样板替换）。
- **挂账**：delegation-journeys/cross-peer/stream-sim 换用（同机械模式，error-finish 帧经 exhausted 函数形态可表达）。
