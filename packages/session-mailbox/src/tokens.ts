// 邮箱件 token（docs/AGENT-DELEGATION.md §3）。

import { defineService } from "@x-harness/core";
import type { MailboxService } from "./types.ts";

export const mailboxService = defineService<MailboxService>("session-mailbox");
