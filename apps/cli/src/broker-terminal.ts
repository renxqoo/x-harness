// 终端审批 broker（docs/CLI.md §2.3）：permission broker 服务的 CLI 实现——工具审批与
// 沙箱域名审批同界面。IO 全注入（TTY 判定/写行/提问），行式交互无光标管理；
// stdin 非 TTY（print 管道场景）不读输入：显式警告行 + deny（可观测，不静默）。

import type { Plugin } from "@x-harness/core";
import { permissionBroker } from "@x-harness/permission";
import type { AskRequest } from "@x-harness/permission";

export interface BrokerIO {
  /** stdin 是否可交互（TTY）；false = print 管道形态 */
  readonly interactive: boolean;
  /** 警告/审批提示行（REPL 走 stdout、print 模式走 stderr——由装配方决定） */
  readonly write: (line: string) => void;
  /** readline 提问；resolve undefined = EOF/接口被关闭（Ctrl+C 强制关闭路径）→ deny */
  readonly question: (prompt: string) => Promise<string | undefined>;
}

/** 裁决纯函数：y/yes（大小写不敏感）= allow，其余一切（含缺席/EOF）= deny */
export function decideApproval(answer: string | undefined): "allow" | "deny" {
  const trimmed = answer?.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes" ? "allow" : "deny";
}

async function askWith(io: BrokerIO, input: AskRequest): Promise<"allow" | "deny"> {
  if (!io.interactive) {
    io.write(`permission denied (non-interactive stdin): ${input.tool} — ${input.reason}`);
    return "deny";
  }
  io.write(`allow ${input.tool}? — ${input.reason}`);
  return decideApproval(await io.question("[y/N] "));
}

export function createTerminalBrokerPlugin(io: BrokerIO): Plugin {
  return {
    name: "cli-permission-broker",
    apply: (ctx) => ctx.provide(permissionBroker, { ask: (input) => askWith(io, input) }),
  };
}
