import { judgeGwCommand, type Frame } from "@x-harness/remote-protocol";
import type { OwnerSession } from "./owner-server.ts";

export interface OwnerDispatchDeps {
  hostWrite(line: string): boolean;
  auditRecord(event: string, detail: Record<string, unknown>): Promise<void>;
  handleGwCommand(command: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }>;
  nextOwnerSeq(): number;
  submitOwnerCommand(spec: { session: OwnerSession; commandId: string; command: string; args: Record<string, unknown> }): Promise<void>;
}

export function makeOwnerDispatcher(deps: OwnerDispatchDeps): (session: OwnerSession, frame: Frame) => Promise<void> {
  async function handleOwnerFrame(session: OwnerSession, frame: Frame): Promise<void> {
    if (frame.kind !== "command") {
      if (frame.kind === "ui_response") {
        const body = frame.body as { requestId?: string; payload?: Record<string, unknown> };
        if (typeof body.requestId === "string") {
          deps.hostWrite(JSON.stringify({ type: "ui_response", requestId: body.requestId, payload: body.payload ?? {} }));
          await deps.auditRecord("ui_request-settled", { requestId: body.requestId, deviceId: "owner", decision: JSON.stringify(body.payload ?? {}) });
        }
      }
      return;
    }
    const body = frame.body as { command?: string; id?: string; args?: Record<string, unknown> };
    const command = body.command;
    const id = body.id;
    if (typeof command !== "string" || typeof id !== "string") {
      session.send({ kind: "response", streamId: "owner", seq: deps.nextOwnerSeq(), body: { id: "?", command: "?", success: false, error: "invalid command frame" } });
      return;
    }
    if (judgeGwCommand(command, "owner") !== "unknown-command") {
      const result = await deps.handleGwCommand(command, body.args ?? {});
      session.send({ kind: "response", streamId: "owner", seq: deps.nextOwnerSeq(), body: { id, command, success: result.ok, ...(result.ok ? { data: result.data } : { error: result.reason }) } });
      return;
    }
    if (judgeGwCommand(command, "owner") === "unknown-command" && command.startsWith("gw/")) {
      await deps.auditRecord("owner-only-denied", { deviceId: "owner", command });
      session.send({ kind: "response", streamId: "owner", seq: deps.nextOwnerSeq(), body: { id, command, success: false, error: "unknown gw command" } });
      return;
    }
    await deps.submitOwnerCommand({ session, commandId: id, command, args: body.args ?? {} });
  }


  return handleOwnerFrame;
}
