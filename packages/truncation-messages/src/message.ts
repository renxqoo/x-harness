// 截断配对文案插件（docs/WORK-ERROR-RECOVERY.md C3）：把「面向模型的行为指令长文」从
// 内核外提到域包——内核合成 result 只剩协议短事实（`truncated: not executed`），本插件
// 应答 {content} 整体替换。文案原文自 agent-loop/tool-calls.ts 的旧 TRUNCATED_TOOL_MESSAGE
// 迁来（docs/TRUNCATED-TOOL-RESCUE.md 裁决⑦的解释义务承载者），一字未改。

/** 替换性完整文案：投影降级 {} 断层的解释（半截参数在模型视图渲染为 {}，不可当全量
 *  载荷）+ 不重发引导 + 大负载拆分建议。 */
export const TRUNCATED_TOOL_FULL_MESSAGE =
  "arguments truncated by output token limit — call not executed. The arguments echoed in your tool_use above are NOT shown faithfully (truncated/may render as {}); do not treat them as the full payload you sent. Re-issue the call; for large file writes, split the content into smaller pieces.";
