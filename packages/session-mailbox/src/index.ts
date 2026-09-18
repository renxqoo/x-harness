export { createMailboxPlugin, defaultTiming } from "./plugin.ts";
export type { MailboxPluginOptions } from "./plugin.ts";
export { createMailboxService, validateTiming } from "./service.ts";
export { mailboxService } from "./tokens.ts";
export type {
  BoxHandle,
  BoxManifest,
  Envelope,
  EnvelopeKind,
  LiveBox,
  MailboxOptions,
  MailboxService,
  MailboxTiming,
  SendResult,
} from "./types.ts";
