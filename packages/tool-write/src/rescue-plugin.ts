// 截断 write/edit 半截产出抢救插件（docs/TRUNCATED-TOOL-RESCUE.md 层 2）：挂
// agentTruncatedTool waterfall，把半截参数里的 content/new_string 前缀物化成
// <target>.partial sidecar。waterfall 中间件纪律：必调 next、让位 = 透传下游、不以
// throw 表达策略。sidecar 落盘与 write 工具同源授权面（admitSession——path 是未经
// 校验的模型产物，裸写即绕过越根/穿越授权）；不登记 ObservedRegistry（sidecar 不
// 参与版本 CAS）；不动目标文件（write 覆盖语义写一半 = 破坏现场）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { agentTruncatedTool } from "@x-harness/agent-loop";
import type { TruncatedToolPayload } from "@x-harness/agent-loop";
import { admitSession } from "@x-harness/tool-core";
import type { ExtraRootsOf, ObservedRegistry, PathGate, RootOverrideOf } from "@x-harness/tool-core";
import type { ExecEnv } from "@x-harness/exec-env";
import { extractStringField } from "./extract-string-field.ts";

/** 微型半截不值得一次 read 往返——低于此字符数不物化（代码常量，与 DEFAULT_MAX_TOKENS 同口径） */
const MIN_RESCUE_CHARS = 512;

export interface TruncatedRescueInput {
  /** 授权面三件套（与 createWriteTool 同源注入面）。observed 在场但不消费：
   *  sidecar 不是观察-写流程，不参与版本 CAS——字段保留是装配面单一形状（三件套整传）。 */
  readonly gate: PathGate;
  readonly observed: ObservedRegistry;
  readonly env: ExecEnv;
  readonly extraRootsOf?: ExtraRootsOf;
  readonly rootOverrideOf?: RootOverrideOf;
}

export function createTruncatedWriteRescuePlugin(input: TruncatedRescueInput): Plugin {
  const { gate, env } = input;
  const extraRootsOf = input.extraRootsOf ?? (() => []);
  const rootOverrideOf = input.rootOverrideOf;
  return {
    name: "tool-write-truncated-rescue",
    apply: (ctx: Context): Disposer =>
      ctx.on(
        agentTruncatedTool,
        async (payload: TruncatedToolPayload, next: (input: TruncatedToolPayload) => Promise<{ readonly note: string } | undefined>) => {
          const downstream = await next(payload);
          if (payload.signal.aborted) return downstream; // abort 竞态：不写盘（aborted 全序格盖过抢救）
          if (downstream !== undefined) return downstream; // 上游中间件已抢救 → 让位
          const kind = toolKindOf(payload.name);
          if (kind === undefined) return downstream;
          const { path, value } = extractStringField(payload.arguments, kind.field);
          if (path === undefined || value === undefined) return downstream; // 目标不可名/字段不在场 → 无可抢救
          if (value.length < MIN_RESCUE_CHARS) {
            return { note: `truncated arguments too short to be worth a draft (${String(value.length)} chars)` };
          }
          const admitted = await admitSession({ gate, realpath: env.realpath, session: payload.session, extraRootsOf, rootOverrideOf, target: `${path}.partial` });
          if (!admitted.ok) return { note: "target outside workspace boundary, draft not saved" };
          const st = await env.stat(admitted.path);
          if (st.ok) return { note: `draft exists at ${path}.partial, not overwritten` }; // 同名 .partial 可能是有意命名——静默覆盖是数据丢失通道
          const written = await env.writeFileAtomic(admitted.path, Buffer.from(value, "utf8"), { makeParents: true });
          if (!written.ok) return downstream; // 写不进去 → 纯 base 文案（副作用失败不以 throw 表达）
          return { note: kind.note({ chars: value.length, lines: value.split("\n").length, path }) };
        },
      ),
  } satisfies Plugin;
}

/** 抢救表：write 提 content、*edit* 提 new_string（大小写不敏感覆盖 edit 工具命名）；其余工具不在表内 */
function toolKindOf(name: string): { readonly field: string; readonly note: (f: { readonly chars: number; readonly lines: number; readonly path: string }) => string } | undefined {
  const lower = name.toLowerCase();
  if (lower === "write") {
    return {
      field: "content",
      note: (f) => `Recovered ${String(f.chars)} chars (${String(f.lines)} lines) of the truncated write to ${f.path}.partial (draft — ${f.path} NOT modified). Read it, produce the remainder as a separate file, assemble with bash, then delete the .partial.`,
    };
  }
  if (lower.includes("edit")) {
    return {
      field: "new_string",
      note: (f) => `Recovered ${String(f.chars)} chars of the truncated edit's new_string to ${f.path}.partial (draft — ${f.path} NOT modified). Read it, re-issue the edit with the replacement text in smaller pieces, then delete the .partial.`,
    };
  }
  return undefined;
}
