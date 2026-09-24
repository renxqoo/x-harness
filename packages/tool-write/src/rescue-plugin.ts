// 截断 write/edit 半截产出抢救插件（docs/TRUNCATED-TOOL-RESCUE.md 层 2）：挂
// agentTruncatedTool waterfall，把半截参数里的 content（write）/末条 newText（edit）前缀物化成
// <target>.partial sidecar。waterfall 中间件纪律：必调 next、让位 = 透传下游、不以
// throw 表达策略。
//
// 双层授权面（与 write 工具同源）：① PathGate/admitSession（越根/穿越词法+物理双查）；
// ② permission 裁决（deny 规则/plan-deny 硬闸/protectedPaths——decideFor 纯函数，
// 规则集与档位经 permissionGrants/permissionMode 服务消费，deny 即降级 note 不落盘）。
// ask 档裁决不弹窗（抢救是增益非契约——需要人批的路径直接不救，模型重发完整调用
// 时会走正常 ask 面板）。不登记 ObservedRegistry（sidecar 不参与版本 CAS）；
// 不动目标文件（write 覆盖语义写一半 = 破坏现场）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolDecision, TruncatedToolPayload } from "@x-harness/agent-loop";
import { admitSession } from "@x-harness/tool-core";
import type { ExtraRootsOf, ObservedRegistry, PathGate, RootOverrideOf } from "@x-harness/tool-core";
import type { ExecEnv } from "@x-harness/exec-env";
import { decideFor, fenceFacts, permissionGrants, permissionMode, resolveProfile } from "@x-harness/permission";
import type { PermissionRule } from "@x-harness/permission";
import { relative } from "node:path";
import { realpathSync } from "node:fs";
import { extractStringField } from "./extract-string-field.ts";
import { extractLastEditText } from "./extract-last-edit-text.ts";

/** 微型半截不值得一次 read 往返——低于此字符数不物化（稳定语义代码常量，不进配置面） */
const MIN_RESCUE_CHARS = 512;

export interface TruncatedRescueInput {
  /** 授权面三件套（与 createWriteTool 同源注入面）。observed 在场但不消费：
   *  sidecar 不是观察-写流程，不参与版本 CAS——字段保留是装配面单一形状（三件套整传）。 */
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ExecEnv;
  readonly extraRootsOf?: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
  /** permission 裁决面（write 工具同源）：root/rules/projectRules/customProfiles 装配期
   *  静态传入；grants/mode/围栏事实经服务令牌运行期消费。缺席（无 permission 装配的世界）
   *  → 抢救不启用物化（只有 base 文案）——无裁决面即无写盘授权。 */
  readonly permission?: {
    readonly root: string;
    readonly rules?: readonly PermissionRule[];
    readonly projectRules?: readonly PermissionRule[];
    /** 宿主保护写路径（argv 敏感面——decideFor protectedWrite 同名面） */
    readonly protectedWrite?: readonly string[];
  };
}

