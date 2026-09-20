// @x-harness/permission：完整规则词汇表 + auto 决策 + broker + 会话授权（docs/EXEC-ENV.md §5）。

export type { AskRequest, FenceFacts, ModeKnob, PermissionAudit, PermissionRule, RuleOrigin, RuleTool, Verdict } from "./types.ts";
export { DEFAULT_DENY_READ, DEFAULT_DENY_WRITE, MODE_KNOBS } from "./types.ts";
export { permissionBroker, permissionDecided, permissionGrants, permissionMode, fenceFacts } from "./tokens.ts";
export type { PermissionModeService } from "./tokens.ts";
export { parseRule, parseRules } from "./rules/parse.ts";
export { globMatch } from "./rules/glob.ts";
export { bashPrefixMatch } from "./rules/bash-prefix.ts";
export { parseBash, parseBashWith, classifyKind } from "./bash/ast.ts";
export type { BashParse, ParsedCommand, Redirect, ParserLoader, NodeClass } from "./bash/ast.ts";
export type { InjectionKind } from "./bash/injection.ts";
export { hardDeny } from "./bash/hard-deny.ts";
export type { HardDenyKind } from "./bash/hard-deny.ts";
export { adjudicateBash, writableRoots, withinAny } from "./bash/adjudicate.ts";
export type { BashAdjudication, BashPipelineInput } from "./bash/adjudicate.ts";
export { decideFor } from "./decide.ts";
export type { Decision, DecideInput } from "./decide.ts";
export { GrantsRegistry } from "./grants.ts";
export { createPermissionPlugin } from "./plugin.ts";
export type { PermissionOptions } from "./plugin.ts";
