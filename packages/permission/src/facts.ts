// V3 事实面（docs/PERMISSION-V3-DESIGN.md §1.2 / B-mix-9）：核心产出的判定输入——
// 模式插件消费事实做判决，不自聚合（B-bug-1/5 的结构性根治：策略重抄机制必漏项）。
// bashFactsOf 是唯一事实生产器（adjudicateBash 分派与插件测试共用——单一真相）。

import type { ParsedCommand } from "./bash/ast.ts";
import type { ToolKind } from "@x-harness/tools";
import { parseBash } from "./bash/ast.ts";
import { hardDeny } from "./bash/hard-deny.ts";
import type { BashPipelineInput } from "./bash/adjudicate.ts";
import { writableRoots } from "./bash/adjudicate.ts";
import { argvSensitiveHit } from "./sensitive.ts";
import type { DenyTables } from "./sensitive.ts";
import { denyReadHitOf, denyTablesOf } from "./bash/tables.ts";
import { ELEVATION_TEXT } from "./bash/hard-deny.ts";
import { cwdAfter } from "./sensitive.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 裁决事实（三面共用：tool 无专属面 / path 路径族 / bash 管线） */
export interface AdjudicationFacts {
  readonly face: "tool" | "path" | "bash";
  readonly tool: string;
  /** path 面归一后路径 */
  readonly path?: string;
  /** V4 净化 #6（P-mix-13）：path 参数缺席/非串——模式自决缺省（base 不再默默落 root） */
  readonly pathAbsent?: true;
  /** 工具类别（闭集三分类——策略统一写在分类轴上）：Read=只读 / Write=写 /
   *  Danger=逐次裁决（bash 面）。业务工具不声明 kind（通用面，缺席） */
  readonly kind?: ToolKind;
  /** 工作区根（edit-confirm 建议 `Write(root/**)` 等姿态消费——事实非策略） */
  readonly root?: string;
  /** path 面：目标在根集内 */
  readonly inRoot?: boolean;
  /** bash 面：解析失败形态 */
  readonly parseFailed?: "unparseable" | "parser-unavailable";
  /** 提权事实（hardDeny kind=sudo / ask=hard-deny:sudo / 词面兜底正则命中） */
  readonly elevation?: true;
  /** bash 面：解析后的分段（含旗面——插件可逐段读 injection/ask/opaque/dynamic/redirects） */
  readonly segments?: readonly ParsedCommand[];
  /** bash 面：任一段的 hardDeny 种类（含非 sudo 类——plan 档全拒提权面消费） */
  readonly hardDenyKind?: string;
  /** bash 面：argv 敏感面命中（拒读表/保护写——plan 恒拒消费；auto 走 fallback 自行 ask） */
  readonly sensitiveHit?: { readonly kind: string; readonly pattern: string };
  /** bash 面：输入重定向命中拒读表（pattern） */
  readonly redirectReadDeny?: string;
  /** bash 面：重定向目标不可静态解析（~user 形） */
  readonly redirectUnresolvable?: true;
  /** bash 面：存在非 /dev/null 的输出重定向 */
  readonly hasOutputRedirect?: boolean;
  /** bash 面：可写根集（writableRoots 归一——模式侧自算分类的判定输入。V4 #7b：
   *  分类三态是 auto 风险偏好（策略），已迁 permission-modes/classifier.ts——
   *  内核只产归一化命令结构 + 根集事实） */
  readonly roots?: readonly string[];
}

const DEV_NULL = "/dev/null";

/** 重定向目标归一（与 adjudicate.targetPath 同式——facts 生产单源） */
function targetOf(target: string, root: string): string | null {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (/^~[A-Za-z0-9_.-]/.test(target)) return null;
  return resolve(root, target);
}

/** 段级事实收集（hardDeny/敏感面/重定向双面——首中即记，不聚合全量） */
interface SegmentFacts {
  hardDenyKind?: string;
  sensitiveHit?: { readonly kind: string; readonly pattern: string };
  redirectReadDeny?: string;
  redirectUnresolvable?: true;
  hasOutputRedirect?: true;
}

