// 安全底线拒止表（2026-09-28 C① 裁决）：底线词表是安全不变量（红线 1 的数据面）——
// 内核持有、恒注入、origin "default" 真归因，不随可选模式插件缺席而消失（V4 净化 #2
// 的「基线随 permission-modes 可选化」就此修正：风险偏好词表在模式层，安全底线在内核）。
// .env 变体扩形（红队 F3）：dotenv 系生态普遍加载 .env.local/.env.production，direnv
// 执行 .envrc——按名拒读覆盖现实形态。围栏侧目录表同源导出（sandbox fence 消费——两表一源）。

import type { PermissionRule } from "./types.ts";

/** 拒读底线（路径面 glob + bash 面 argv/重定向同表消费） */
export const DEFAULT_DENY_READ: readonly string[] = ["~/.ssh/**", "~/.aws/**", "~/.gcp/**", "**/.env", "**/.env.*", "**/.envrc"];

/** 拒写底线（.git 元数据——路径面硬拒；bash 面重定向输出/argv 同表） */
export const DEFAULT_DENY_WRITE: readonly string[] = ["**/.git/**"];

/** 围栏侧同源目录表（sandbox fence denyRead 消费——无 glob 的目录形态子集，两表一源） */
export const DEFAULT_DENY_READ_DIRS: readonly string[] = ["~/.ssh", "~/.aws", "~/.gcp"];

/** 习得闸：这些命令头不习得记忆（红队/上层 P1-4 单源裁决——内核导出，host 命令面同闸消费；
 *  一次「always allow」不得终身放行硬拒族/wrapper·解释器前缀；万配由形态面另拒） */
export const MEMORY_BLOCKED_HEADS: readonly string[] = [
  "sudo", "doas", "su", "rm", "mkfs", "dd", "chmod", "chown", "bash", "sh", "zsh", "dash", "ksh",
  "env", "node", "python", "python3", "perl", "ruby", "php", "osascript", "eval", "xargs", "awk", "sed",
];

/** 底线规则全集（decideFor 内部恒合并——纯直调方与插件执行面同真相） */
export function baselineDenyRules(): readonly PermissionRule[] {
  return [
    ...DEFAULT_DENY_READ.map((pattern) => ({ tool: "Read" as const, pattern, verdict: "deny" as const, origin: "default" as const })),
    ...DEFAULT_DENY_WRITE.map((pattern) => ({ tool: "Write" as const, pattern, verdict: "deny" as const, origin: "default" as const })),
  ];
}

/** 习得闸判定：规则头（首词，滤空白——前导空格形 `Danger( chmod:*)` 同拦，与 bash-prefix
 *  词元化同口径，红队 R9）在禁习表内或空头（畸形串）→ 不落记忆 */
export function memoryBlocked(pattern: string): boolean {
  const head = pattern.replace(/:\*$/, "").trim().split(/\s+/).filter((word) => word !== "")[0];
  return head === undefined || MEMORY_BLOCKED_HEADS.includes(head);
}
