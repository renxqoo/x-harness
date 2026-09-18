// permission 契约类型（docs/EXEC-ENV.md §5）：完整规则词汇表——verdict/origin/模式档/围栏事实/
// 默认拒读表（用户裁决②：在场可加不可减——deny 压过 allow 由裁决序免费保证）。

import type { SessionId } from "@x-harness/session";

export type Verdict = "allow" | "deny" | "ask";
export type RuleTool = "Bash" | "Read" | "Write" | "Grep";
export type RuleOrigin = "user" | "session";

/** Bash 模式=词元前缀（`git push:*` 前缀 / 裸 `git status` 精确 / `*` 万配）；路径工具=glob */
export interface PermissionRule {
  readonly tool: RuleTool;
  readonly pattern: string;
  readonly verdict: Verdict;
  readonly origin: RuleOrigin;
}

export type ModeKnob = "plan" | "auto" | "full";

/** 围栏事实快照（sandbox 提供，permission 定义 token 消费；缺席=无围栏装配） */
export interface FenceFacts {
  readonly writable: readonly string[];
  readonly allowedDomains: readonly string[];
}

/** bash 段工具面默认拒读表（用户裁决②）——工具面为 user-origin deny 规则注入；spawn 面由 sandbox 同表执法 */
export const DEFAULT_DENY_READ: readonly string[] = ["~/.ssh/**", "~/.aws/**", "~/.gcp/**", "**/.env"];

/** 受保护路径默认写拒（.git 内部）；宿主经 protectedPaths 追加 */
export const DEFAULT_DENY_WRITE: readonly string[] = ["**/.git/**"];

export interface AskRequest {
  readonly tool: string;
  readonly reason: string;
  readonly session?: SessionId;
}

export interface PermissionAudit {
  readonly tool: string;
  readonly verdict: Verdict;
  readonly resolvedBy: string;
  readonly reason: string;
  readonly session?: SessionId;
}
