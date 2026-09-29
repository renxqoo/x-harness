import type { AssistantStreamFrame } from "@x-harness/agent-loop";
import type { SessionEvent, SessionEventType } from "@x-harness/session";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const MAX_TOOL_DETAIL = 80;

export interface RenderIO {
  readonly write: (text: string) => void;
  readonly isTTY: boolean;
}

export interface StreamRenderer {
  frame(frame: AssistantStreamFrame): void;
  sessionEvent(event: SessionEvent<SessionEventType>): void;
}

type LastKind = "text" | "thinking" | undefined;

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > MAX_TOOL_DETAIL ? `${line.slice(0, MAX_TOOL_DETAIL)}…` : line;
}

export function createStreamRenderer(io: RenderIO): StreamRenderer {
  let lastKind: LastKind;
  const names = new Map<string, string>();

  const emit = (text: string): void => io.write(text);
  const newline = (): void => io.write("\n");

  return {
    frame: (frame) => {
      if (frame.phase === "start") {
        lastKind = undefined;
        return;
      }
      if (frame.phase === "end") {
        if (lastKind !== undefined) newline();
        if (frame.kind === "attempt") newline();
        lastKind = undefined;
        return;
      }
      if (frame.kind !== lastKind && lastKind !== undefined) newline();
      lastKind = frame.kind;
      emit(frame.kind === "thinking" && io.isTTY ? `${DIM}${frame.text}${RESET}` : frame.text);
    },
    sessionEvent: (event) => {
      if (lastKind !== undefined) {
        newline();
        lastKind = undefined;
      }
      if (event.type === "tool/call") {
        names.set(event.data.callId, event.data.name);
        emit(`→ ${event.data.name} ${firstLine(event.data.arguments)}\n`);
        return;
      }
      if (event.type === "tool/result") {
        const name = names.get(event.data.callId) ?? event.data.callId;
        const mark = event.data.isError === true ? "✗" : "✓";
        const detail = event.data.isError === true ? ` ${firstLine(event.data.content)}` : "";
        emit(`${mark} ${name}${detail}\n`);
      }
    },
  };
}
