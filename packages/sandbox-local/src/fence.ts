// Fence（围栏事实，docs/EXEC-ENV.md §4）：一份清单两层执法——writable/denyRead 同源喂 gate/permission
// 与内核剖面；网络=域名表白名单（用户裁决①）经会话代理。fenceFor 单一解析函数：决策（permission
// fenceFacts）与 spawn 围栏共用同一合成结果（§6——授权即时生效是设计意图，执法不弱化）。

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { SessionId } from "@x-harness/session";
import type { GrantsRegistry } from "@x-harness/permission";

export type NetworkPolicy = "off" | { readonly allowedDomains: readonly string[] };

export interface Fence {
  readonly writable: readonly string[];
  readonly denyRead: readonly string[];
  /** 受保护路径（spawn 面 deny-write / tmpfs 遮挂）——具体路径形态；glob 级（点 git 全嵌套）防护在工具面 */
  readonly protectedPaths: readonly string[];
  readonly network: NetworkPolicy;
}

export interface FenceBase {
  readonly root: string;
  readonly writableExtra?: readonly string[];
  readonly denyReadExtra?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly allowedDomains?: readonly string[];
  /** off=全断（无代理）；缺省 allowlist（域名白名单+会话授权） */
  readonly networkOff?: boolean;
}

/** 词法解析即可——物理双形展开在消费方（seatbelt subpath 词法匹配实测；bwrap bind 词法路径成立） */
function normalize(p: string): string {
  return resolve(p);
}

export const DEFAULT_DENY_READ: readonly string[] = ["~/.ssh", "~/.aws", "~/.gcp"];

/** 单一解析函数：base ∧ 会话授权（域名并集即时生效）。 */
export function fenceFor(base: FenceBase, grants: GrantsRegistry, session: SessionId | undefined): Fence {
  const writable = [base.root, tmpdir(), ...(base.writableExtra ?? [])].map(normalize);
  const denyRead = [...DEFAULT_DENY_READ, ...(base.denyReadExtra ?? [])];
  const protectedPaths = (base.protectedPaths ?? []).map(normalize);
  if (base.networkOff === true) return { writable, denyRead, protectedPaths, network: "off" };
  // 宿主预授权（会话无关）+ 会话授权域名并集；deny 不入白名单
  const granted = [...(base.allowedDomains ?? []), ...grants.allowedDomainsOf(session)];
  return { writable, denyRead, protectedPaths, network: { allowedDomains: granted } };
}

/** denyRead 展开为绝对路径（SBPL subpath / bwrap tmpfs 遮挂目标） */
export function denyReadPaths(fence: Fence, home: string): readonly string[] {
  return fence.denyRead.map((pattern) => expandHome(pattern, home));
}

function expandHome(pattern: string, home: string): string {
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return resolve(home, pattern.slice(2));
  return resolve(pattern);
}
