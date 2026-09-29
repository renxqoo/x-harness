import { defineService } from "@x-harness/core";
import type { MailboxService } from "./types.ts";

export const mailboxService = defineService<MailboxService>("session-mailbox");
