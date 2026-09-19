// 初始消息拼接（docs/CLI.md §2.1）：stdin 管道内容 + @file 文本块 + 首条位置参数消息，
// 依序直连；全空 → undefined（无初始 turn）。

export function buildInitialMessage(parts: { readonly stdin?: string; readonly fileText?: string; readonly firstMessage?: string }): string | undefined {
  const joined = `${parts.stdin ?? ""}${parts.fileText ?? ""}${parts.firstMessage ?? ""}`;
  return joined.length > 0 ? joined : undefined;
}
