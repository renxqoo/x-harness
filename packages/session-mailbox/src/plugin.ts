import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposer, Plugin } from "@x-harness/core";
import { createMailboxService } from "./service.ts";
import { mailboxService } from "./tokens.ts";
import type { MailboxTiming } from "./types.ts";

export function defaultTiming(): MailboxTiming {
  return { pollIntervalMs: 300, heartbeatMs: 10_000, graceMs: 30_000, staleMs: 7 * 24 * 3_600_000, now: () => Date.now() };
}

export function resolveMailboxDir(custom?: string): string {
  if (custom !== undefined && custom !== "") return custom;
  const env = process.env["X_HARNESS_MAILBOX_DIR"];
  if (env !== undefined && env !== "") return env;
  const home = process.env["X_HARNESS_HOME"];
  if (home !== undefined && home !== "") return join(home, "mailbox");
  return join(homedir(), ".x-harness", "mailbox");
}

export interface MailboxPluginOptions {
  readonly root: string;
  readonly timing?: MailboxTiming;
  readonly onWarn?: (message: string) => void;
}

export function createMailboxPlugin(options: MailboxPluginOptions): Plugin {
  return {
    name: "session-mailbox",
    apply: (ctx): Disposer => ctx.provide(mailboxService, createMailboxService({
      root: options.root,
      timing: options.timing ?? defaultTiming(),
      onWarn: options.onWarn,
    })),
  };
}
