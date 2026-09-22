// Fence 合成（docs/SANDBOX.md §3）：宿主 base 配置 ∧ permission grants 数据面——纯函数、session 键控。
// sandbox 只消费事实（extraRoots/域名授权/unrestricted/rootOverride），不做任何裁决或交互。
// denyRead 取 ~/ 与绝对路径形态交 srt 自行展开；任意深 glob（**/.env 类）内核面不可靠，防护归工具面。
// writable/denyWrite 需进 srt allowWrite/denyWrite——~/ 形态在此展开为绝对路径（词法 resolve 对
// ~/ 产生 cwd 相对垃圾路径）。

import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { GrantsRegistry } from "@x-harness/permission";

export interface Fence {
  /** spawn 面可写集（→ srt allowWrite）：root|override.dir + tmpdir + 宿主附加 + 会话授权根 */
  readonly writable: readonly string[];
  /** 内核拒读表（→ srt denyRead）：默认底线 + 宿主附加；full 档不豁免 */
  readonly denyRead: readonly string[];
  /** 受保护路径（→ srt denyWrite）：工作区 .git + 宿主附加；full 档不豁免 */
  readonly denyWrite: readonly string[];
  /** 会话网络白名单（fenceFacts/全局并集原料）；networkOff 恒空、unrestricted 恒 ['*'] */
  readonly allowedDomains: readonly string[];
}

export interface FenceBase {
  readonly root: string;
  readonly writableExtra?: readonly string[];
  readonly denyReadExtra?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly allowedDomains?: readonly string[];
  /** true=网络全断（白名单恒空、压过 unrestricted——宿主级 kill switch） */
  readonly networkOff?: boolean;
}

/** 内核面默认拒读底线（用户裁决②）：full 档不豁免——只可经 denyReadExtra 增不可减 */
export const DEFAULT_DENY_READ: readonly string[] = ["~/.ssh", "~/.aws", "~/.gcp"];

/** srt 强制的子进程 TMPDIR（引擎内置便利写路径——入 writable 使事实与内核真值一致） */
export const CHILD_TMPDIR: string = process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";

function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function withinLexical(root: string, p: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return p === root || p.startsWith(prefix);
}

/** 单一解析函数：决策（fenceFacts）与 spawn 围栏共用同一合成结果（授权即时生效是设计意图）。
 *  unrestricted（进程级总括，full 档）：writable 前置 "/"、域名全通 '*'——rootOverride 会话
 *  isUnrestricted 恒 false，隔离压过总括（防打穿件13）。override 会话的 extraRoots 滤除
 *  guard 子树内批准（worktree 防逃逸）。 */
export function fenceFor(base: FenceBase, grants: GrantsRegistry, session: SessionId | undefined): Fence {
  const override = grants.rootOverrideOf(session);
  const unrestricted = grants.isUnrestricted(session);
  const extraRoots = override === undefined
    ? grants.extraRootsOf(session)
    : grants.extraRootsOf(session).filter((r) => !withinLexical(resolve(override.guard), resolve(r)));
  const writable = [
    ...(unrestricted ? ["/"] : []),
    override?.dir ?? base.root,
    tmpdir(),
    CHILD_TMPDIR,
    ...(base.writableExtra ?? []),
    ...extraRoots,
  ].map(expand);
  const denyRead = [...DEFAULT_DENY_READ, ...(base.denyReadExtra ?? [])];
  const denyWrite = [expand(`${override?.dir ?? base.root}/.git`), ...(base.protectedPaths ?? []).map(expand)];
  if (base.networkOff === true) return { writable, denyRead, denyWrite, allowedDomains: [] };
  if (unrestricted) return { writable, denyRead, denyWrite, allowedDomains: ["*"] };
  const allowedDomains = [...new Set([...(base.allowedDomains ?? []), ...grants.allowedDomainsOf(session)])];
  return { writable, denyRead, denyWrite, allowedDomains };
}
