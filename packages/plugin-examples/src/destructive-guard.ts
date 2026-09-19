// ① 自定义权限：危险 bash/write 模式否决（vetoTools——工具域权限面）。
// 真实场景：终端用户"别删我文件"护栏。

import type { Disposer, Plugin } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { vetoTools } from "@x-harness/plugin-api";

const DESTRUCTIVE_BASH = /\b(rm\s+-[rf]|git\s+push\s+--force|mkfs|dd\s+if=|:\(\)\{)/;
const DESTRUCTIVE_WRITE = /(\.env|id_rsa|\.ssh\/|\.git\/config)$/;

export interface GuardOptions {
  /** 额外否决规则（宿主注入——内容归上层） */
  readonly extraDeny?: (name: string, args: unknown) => string | undefined;
}

export function destructiveGuardPlugin(options: GuardOptions = {}): Plugin {
  return {
    name: "destructive-guard",
    apply: (ctx: Context): Disposer =>
      vetoTools(ctx, (call) => {
        if (call.name === "bash" && DESTRUCTIVE_BASH.test(String((call.args as { command?: unknown }).command ?? ""))) {
          return { kind: "deny", reason: "destructive command pattern blocked (destructive-guard)" };
        }
        if (call.name === "write" && DESTRUCTIVE_WRITE.test(String((call.args as { path?: unknown }).path ?? ""))) {
          return { kind: "deny", reason: "protected path blocked (destructive-guard)" };
        }
        const extra = options.extraDeny?.(call.name, call.args);
        return extra !== undefined ? { kind: "deny", reason: extra } : undefined;
      }),
  };
}