/** 段级事实的底线表单源（tables.ts——事实与执法同源，行为不分歧；verbFactsOf 敏感面消费） */
function tablesOf(input: BashPipelineInput): DenyTables {
  return denyTablesOf(input);
}

/** 段级动词事实（hardDeny/敏感面——首中即记；cwd 为累积解析基——cd 链改变相对词锚定） */
function verbFactsOf(cmd: import("./bash/ast.ts").ParsedCommand, input: BashPipelineInput & { cwd: string }, out: SegmentFacts): void {
  if (cmd.argv.length === 0) return;
  if (out.hardDenyKind === undefined) {
    const kind = hardDeny(cmd.argv);
    if (kind !== undefined || cmd.ask === "hard-deny:sudo") out.hardDenyKind = kind ?? "sudo";
  }
  // 提权词面兜底（2026-09-29 红队 P0 根治）：elevation 事实不再只信 hardDeny 首词命中——
  // 全段 argv 任意词含提权词即记 hardDenyKind=sudo（载荷形 watch 'sudo id'、git -c 值、
  // env -S 载荷、$'su'do 拼接词、xargs -I{} sh -c 载荷——full 档提权恒拒面曾整面被绕）
  if (out.hardDenyKind === undefined && cmd.argv.some((word) => ELEVATION_TEXT.test(word))) out.hardDenyKind = "sudo";
  if (out.sensitiveHit === undefined) out.sensitiveHit = argvSensitiveHit([cmd], input.cwd, tablesOf(input)) ?? undefined;
}

/** 段级重定向事实（输出面存在性/输入面拒读表/目标不可解析——首中即记；cwd 为累积解析基） */
function redirectFactsOf(cmd: import("./bash/ast.ts").ParsedCommand, input: BashPipelineInput & { cwd: string }, out: SegmentFacts): void {
  for (const redirect of cmd.redirects) {
    if (redirect.target === undefined || redirect.target === DEV_NULL) continue;
    if (redirect.face === "output") {
      out.hasOutputRedirect = true;
      continue;
    }
    const path = targetOf(redirect.target, input.cwd);
    if (path === null) {
      out.redirectUnresolvable = true;
      continue;
    }
    const hit = denyReadHitOf(input, path);
    if (hit !== undefined && out.redirectReadDeny === undefined) out.redirectReadDeny = hit;
  }
}

function collectSegmentFacts(commands: readonly import("./bash/ast.ts").ParsedCommand[], input: BashPipelineInput): SegmentFacts {
  const out: SegmentFacts = {};
  let cwd = input.root;
  for (const cmd of commands) {
    verbFactsOf(cmd, { ...input, cwd }, out);
    redirectFactsOf(cmd, { ...input, cwd }, out);
    cwd = cwdAfter(cmd, cwd);
  }
  return out;
}

/** bash 面事实生产器（唯一真相——adjudicateBash 模式分派与模式插件测试共用） */
export function bashFactsOf(input: BashPipelineInput): AdjudicationFacts {
  const parsed = (input.parse ?? parseBash)(input.command);
  if (!parsed.ok) {
    return {
      face: "bash",
      tool: "bash",
      kind: "Danger",
      ...(parsed.kind === "parser-unavailable" ? { parseFailed: "parser-unavailable" as const } : { parseFailed: "unparseable" as const }),
      segments: [],
    };
  }
  const seg = collectSegmentFacts(parsed.commands, input);
  return {
    face: "bash",
    tool: "bash",
    kind: "Danger",
    segments: parsed.commands,
    ...(seg.hardDenyKind !== undefined ? { hardDenyKind: seg.hardDenyKind } : {}),
    ...(seg.sensitiveHit !== undefined ? { sensitiveHit: seg.sensitiveHit } : {}),
    ...(seg.redirectReadDeny !== undefined ? { redirectReadDeny: seg.redirectReadDeny } : {}),
    ...(seg.redirectUnresolvable === true ? { redirectUnresolvable: true } : {}),
    ...(seg.hasOutputRedirect === true ? { hasOutputRedirect: true } : {}),
    roots: writableRoots(input),
    ...(seg.hardDenyKind === "sudo" ? { elevation: true as const } : {}),
  };
}
