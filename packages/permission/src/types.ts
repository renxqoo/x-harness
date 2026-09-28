// permission 契约类型（docs/PERMISSION-V2-DESIGN.md §2/§4/§6）：规则条目（作用域×性质双维）、
// profile 档位（数据行非枚举）、执行指令、ask 结构化往返。围栏事实与默认拒读表沿用。

import type { SessionId } from "@x-harness/session";

export type Verdict = "allow" | "deny" | "ask";
/** 规则命名空间 = 工具类别（kind 声明面）。Danger = 命令语言面（逐次裁决类） */
export type RuleTool = "Danger" | "Read" | "Write" | "Tool";
/** 规则作用域（存储位置示别）：user/project=设置文件持久层；session=进程授权桶；
 *  default=内置基线拒止（V4 净化 #2——permission-modes 产，归因真名不伪装 user） */
export type RuleOrigin = "user" | "project" | "session" | "default";
/** 规则性质：handwritten=用户显式手写（可 ask/deny）；grant=习得记忆（恒 allow） */
export type RuleNature = "handwritten" | "grant";

/** 规则条目：Bash 模式=词元前缀（`git push:*` / 裸 `git status` / `*` 万配）；
 *  路径工具=glob；Tool=工具名通配（`web*`）。nature 缺省 handwritten（规则串解析形态）。 */
export interface PermissionRule {
  readonly tool: RuleTool;
  readonly pattern: string;
  readonly verdict: Verdict;
  readonly origin: RuleOrigin;
  readonly nature?: RuleNature;
  /** 条件形态（内核 .env 族底线专用）：命中路径在工作区根集（root+extraRoots）内时
   *  规则不生效——项目本地配置是常规读写面，拒止只针对根集外（凭据自 .env 收割） */
  readonly outsideRoots?: true;
  /** 习得落档时间（epoch ms——审计/管理面展示；手写缺省） */
  readonly at?: number;
}

/** 设置文件持久层的学习条目形态（permission.rules 键值——与 PermissionRule 的
 *  差集仅 origin：文件位置已示别作用域，读入时由宿主补） */
export interface RuleEntry {
  readonly tool: RuleTool;
  readonly pattern: string;
  readonly verdict: Verdict;
  readonly nature: RuleNature;
  readonly at?: number;
}

export type ExecDirective = "direct" | "contained";

/** 档位旋钮束（docs/PERMISSION-V2-DESIGN.md §4.1）：加档=加表行 */
export interface PermissionProfile {
  readonly id: string;
  /** 未分类剩余部分的询问策略：never=不问（full 总括表达）；on-failure=先围栏失败才问；
   *  on-opaque=不透明形态问；always=一切未分类问 */
  readonly askPolicy: "never" | "on-failure" | "on-opaque" | "always";
  /** allow/ask 批准后的执行指令：none=direct；fenced=contained（srt 包裹） */
  readonly containment: "none" | "fenced";
  /** 变更类处置：plan-deny=硬闸（先于规则）；confirm-all=界内写也问；auto-in-root=界内合成写自动 */
  readonly mutationPolicy: "plan-deny" | "confirm-all" | "auto-in-root";
}

export type ProfileId = "plan" | "auto" | "edit-confirm" | "full" | "sandboxed-auto";

/** 档位 id 词表（单一真相）——CLI flag/宿主 settings 校验与错误文案 join 同源；
 *  自定义档位经宿主 settings 追加行（id 不得撞内置保留名）。 */
export const PROFILE_IDS = ["plan", "auto", "edit-confirm", "full", "sandboxed-auto"] as const satisfies readonly ProfileId[];

/** 围栏事实快照（sandbox 提供，permission 定义 token 消费；缺席=无围栏装配）。
 *  allowedDomains 面已删（2026-09-28 P3-8：域名授权位删除后生产零写入——死面不养；
 *  网络白名单归 sandbox options 自持） */
export interface FenceFacts {
  readonly writable: readonly string[];
}

/** V4 净化 #2：DEFAULT_DENY_READ/WRITE 表迁 @x-harness/permission-modes（策略数据）。
 *  本包仅留读形态类型（sandbox 同表执法面经消费方注入——见 sandbox 包消费）；写表全迁。 */

/** ask 载荷（结构化往返——broker 输入侧）：summary=目标描述（确认条主文案）；
 *  options 按命中类裁剪（拒记类只余 once） */
export interface AskPayload {
  readonly tool: string;
  /** 目标描述（确认条主文案——路径类=<path>、bash=<command>；构造不出则缺席，见 summaryOf） */
  readonly summary?: string;
  readonly reason: string;
  readonly options: readonly ("once" | "session" | "project" | "user")[];
  readonly suggestedRule?: string;
  readonly escalate?: { readonly command: string; readonly failureText: string };
  readonly session?: SessionId;
}

/** ask 应答：布尔形态的退化语义 = allow-once / deny（无记忆写入） */
export interface AskReply {
  readonly verdict: "allow" | "deny";
  readonly memory?: "session" | "project" | "user";
  readonly ruleOverride?: string;
}

export interface PermissionAudit {
  readonly tool: string;
  readonly verdict: Verdict;
  readonly resolvedBy: string;
  readonly reason: string;
  readonly exec?: ExecDirective;
  readonly session?: SessionId;
}