export function createTruncatedWriteRescuePlugin(input: TruncatedRescueInput): Plugin {
  const { gate, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  const rootOverrideOf = input.rootOverrideOf;
  const perm = input.permission;
  return {
    name: "tool-write-truncated-rescue",
    apply: (ctx: Context): Disposer => {
      // 服务令牌 tryUse：permission 件在场才有 grants/mode/围栏（缺一即无裁决面——不物化）
      const grants = ctx.tryUse(permissionGrants);
      const mode = ctx.tryUse(permissionMode);
      const fence = ctx.tryUse(fenceFacts);

      /** permission 裁决（write 同源面）：deny/plan-deny → "rescue-denied"；ask → 同判不
       *  弹窗（模型重发完整调用走正常面板）；装配面/服务缺席 → undefined（不物化）。
       *  path 判定在 perm.root 树上做——admitted.path 是 realpath 形态（macOS /var →
       *  /private/var），与装配 root 可能不同树前缀，先归一再相对化（见 relPathWithin）。 */
      const rescuePermissionOf = (session: TruncatedToolPayload["session"], absolute: string): "allow" | "rescue-denied" | undefined => {
        if (perm === undefined || grants === undefined || mode === undefined) return undefined;
        const decision = decideFor({
          tool: "write",
          args: { path: relPathWithin(absolute, perm.root, realpathSync) },
          session,
          userRules: perm.rules ?? [],
          ...(perm.projectRules !== undefined && perm.projectRules.length > 0 ? { projectRules: perm.projectRules } : {}),
          sessionRules: grants.rulesOf(session),
          profile: resolveProfile(mode.get()),
          root: perm.root,
          extraRoots: grants.extraRootsOf(session),
          ...(fence !== undefined ? { fence: fence.forSession(session) } : {}),
          ...(perm.protectedWrite !== undefined ? { protectedWrite: perm.protectedWrite } : {}),
        });
        return decision.verdict === "allow" ? "allow" : "rescue-denied";
      };
      return ctx.on(
        agentTruncatedTool,
        async (payload: TruncatedToolPayload, next: (input: TruncatedToolPayload) => Promise<TruncatedToolDecision>) => {
          const downstream = await next(payload);
          if (payload.signal.aborted) return downstream; // abort 竞态：不写盘（aborted 全序格盖过抢救）
          if (downstream !== undefined) return downstream; // 上游中间件已抢救 → 让位
          const kind = toolKindOf(payload.name);
          if (kind === undefined) return downstream;
          // write：顶层单键提取；edit：edits[] 数组内末条 newText（截断点大概率在最后的
          // in-flight 条目——与 pi-events「截断只可能命中最后一个 in-flight 块」同推论）
          const { path, value } = kind.edit === true ? extractLastEditText(payload.arguments) : extractStringField(payload.arguments, kind.field);
          if (path === undefined || path === "" || value === undefined) return downstream; // 目标不可名/空 path → 无可抢救
          if (value.length < MIN_RESCUE_CHARS) {
            return { note: `truncated arguments too short to be worth a draft (${String(value.length)} chars)` };
          }
          const admitted = await admitSession({ gate, realpath: env.realpath, session: payload.session, extraRootsOf, rootOverrideOf, target: `${path}.partial` });
          if (!admitted.ok) return { note: "target outside workspace boundary, draft not saved" };
          const decision = rescuePermissionOf(payload.session, admitted.path);
          if (decision === "rescue-denied") return { note: "target not permitted for rescue write, draft not saved" };
          if (decision === undefined) return downstream; // 无 permission 装配面 → 不物化（无裁决面即无写盘授权）
          const st = await env.stat(admitted.path);
          if (st.ok) return { note: `draft exists at ${path}.partial, not overwritten` }; // 同名 .partial 可能是有意命名——静默覆盖是数据丢失通道
          const written = await env.writeFileAtomic(admitted.path, Buffer.from(value, "utf8"), { makeParents: true });
          if (!written.ok) return downstream; // 写不进去 → 纯 base 文案（副作用失败不以 throw 表达）
          return { note: kind.note({ chars: value.length, lines: value.split("\n").length, path }) };
        },
      );
    },
  } satisfies Plugin;
}

/** admitted.path（realpath 形态）→ 裁决树内相对形：decideFor 的 globMatch 以 root 展开
 *  模式并按段匹配路径——admitted.path 的 realpath 前缀（macOS /var → /private/var）与
 *  原始 root 可能不同树，先 realpath 归一 root 再求相对，跨树时回退绝对原样。 */
function relPathWithin(absolute: string, root: string, realpathOf: (p: string) => string): string {
  const rel = relative(realpathOf(root), absolute);
  return rel.startsWith("..") ? absolute : rel;
}

/** 抢救表：write 提顶层 content、edit（精确名）提 edits[] 末条 newText；其余工具不在表内 */
interface RescueKind {
  readonly field: string;
  /** true = edit 形态（edits[] 数组感知提取） */
  readonly edit?: true;
  readonly note: (f: { readonly chars: number; readonly lines: number; readonly path: string }) => string;
}

function toolKindOf(name: string): RescueKind | undefined {
  const lower = name.toLowerCase();
  if (lower === "write") {
    return {
      field: "content",
      note: (f) => `Recovered ${String(f.chars)} chars (${String(f.lines)} lines) of the truncated write to ${f.path}.partial (draft — ${f.path} NOT modified). Read it, produce the remainder as a separate file, assemble with bash, then delete the .partial.`,
    };
  }
  if (lower === "edit") {
    return {
      field: "newText",
      edit: true,
      note: (f) => `Recovered ${String(f.chars)} chars of the last edit's newText in the truncated edit call to ${f.path}.partial (draft — ${f.path} NOT modified). Read it, re-issue the edits in smaller, separate edit calls, then delete the .partial.`,
    };
  }
  return undefined;
}
