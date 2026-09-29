import type { PermissionRule } from "./types.ts";

export interface BaselinePolicy {
  readonly denyRead?: readonly string[];
  readonly denyReadOutside?: readonly string[];
  readonly denyWrite?: readonly string[];
}

export const DEFAULT_BASELINE: Readonly<Required<BaselinePolicy>> = {
  denyRead: ["~/.ssh/**", "~/.aws/**", "~/.gcp/**"],
  denyReadOutside: ["/**/.env", "/**/.env.*", "/**/.envrc"],
  denyWrite: ["/**/.git/**"],
};

export const DEFAULT_DENY_READ: readonly string[] = DEFAULT_BASELINE.denyRead;
export const DEFAULT_DENY_READ_OUTSIDE: readonly string[] = DEFAULT_BASELINE.denyReadOutside;
export const DEFAULT_DENY_WRITE: readonly string[] = DEFAULT_BASELINE.denyWrite;

export const DEFAULT_DENY_READ_DIRS: readonly string[] = ["~/.ssh", "~/.aws", "~/.gcp"];

export function baselineOf(host?: BaselinePolicy): Readonly<Required<BaselinePolicy>> {
  if (host === undefined) return DEFAULT_BASELINE;
  return {
    denyRead: host.denyRead ?? DEFAULT_BASELINE.denyRead,
    denyReadOutside: host.denyReadOutside ?? DEFAULT_BASELINE.denyReadOutside,
    denyWrite: host.denyWrite ?? DEFAULT_BASELINE.denyWrite,
  };
}

export const MEMORY_BLOCKED_HEADS: readonly string[] = [...new Set([
  "sudo", "doas", "su", "pkexec", "sudoedit", "gsudo",
  "rm", "mkfs", "dd", "chmod", "chown",
  "sh", "bash", "zsh", "dash", "ksh", "ash", "node", "bun", "deno", "python", "python3", "perl", "ruby", "php", "osascript",
  "env", "nohup", "time", "exec", "eval", "source", ".", "xargs", "awk", "sed", "trap",
])];

export function baselineDenyRules(unrestricted = false, baseline?: BaselinePolicy): readonly PermissionRule[] {
  const policy = baselineOf(baseline);
  const denyRead: PermissionRule[] = [
    ...policy.denyRead.map((pattern) => ({ tool: "Read" as const, pattern, verdict: "deny" as const, origin: "default" as const })),
    ...policy.denyReadOutside.map((pattern) => ({ tool: "Read" as const, pattern, verdict: "deny" as const, origin: "default" as const, outsideRoots: true as const })),
  ];
  if (unrestricted) return denyRead;
  return [...denyRead, ...policy.denyWrite.map((pattern) => ({ tool: "Write" as const, pattern, verdict: "deny" as const, origin: "default" as const }))];
}

export function memoryBlocked(pattern: string): boolean {
  const head = pattern.replace(/:\*$/, "").trim().split(/\s+/).filter((word) => word !== "")[0];
  if (head === undefined) return true;
  if (head === "*" || head === "") return true;
  const base = head.split("/").filter(Boolean).pop() ?? head;
  const folded = process.platform === "darwin" ? base.toLowerCase() : base;
  if (MEMORY_BLOCKED_HEADS.includes(folded)) return true;
  return /^python\d/.test(folded);
}
