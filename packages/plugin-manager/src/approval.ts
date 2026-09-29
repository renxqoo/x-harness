import type { Result } from "./types.ts";

export type ApprovalGate = (input: { readonly path: string }) => Promise<Result<undefined, string>>;

export function createApprovalGate(
  approve?: (input: { readonly path: string }) => boolean | Promise<boolean>,
): ApprovalGate {
  return async (input) => {
    const policy = approve ?? (() => false);
    const allowed = await policy(input);
    if (allowed) return { ok: true, value: undefined };
    return { ok: false, reason: `install rejected by approval gate: ${input.path}` };
  };
}
