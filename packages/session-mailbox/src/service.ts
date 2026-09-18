// MailboxService 组装与配置校验（缺省值不在此层——装配层给，方案 §11 单一真相）。

import type { MailboxOptions, MailboxService, MailboxTiming } from "./types.ts";
import type { BoxDeps } from "./box.ts";
import type { SendDeps } from "./send.ts";
import { openBox } from "./box.ts";
import { drainInbox, sendEnvelope } from "./send.ts";
import { discoverBoxes, reclaimBox } from "./discover.ts";
import { addSub, listSubs, removeSub } from "./subs.ts";

/** 配置垃圾值 fail-fast（正安全整数 + now 可调用） */
export function validateTiming(timing: MailboxTiming): void {
  const positive = (value: number) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (!positive(timing.pollIntervalMs) || !positive(timing.heartbeatMs) || !positive(timing.graceMs) || !positive(timing.staleMs)) {
    throw new Error("session-mailbox: pollIntervalMs/heartbeatMs/graceMs/staleMs must be positive safe integers");
  }
  if (typeof timing.now !== "function") {
    throw new Error("session-mailbox: timing.now must be a function");
  }
}

export function createMailboxService(options: MailboxOptions): MailboxService {
  validateTiming(options.timing);
  const deps: BoxDeps & SendDeps = { root: options.root, timing: options.timing, onWarn: options.onWarn };
  return {
    root: options.root,
    timing: options.timing,
    open: (name) => openBox(deps, name),
    send: (to, body) => sendEnvelope(deps, to, body),
    drain: (name) => drainInbox(deps, name),
    discover: () => discoverBoxes(deps),
    reclaim: (name, hooks) => reclaimBox(deps, name, hooks),
    subs: {
      add: (targetBox, fromBox) => addSub(deps, targetBox, fromBox),
      list: (box) => listSubs(deps, box),
      remove: (box, fromBox) => removeSub(deps, box, fromBox),
    },
  };
}
