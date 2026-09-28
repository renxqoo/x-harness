// 安全底线（2026-09-28 C① 裁决 + 2026-09-29 宿主配置面裁决）：底线是内核持有的安全不变量
// （红线 1 的数据面）——恒注入、origin "default" 真归因，不随可选模式插件缺席而消失（V4
// 净化 #2 的「基线随 permission-modes 可选化」就此修正：风险偏好词表在模式层，安全底线在
// 内核）。真有合法越底线需求（备份凭据目录、受管 .git 写）时宿主经 PermissionOptions.baseline
// 装配期覆写/追加——内核供机制与缺省值，策略数值宿主定（配置入口在宿主装配面，模式插件不可及）。
// .env 族边界（2026-09-28 用户裁决）：项目本地 .env 是常规配置可读写——拒止面只在工作区
// 根集（root+extraRoots）之外；~/.ssh 等凭据目录任意位置恒拒。围栏侧目录表同源导出
// （sandbox fence 消费——两表一源；fence 目录表本就无 .env 项）。

import type { PermissionRule } from "./types.ts";

/** 底线配置面（宿主装配期传入；缺省 = 内核内置表。追加与覆写同形——传全集即覆写） */
export interface BaselinePolicy {
  /** 恒拒读底线（缺省 ~/.ssh/~/.aws/~/.gcp——任意位置拒止） */
  readonly denyRead?: readonly string[];
  /** 项目外拒读底线（缺省 .env 族——仅工作区根集之外拒止；根集内是常规项目配置可读写）。
   *  绝对全局形（斜杠双星前缀）：glob 的相对 pattern 以 root 解析（只射工作区内），拦外部
   *  必须用绝对形；根集内豁免由消费面 allowRoots 条件判提供 */
  readonly denyReadOutside?: readonly string[];
  /** 拒写底线（缺省 .git 元数据表——路径面硬拒；bash 面重定向输出/argv 同表） */
  readonly denyWrite?: readonly string[];
}

/** 内置缺省（BaselinePolicy 缺省值的单源——baselineOf 与外部展示消费） */
export const DEFAULT_BASELINE: Readonly<Required<BaselinePolicy>> = {
  denyRead: ["~/.ssh/**", "~/.aws/**", "~/.gcp/**"],
  denyReadOutside: ["/**/.env", "/**/.env.*", "/**/.envrc"],
  /** 拒写底线（缺省 .git 元数据表——路径面硬拒；bash 面重定向输出/argv 同表）。绝对全局形
   *  （2026-09-29 红队 P0-3）：相对形被 root 前缀化后只射工作区内——extraRoot/家目录
   *  的 .git 拒写曾失效（/other/.git/config 放行）；宿主可覆写 */
  denyWrite: ["/**/.git/**"],
};

/** 兼容导出（既有消费面/测试单源引用）：内置缺省表的直读形态 */
export const DEFAULT_DENY_READ: readonly string[] = DEFAULT_BASELINE.denyRead;
export const DEFAULT_DENY_READ_OUTSIDE: readonly string[] = DEFAULT_BASELINE.denyReadOutside;
export const DEFAULT_DENY_WRITE: readonly string[] = DEFAULT_BASELINE.denyWrite;

/** 围栏侧同源目录表（sandbox fence denyRead 消费——无 glob 的目录形态子集，两表一源）。
 *  宿主覆写 denyRead 后 fence 侧目录表由宿主 FenceBase.denyReadExtra 承接（围栏配置面） */
export const DEFAULT_DENY_READ_DIRS: readonly string[] = ["~/.ssh", "~/.aws", "~/.gcp"];

/** 底线解析（单源：缺省 ∧ 宿主覆写——传全集即覆写，null/undefined = 用缺省） */
export function baselineOf(host?: BaselinePolicy): Readonly<Required<BaselinePolicy>> {
  if (host === undefined) return DEFAULT_BASELINE;
  return {
    denyRead: host.denyRead ?? DEFAULT_BASELINE.denyRead,
    denyReadOutside: host.denyReadOutside ?? DEFAULT_BASELINE.denyReadOutside,
    denyWrite: host.denyWrite ?? DEFAULT_BASELINE.denyWrite,
  };
}

/** 习得闸：这些命令头不习得记忆（红队/上层 P1-4 单源裁决——内核导出，host 命令面同闸消费；
 *  一次「always allow」不得终身放行硬拒族/wrapper·解释器前缀；万配由形态面另拒） */
export const MEMORY_BLOCKED_HEADS: readonly string[] = [
  "sudo", "doas", "su", "rm", "mkfs", "dd", "chmod", "chown", "bash", "sh", "zsh", "dash", "ksh",
  "env", "node", "python", "python3", "perl", "ruby", "php", "osascript", "eval", "xargs", "awk", "sed",
];

/** 底线规则全集（decideFor 内部恒合并——纯直调方与插件执行面同真相）；拒读但
 *  恒在场（凭据面——总括档不放行），拒写表仅非总括档（full 语义：.git 可写）。
 *  .env 族以 outside-roots 条件形态合并（路径在工作区根集内不命中——项目本地配置放行） */
export function baselineDenyRules(unrestricted = false, baseline?: BaselinePolicy): readonly PermissionRule[] {
  const policy = baselineOf(baseline);
  const denyRead: PermissionRule[] = [
    ...policy.denyRead.map((pattern) => ({ tool: "Read" as const, pattern, verdict: "deny" as const, origin: "default" as const })),
    ...policy.denyReadOutside.map((pattern) => ({ tool: "Read" as const, pattern, verdict: "deny" as const, origin: "default" as const, outsideRoots: true as const })),
  ];
  if (unrestricted) return denyRead;
  return [...denyRead, ...policy.denyWrite.map((pattern) => ({ tool: "Write" as const, pattern, verdict: "deny" as const, origin: "default" as const }))];
}

/** 习得闸判定：规则头（首词，滤空白——前导空格形 `Danger( chmod:*)` 同拦，与 bash-prefix
 *  词元化同口径，红队 R9）在禁习表内或空头（畸形串）→ 不落记忆 */
export function memoryBlocked(pattern: string): boolean {
  const head = pattern.replace(/:\*$/, "").trim().split(/\s+/).filter((word) => word !== "")[0];
  return head === undefined || MEMORY_BLOCKED_HEADS.includes(head);
}
