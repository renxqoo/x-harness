import { randomUUID } from "node:crypto";
import { uiRequestFrame } from "../protocol/frames.ts";

const RESERVED_KEYS = new Set(["type", "requestId", "threadId", "method"]);

export interface PendingDialog {
  requestId: string;
  threadId: string;
  method: string;
  payload: Record<string, unknown>;
}

export interface DialogBrokerDeps {
  sendFrame: (line: string) => void;
  confirmTimeoutMs: number;
}

export interface ConfirmFields {
  tool: string;
  summary?: string;
  reason: string;
  options?: readonly string[];
  suggestedRule?: string;
  escalate?: { readonly command: string; readonly failureText: string };
}

export interface ConfirmAnswer {
  readonly allowed: boolean;
  readonly memory?: "session" | "project" | "user";
  readonly ruleOverride?: string;
}

export function createDialogBroker(deps: DialogBrokerDeps) {
  const pending = new Map<
    string,
    { dialog: PendingDialog; settle: (value: ConfirmAnswer) => void; timer: ReturnType<typeof setTimeout> }
  >();

  function emitRequest(dialog: PendingDialog): void {
    const safePayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dialog.payload)) {
      if (RESERVED_KEYS.has(key) || key === "__proto__") continue;
      safePayload[key] = value;
    }
    deps.sendFrame(uiRequestFrame({ requestId: dialog.requestId, threadId: dialog.threadId, method: dialog.method, payload: safePayload }));
  }

  return {
    confirm(threadId: string, fields: ConfirmFields, signal?: AbortSignal): Promise<ConfirmAnswer> {
      return new Promise<ConfirmAnswer>((resolve) => {
        const requestId = randomUUID();
        const dialog: PendingDialog = {
          requestId,
          threadId,
          method: "confirm",
          payload: { ...fields },
        };
        let settled = false;
        const settle = (value: ConfirmAnswer): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pending.delete(requestId);
          resolve(value);
        };
        const onAbort = (): void => settle({ allowed: false });
        const timer = setTimeout(() => settle({ allowed: false }), deps.confirmTimeoutMs);
        if (signal !== undefined) {
          if (signal.aborted) {
            settle({ allowed: false });
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
        pending.set(requestId, { dialog, settle, timer });
        emitRequest(dialog);
      });
    },
    resolve(requestId: string, payload: unknown): boolean {
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      if (payload !== null && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        if (record["verdict"] === "allow" || record["verdict"] === "deny") {
          const memory = record["memory"];
          entry.settle({
            allowed: record["verdict"] === "allow",
            ...(memory === "session" || memory === "project" || memory === "user" ? { memory } : {}),
            ...(typeof record["rule"] === "string" && record["rule"] !== "" ? { ruleOverride: record["rule"] } : {}),
          });
          return true;
        }
        if (typeof record["confirmed"] === "boolean") {
          entry.settle({ allowed: record["confirmed"] });
          return true;
        }
      }
      entry.settle({ allowed: false });
      return true;
    },
    denyAll(): void {
      for (const entry of pending.values()) entry.settle({ allowed: false });
    },
    pendingCount(): number {
      return pending.size;
    },
    pendingAll(): PendingDialog[] {
      return [...pending.values()].map((entry) => entry.dialog);
    },
  };
}

export type DialogBroker = ReturnType<typeof createDialogBroker>;
