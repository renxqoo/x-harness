// 存在性检查（docs/SKILL.md §1.3）：surface 中是否已有与渲染块逐字节相同的
// text 块 user/message。扫描全部 text 块——content 可为空数组、首块可为
// tool_use，不假设 content[0]。

import type { Session } from "@x-harness/session";

export function blockPresent(session: Session, block: string): boolean {
  return session.surface().some((node) => {
    if (node.event.type !== "user/message") return false;
    const content = (node.event.data as { readonly content?: readonly unknown[] }).content ?? [];
    return content.some((part) => {
      const candidate = part as { readonly type?: unknown; readonly text?: unknown };
      return candidate.type === "text" && candidate.text === block;
    });
  });
}
