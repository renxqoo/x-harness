# F2 迁移文档：@x-harness/testkit

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
