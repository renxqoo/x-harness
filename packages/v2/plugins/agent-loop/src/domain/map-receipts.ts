import type { LlmMessage, UserContent } from "../../../llm/src/index";
import type { AgentToolReceipt } from "../contracts/types";

export function mapReceipts(results: readonly AgentToolReceipt[]): readonly LlmMessage[] {
  return results.map((item) => {
    if (item.outcome === "unknown")
      return {
        role: "tool",
        callId: item.callId,
        isError: true,
        content: [
          { type: "text", text: "Tool execution outcome is unknown. Do not retry automatically." },
        ],
      };

    const output = item.output;
    const content: UserContent[] = [...output.content];

    if (output.structured !== undefined)
      content.push({ type: "text", text: JSON.stringify(output.structured) });

    if (!content.length) content.push({ type: "text", text: "" });

    return {
      role: "tool",
      callId: item.callId,
      ...(output.isError !== undefined ? { isError: output.isError } : {}),
      content,
    };
  });
}
