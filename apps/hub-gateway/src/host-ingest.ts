import { classifyHostLine } from "./fanout.ts";
import type { Fanout } from "./fanout.ts";
import type { DeviceRegistry } from "./device-registry.ts";
import type { ThreadsRegistry } from "./threads-registry.ts";
import type { AuditLog } from "./audit.ts";

export interface HostIngestDeps {
  fanout: Fanout;
  devices: DeviceRegistry;
  threads: ThreadsRegistry;
  audit: AuditLog;
  pendingByHostId: Map<string, { deviceId: string; commandId: string; command: string; ownerSession?: unknown }>;
  sendToDevice(deviceId: string, frame: import("@x-harness/remote-protocol").Frame): void;
  replyOwner(pending: { deviceId: string; commandId: string; command: string; ownerSession?: unknown }, _body: unknown): void;
}

export interface HostIngest {
  ingest(line: string): void;
}

export function createHostIngest(deps: HostIngestDeps): HostIngest {
  function ingestHostLine(line: string): void {
    const kind = classifyHostLine(line);
    if (kind === "heartbeat" || kind === "hub_error" || kind === "unknown") return;
    if (kind === "response") {
      ingestResponse(line);
      return;
    }
    if (kind === "event" || kind === "ui_request") {
      ingestEventOrUi(kind, line);
      return;
    }
    ingestLifecycle(kind, line);
  }

  function parseLine<T>(line: string): T | null {
    try {
      return JSON.parse(line) as T;
    } catch {
      return null;
    }
  }

  function ingestResponse(line: string): void {
    const parsed = parseLine<{ id?: unknown; command?: unknown; success?: unknown; data?: unknown; error?: unknown }>(line);
    if (parsed === null) return;
    const hostId = typeof parsed.id === "string" ? parsed.id : null;
    if (hostId === null) return;
    const pending = deps.pendingByHostId.get(hostId);
    deps.pendingByHostId.delete(hostId);
    if (pending === undefined) return;
    const responseBody = { id: pending.commandId, command: pending.command, success: parsed.success === true, data: parsed.data, error: typeof parsed.error === "string" ? parsed.error : undefined };
    void deps.devices.appendResponse(pending.deviceId, pending.commandId, responseBody);
    adoptThreadFromResponse(parsed.data, pending.deviceId);
    void deps.audit.record("command-issued", { deviceId: pending.deviceId, command: pending.command, ok: responseBody.success });
    if (pending.deviceId === "owner") {
      deps.replyOwner(pending, responseBody);
      return;
    }
    deps.sendToDevice(pending.deviceId, { kind: "response", streamId: `cmd:${pending.deviceId}`, seq: 0, body: responseBody });
  }

  function adoptThreadFromResponse(data: unknown, deviceId: string): void {
    if (typeof data !== "object" || data === null) return;
    const record = data as Record<string, unknown>;
    if (typeof record.threadId !== "string") return;
    const target = deps.fanout.targetOf(deviceId);
    target?.subscribedThreads.add(record.threadId);
    if (typeof record.sessionPath === "string") deps.threads.upsert({ threadId: record.threadId, sessionPath: record.sessionPath });
  }

  function ingestEventOrUi(kind: "event" | "ui_request", line: string): void {
    const parsed = parseLine<{ threadId?: unknown; name?: unknown; payload?: unknown; requestId?: unknown; method?: unknown }>(line);
    if (parsed === null) return;
    if (kind === "event") {
      if (typeof parsed.threadId === "string" && typeof parsed.name === "string") {
        deps.fanout.fanoutEvent({ threadId: parsed.threadId, name: parsed.name, payload: parsed.payload });
      }
      return;
    }
    if (typeof parsed.requestId === "string" && typeof parsed.threadId === "string" && typeof parsed.method === "string") {
      deps.fanout.fanoutUiRequest({ requestId: parsed.requestId, threadId: parsed.threadId, method: parsed.method, payload: (parsed.payload as Record<string, unknown>) ?? {} });
    }
  }

  function ingestLifecycle(kind: "thread_died" | "thread_parked", line: string): void {
    const parsed = parseLine<{ threadId?: unknown }>(line);
    if (parsed === null) return;
    if (typeof parsed.threadId === "string") deps.fanout.fanoutEvent({ threadId: parsed.threadId, name: kind, payload: parsed });
  }

  return { ingest: ingestHostLine };
}
