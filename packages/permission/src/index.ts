// @x-harness/permission：档位 profile 表 + 规则词汇表 + auto 决策 + 结构化 broker +
// 会话授权/习得记忆（docs/PERMISSION-V2-DESIGN.md）。

export type {
  AskPayload,
  AskReply,
  ExecDirective,
  FenceFacts,
  PermissionAudit,
  PermissionProfile,
  PermissionRule,
  ProfileId,
  RuleEntry,
  RuleNature,
  RuleOrigin,
  RuleTool,
  Verdict,
} from "./types.ts";
export { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE, PROFILE_IDS } from "./types.ts";
export { BUILTIN_PROFILES, mergeCustomProfiles, profileRowValid, resolveProfile } from "./profiles.ts";
export {
  permissionBroker,
  permissionDecided,
  permissionGrantStore,
  permissionGrantWritten,
  permissionGrants,
  permissionMode,
  fenceFacts,
} from "./tokens.ts";
export type { PermissionModeService, FenceFactsResolver } from "./tokens.ts";
export { parseRule, parseRules } from "./rules/parse.ts";
export { globMatch } from "./rules/glob.ts";
export { bashPrefixMatch } from "./rules/bash-prefix.ts";
export { classifyPipeline } from "./classifier.ts";
export type { CommandClass } from "./classifier.ts";
export { argvSensitiveHit } from "./sensitive.ts";
export { suggestRule, exactRule } from "./suggest.ts";
export { parseBash, parseBashWith, classifyKind } from "./bash/ast.ts";
export type { BashParse, ParsedCommand, Redirect, ParserLoader, NodeClass } from "./bash/ast.ts";
export type { InjectionKind } from "./bash/injection.ts";
export { hardDeny } from "./bash/hard-deny.ts";
export type { HardDenyKind } from "./bash/hard-deny.ts";
export { adjudicateBash, suggestedRuleOf, writableRoots, withinAny } from "./bash/adjudicate.ts";
export type { BashAdjudication, BashPipelineInput } from "./bash/adjudicate.ts";
export { decideFor } from "./decide.ts";
export type { Decision, DecideInput } from "./decide.ts";
export { GrantsRegistry } from "./grants.ts";
export { createPermissionPlugin } from "./plugin.ts";
export type { PermissionOptions } from "./plugin.ts";
