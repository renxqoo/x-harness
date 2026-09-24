// 续写指令文本（agent-continuation policy.ts 同源——错误感知变体前置句在 plugin 拼接）。
// 不直接 import @x-harness/agent-continuation：策略包间不互依（与 classify.ts 不引 llm-retry
// 同款纪律），文本漂移由两侧测试锚词共同钉死。
export const OUTPUT_CONTINUATION_INSTRUCTION =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
