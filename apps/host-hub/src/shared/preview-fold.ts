/**
 * 会话正文摘要折叠（列表预览 + 内容搜索的锚点）。
 *
 * 标题取首条用户消息，预览取其后的正文——重复首条等于没提供信息。
 * live（thread/list）与 saved（thread/list_saved）两条来源共用本折叠，语义单一。
 */
import { isEnvelopeSnapshotEvent } from "@x-harness/agent-loop";
import type { SessionEvent } from "@x-harness/session";

export const PREVIEW_CAP = 160;

/**
 * 正文摘要：首条用户消息之后最近一条有实质文本的消息。
 *
 * 标题取首条用户消息，预览要的是「这句之后在聊什么」——重复首条等于没提供信息。
 * 没有后续消息时取最后一条用户消息兜底（对话只有一轮时列表不至于空白）。
 */
export function derivedPreview(events: readonly SessionEvent[], title: string): string {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "user/message" && event.type !== "assistant/message") continue;
    if (isEnvelopeSnapshotEvent(event)) continue;
    const text = event.data.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text !== "") texts.push(text);
  }
  const afterTitle = texts.filter((text) => text !== title);
  const chosen = afterTitle.length > 0 ? afterTitle[afterTitle.length - 1] : texts[texts.length - 1];
  if (chosen === undefined) return "";
  const oneLine = chosen.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CAP ? `${oneLine.slice(0, PREVIEW_CAP)}…` : oneLine;
}

