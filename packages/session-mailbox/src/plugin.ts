// 邮箱插件：root/timing 解析（缺省值唯一居所）+ 服务 provide。

import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposer, Plugin } from "@x-harness/core";
import { createMailboxService } from "./service.ts";
import { mailboxService } from "./tokens.ts";
import type { MailboxTiming } from "./types.ts";

/** 缺省时序（方案 §2.2）：轮询 300ms / 心跳 10s / 宽限 30s / 陈尸 7d */
export function defaultTiming(): MailboxTiming {
  return { pollIntervalMs: 300, heartbeatMs: 10_000, graceMs: 30_000, staleMs: 7 * 24 * 3_600_000, now: () => Date.now() };
}

function resolveRoot(custom?: string): string {
  if (custom !== undefined && custom !== "") return custom;
  const env = process.env["X_HARNESS_MAILBOX_DIR"];
  if (env !== undefined && env !== "") return env;
  return join(homedir(), ".x-harness", "mailbox");
}

export interface MailboxPluginOptions {
  readonly root?: string;
  readonly timing?: MailboxTiming;
  readonly onWarn?: (message: string) => void;
}

export function createMailboxPlugin(options: MailboxPluginOptions = {}): Plugin {
  return {
    name: "session-mailbox",
    apply: (ctx): Disposer => ctx.provide(mailboxService, createMailboxService({
      root: resolveRoot(options.root),
      timing: options.timing ?? defaultTiming(),
      onWarn: options.onWarn,
    })),
  };
}
