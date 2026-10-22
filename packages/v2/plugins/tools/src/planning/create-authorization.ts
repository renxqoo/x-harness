import { signalAborted, createFault } from "../../../../core/src/validation";
import type { GuardDecision, Result } from "../../../../core/src/index";
import type { ToolAuthorization, ToolExecutionPlan, ToolGrant, ToolPermission } from "./types";
import { data, keys } from "../domain/read-values";
import { authorizationRequests as requests } from "./shared";
interface Cell {
  current?: Extract<ToolPermission, { kind: "allow" }>[];
  count: number;
  invalid: boolean;
}

const deny = (): Result<GuardDecision> => ({
  ok: true,
  value: { kind: "deny", reason: "access-denied" },
});

export function createAuthorization(plan: ToolExecutionPlan) {
  const permissions: Extract<ToolPermission, { kind: "allow" }>[] = [],
    cell: Cell = { current: permissions, count: 0, invalid: false };
  const request: ToolAuthorization = Object.freeze({ plan, allow: grant(cell) });
  requests.add(request);
  return {
    request,
    permissions,
    close() {
      cell.current = undefined;
      requests.delete(request);

      if (cell.invalid) permissions.length = 0;
    },
  };
}

function grant(cell: Cell) {
  return (raw: ToolGrant): Result<GuardDecision> => {
    const permissions = cell.current;

    if (!permissions || cell.invalid) return deny();

    const d = data(raw);

    try {
      if (
        !d ||
        !keys(d, ["signal", "revocation", "isValid"]) ||
        (d.isValid !== undefined && typeof d.isValid !== "function") ||
        cell.count >= 128
      )
        throw new Error("Invalid grant");

      Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(d.signal);

      if (d.revocation !== undefined)
        Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(d.revocation);

      if (
        signalAborted(d.signal as AbortSignal) ||
        (d.revocation !== undefined && signalAborted(d.revocation as AbortSignal))
      )
        throw new Error("Revoked grant");

      permissions.push({
        kind: "allow",
        signal: d.signal as AbortSignal,
        ...(d.isValid ? { isValid: d.isValid as () => boolean } : {}),
      });

      if (d.revocation) permissions.push({ kind: "allow", signal: d.revocation as AbortSignal });

      cell.count++;
      return { ok: true, value: { kind: "allow" } };
    } catch {
      cell.invalid = true;
      permissions.length = 0;
      return deny();
    }
  };
}

export function readAuthorization(raw: unknown) {
  return !!raw && typeof raw === "object" && requests.has(raw)
    ? { ok: true as const, value: raw as ToolAuthorization }
    : createFault("invalid-input");
}
