import { definePlugin } from "../../../core/src/index";
import type { TokenMap, Plugin } from "../../../core/src/index";
import { readData, normalizeResult } from "../../../core/src/validation";
import { toolExecutionAccess } from "./contracts";
import type { ToolPolicyOptions, ToolPermission } from "./planning/types";
import { data, keys, name } from "./domain/read-values";
import { fail } from "./domain/fail";
import { encodePluginName } from "./domain/encode-plugin-name";
import type { ToolsResult } from "./contracts/types";

export function createToolPolicyPlugin<
  D extends TokenMap = Record<never, never>,
  O extends TokenMap = Record<never, never>,
>(raw: ToolPolicyOptions<D, O>): ToolsResult<Plugin> {
  const d = data(raw);

  if (
    !d ||
    !keys(d, ["name", "requires", "optional", "authorize"]) ||
    !name(d.name) ||
    typeof d.authorize !== "function"
  )
    return fail("invalid-input");

  const requires = data(d.requires ?? {}),
    optional = data(d.optional ?? {});

  if (
    !requires ||
    !optional ||
    "toolExecutionAccess" in requires ||
    "toolExecutionAccess" in optional
  )
    return fail("invalid-input");

  const authorize = d.authorize as typeof raw.authorize;
  return {
    ok: true,
    value: definePlugin({
      name: encodePluginName("tool-policy", d.name),
      requires: { ...(requires as Record<never, never>), toolExecutionAccess },
      optional: optional as Record<never, never>,
      setup: (ctx) =>
        ctx.guard("toolExecutionAccess", async (authorization, call) => {
          const deny = {
            ok: true as const,
            value: { kind: "deny" as const, reason: "access-denied" },
          };
          let result: unknown;

          try {
            result = await authorize(authorization.plan, call as never);
          } catch {
            return deny;
          }

          const parsed = normalizeResult(result);

          if (!parsed.ok) return deny;

          const permission = readData(parsed.value);

          if (
            !permission.ok ||
            Object.keys(permission.value).some((k) => !["kind", "signal", "isValid"].includes(k))
          )
            return deny;

          const p = permission.value as unknown as ToolPermission;

          if (p.kind !== "allow") return deny;

          if (p.isValid !== undefined && typeof p.isValid !== "function") return deny;

          if (p.signal !== undefined) {
            try {
              Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(
                p.signal,
              );
            } catch {
              return deny;
            }
          }

          return authorization.allow({
            signal: ctx.signal,
            ...(p.signal ? { revocation: p.signal } : {}),
            ...(p.isValid ? { isValid: p.isValid } : {}),
          });
        }),
    }),
  };
}
