// 摘要注入段提供（docs/COMPACTION.md §15.2）：事件卷折尾快照 → listText 同构渲染。
// 三态：无词条整段缺席（不诱导）／空清单 No tasks（用过且当前空——明确事实）／行式清单。

import type { SessionEvent } from "@x-harness/session";
import { latestTodoSnapshot, tasksOfSnapshot } from "./store.ts";
import { listText } from "./tools.ts";

export function todoSummarySection(events: readonly SessionEvent[]): string | undefined {
  const last = latestTodoSnapshot(events);
  if (last === undefined) return undefined;
  return `## Task List\n${listText(tasksOfSnapshot(last))}`;
}
