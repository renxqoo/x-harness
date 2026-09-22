// 进程级网络白名单计算（docs/SANDBOX.md §3）：srt 单代理无连接归属——白名单取并集，
// 每次 spawn 前重算、有变才热切换（updateConfig 每请求生效：授权对在跑子进程的下一次连接即时放行）。

export interface AllowlistInput {
  /** 宿主预授权域名（SandboxOptions.allowedDomains） */
  readonly baseDomains: readonly string[];
  /** 宿主级 kill switch——压过一切 */
  readonly networkOff: boolean;
  /** 进程内总括授权态（full 档）——全局全通（worktree 会话网络隔离随单代理失去，落档已知边界） */
  readonly unrestrictedActive: boolean;
  /** 各活会话的授权域名（grants.allowedDomainsOf 逐会话快照） */
  readonly sessionDomains: readonly (readonly string[])[];
}

export function globalAllowlist(input: AllowlistInput): readonly string[] {
  if (input.networkOff) return [];
  if (input.unrestrictedActive) return ["*"];
  return [...new Set([...input.baseDomains, ...input.sessionDomains.flat()])];
}

/** 集合等价（序不敏感、重复无义）——同集不触热切换 */
export function sameDomainSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const d of sa) {
    if (!sb.has(d)) return false;
  }
  return true;
}
