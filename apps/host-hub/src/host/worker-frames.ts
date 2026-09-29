import { WORKER_BACKEND_ID, WORKER_PROTOCOL_VERSION } from "../protocol/internal.ts";
import { classifyResponseHead } from "../shared/frame-classify.ts";
import { INTERNAL_ID_PREFIX } from "../protocol/internal.ts";
import { isHubErrorShape, type HubErrorShape } from "../shared/errors.ts";

const CONTROL_COMMANDS = new Set(["thread/start", "thread/resume", "thread/stop", "fork", "clone"]);

const SETTLED_HEAD =
  /^\{"type":"event","threadId":"(?:[^"\\]|\\.)*","name":"settled","payload":\{"sendId":"((?:[^"\\]|\\.)*)"/;

export interface ControlFrame {
  command: string;
  id: string | undefined;
  data: unknown;
  error?: HubErrorShape;
}

export interface FrameRelayDeps {
  emitClient: (line: string) => void;
  onHelloRejected: (reason: string) => void;
  onHeartbeat: (beat: { idleMs: number; streaming: boolean; sessionPath: string | null; rssBytes: number | null }) => void;
  onResponse: (id: string | undefined, success: boolean) => void;
  onControlResponse: (frame: ControlFrame) => boolean;
  onSettled: (sendId: string) => void;
  onViolation: (reason: string) => void;
}

export interface FrameRelay {
  ingest(line: string): boolean;
  helloSeen(): boolean;
}

export function createFrameRelay(deps: FrameRelayDeps): FrameRelay {
  let helloSeen = false;

  function ingestHello(line: string): boolean {
    if (!line.startsWith('{"type":"hello"')) {
      deps.onViolation("first frame is not hello");
      return false;
    }
    try {
      const hello = JSON.parse(line) as { protocolVersion?: unknown; backendId?: unknown };
      if (hello.protocolVersion !== WORKER_PROTOCOL_VERSION || hello.backendId !== WORKER_BACKEND_ID) {
        deps.onHelloRejected(`hello mismatch: ${String(hello.protocolVersion)}/${String(hello.backendId)}`);
        return false;
      }
    } catch {
      deps.onViolation("hello unparseable");
      return false;
    }
    helloSeen = true;
    return true;
  }

  function ingestHeartbeat(line: string): boolean {
    try {
      const beat = JSON.parse(line) as { idleMs?: unknown; streaming?: unknown; sessionPath?: unknown; rssBytes?: unknown };
      deps.onHeartbeat({
        idleMs: typeof beat.idleMs === "number" ? beat.idleMs : 0,
        streaming: beat.streaming === true,
        sessionPath: typeof beat.sessionPath === "string" ? beat.sessionPath : null,
        rssBytes: typeof beat.rssBytes === "number" ? beat.rssBytes : null,
      });
    } catch {
    }
    return true;
  }

  function ingestResponse(line: string): boolean {
    const head = classifyResponseHead(line);
    if (head === undefined) {
      deps.onViolation("response head unclassifiable");
      return true;
    }
    deps.onResponse(head.id, head.success);
    if (CONTROL_COMMANDS.has(head.command) || (head.id !== undefined && head.id.startsWith(INTERNAL_ID_PREFIX))) {
      let data: unknown;
      let error: HubErrorShape | undefined;
      try {
        const parsed = JSON.parse(line) as { data?: unknown; error?: unknown };
        data = parsed.data;
        if (isHubErrorShape(parsed.error)) error = parsed.error;
      } catch {
        data = undefined;
      }
      const forward = deps.onControlResponse({ command: head.command, id: head.id, data, ...(error !== undefined ? { error } : {}) });
      if (!forward) return true;
      deps.emitClient(line);
      return true;
    }
    deps.emitClient(line);
    return true;
  }

  function ingestEvent(line: string): boolean {
    const settled = SETTLED_HEAD.exec(line);
    if (settled !== null) deps.onSettled(JSON.parse(`"${settled[1]}"`) as string);
    deps.emitClient(line);
    return true;
  }

  return {
    helloSeen: () => helloSeen,
    ingest(line: string): boolean {
      if (!helloSeen) return ingestHello(line);
      if (line.startsWith('{"type":"heartbeat"')) return ingestHeartbeat(line);
      if (line.startsWith('{"id":')) return ingestResponse(line);
      if (line.startsWith('{"type":"event"')) return ingestEvent(line);
      deps.emitClient(line);
      return true;
    },
  };
}
