# System-Prompt 件方案（sections 分层合并 + variables 插值）

> 状态：定稿
> 级别：小（纯加法、单职责、无并发语义；消费方为 agent-loop 每步组装）
> 上游：docs/AGENT-LOOP.md §3（用户裁决：完整 prompt 件）；工具表不在此收集（与 tools 解耦，loop 直取）。

## 1. 契约

token：`systemPrompt` 服务（name: "system-prompt"）。插件 `systemPromptPlugin`（name: "system-prompt"，无 inject）。

```ts
section(input: { name: string; order: number; text: string }): Disposer;   // 同名覆盖（后者胜）；注销按身份守卫
variable(name: string, value: string | (() => string)): Disposer;          // {{name}} 插值；函数惰性求值（每次 assemble 现算）
assemble(): { readonly text: string };                                      // sections 按 (order, name) 升序 join("\n\n") 后插值；无 sections → ""
```

- 插值规则：`{{name}}` 整段替换；未注册变量保持原样（策略插件可后补）；变量值不再递归插值（单层）。
- 注册参数垃圾（空 name / order 非有限数 / text 非 string / value 非 string|fn）→ throw（装配期错误，同内核 provide 语义）。

## 2. 问题域

**处理**：section 注册/覆盖/注销、variable 注册/注销、assemble 合并插值。
**不处理**：按 agent 分层（注册发生在哪个 ctx 层就活在哪层——消费方用 scope 注册即得分层）；上下文注入（归 agent/pre-step 消费方）；工具表收集（loop 从 toolRegistry 直取）；prompt 缓存/长度治理。

## 3. 测试口径

- 契约：token 名锁定；assemble 确定性（两次调用相等）。
- 合并：order 升序、同 order 按 name、同名覆盖后者胜、空注册 → ""、单 section 无 join。
- 插值：字符串/函数值、未注册保持、单层不递归、函数每次现算。
- 生命周期：disposer 注销、同名覆盖后旧 disposer 不误删新注册（身份守卫）、参数垃圾 throw 表。

## 4. 验收清单

- [ ] §1 逐条；§3 表逐条；四门全绿 + 覆盖率数字如实报告
