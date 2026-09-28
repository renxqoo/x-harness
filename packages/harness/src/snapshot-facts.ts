// 日期 + 项目指令快照装配（docs/TAIL-SNAPSHOT-CHANNEL.md A/C'）：易变事实出锚点、
// 走边沿注入（createTailSnapshot 共用原语——首份预锚、变更重注入尾部、内容维幂等）。
// 日期按天一条（clock 可注入——测试假钟）；项目指令每 kick 同步重读 cwd 下
// AGENTS.md/CLAUDE.md（AGENTS.md 在前、内容去重、64KB 上限以读到 buffer 长度为准）。
// apps/cli 与 apps/host-hub 两宿主同源消费（装配位各自写死：紧随 skill 装配）。
// worktree 语义（评审处置 M7）：全部会话注入宿主装配 cwd 的指令文件——per-session
// cwd 是 delegation 独立契约面，另件。
// 模型快照（powered-by 身份行）：请求时点原语（createRequestSnapshot）——dial 取自
// agentRequest 派发（不经宿主层传），拨号切换首个请求即携带新行。
// 权限档快照（plan 模式告知）：kick 时点——人在轮间切档（hub permission/set_mode、
// CLI /plan），下一 kick 采样即够；恒渲染使退出 plan 后新条 supersede 旧指引。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, createRequestSnapshot, createTailSnapshot, snapshotEnvelope } from "@x-harness/agent-loop";
import { permissionMode } from "@x-harness/permission";
import { planControl } from "@x-harness/tool-plan";

/** 指令文件单件上限（字节，以 readFileSync 读到的 buffer 为准——不预 stat，杜绝 TOCTOU；
 *  截断=信息丢失，超限整文件拒注入+告警） */
export const INSTRUCTIONS_CAP_BYTES = 64 * 1024;

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 本地时区 yyyy-mm-dd（toISOString 是 UTC——东八区晚间会差一天） */
export function localToday(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function timeZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 日期快照全文（按天唯一——内容维幂等即节流） */
export function renderDateSnapshot(now: Date): string {
  return snapshotEnvelope("date", `Today's date: ${localToday(now)} (${timeZoneLabel()})`);
}

/** 模型快照全文（powered-by 身份行）：请求时点注入——render 收 agentRequest waterfall
 *  **输出** dial（生效值——hub dial-hook 末端改写后；对抗审查 B1），拨号切换后首个请求
 *  即生效，不经宿主层传 */
export function renderModelSnapshot(model: string): string {
  return snapshotEnvelope("model", `You are powered by the model ${model}.`);
}

/** 权限档快照全文（plan 模式告知）：plan 档注入行为指引（研究只读 + plan_submit 出口），
 *  其余档渲染事实行——恒渲染使退出 plan 后新条 supersede 旧指引（档位切换即注入新行，
 *  人在轮间切档——kick 时点采样即够） */
export function renderPermissionModeSnapshot(mode: string): string {
  if (mode === "plan") {
    return snapshotEnvelope("permission-mode", `You are in plan mode: research and read only. Writes, edits, and mutating commands are denied — do not attempt them. When your plan is ready, present it with the plan_submit tool and wait for the user's approval before making any changes.`);
  }
  return snapshotEnvelope("permission-mode", `Permission mode: ${mode}.`);
}

/** 权限档快照·非 owner 会话变体（对抗审查 R2-F1）：非锚定会话（委派子代理/跨进程 peer）
 *  无审批资格，plan 指引的「等批准」对其不成立——渲染事实行 + 交付指向 */
export function renderPermissionModeNonOwnerSnapshot(mode: string): string {
  if (mode === "plan") {
    return snapshotEnvelope("permission-mode", `Permission mode: plan (read-only; only the session that entered plan mode can submit a plan for approval — deliver findings there).`);
  }
  return snapshotEnvelope("permission-mode", `Permission mode: ${mode}.`);
}

export interface InstructionRead {
  /** 合并正文（各文件以 --- 分隔；空 = 无指令文件/全部拒注） */
  readonly body: string;
  readonly warnings: readonly string[];
}

/** 同步读取并合并指令文件：AGENTS.md 在前；同内容（软链/复制）去重；超限/读取失败
 * 整文件拒注 + 告警（fail-open 可见——ENOENT 缺席合法静默，其余 IO 错误不吞）。
 * 纯函数面（IO 仅 readFileSync）——单测直测。 */
export function readInstructionFiles(cwd: string, capBytes: number = INSTRUCTIONS_CAP_BYTES): InstructionRead {
  const bodies: string[] = [];
  const warnings: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(cwd, name));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") warnings.push(`instructions: ${name} unreadable (${code ?? "io"}), skipped`);
      continue; // ENOENT = 缺席合法；其余失败告警跳过
    }
    if (buffer.byteLength > capBytes) {
      warnings.push(`instructions: ${name} is ${String(buffer.byteLength)} bytes (> ${String(capBytes)}), skipped`);
      continue;
    }
    const text = buffer.toString("utf8");
    if (bodies.some((existing) => existing === text)) continue; // 同内容去重（软链/复制）
    bodies.push(text);
  }
  return { body: bodies.join("\n---\n\n"), warnings };
}

/** 渲染指令快照全文（告警走 onWarn；空 body = 零注入） */
function renderInstructionsSnapshot(cwd: string, onWarn?: (message: string) => void): string {
  const read = readInstructionFiles(cwd);
  for (const warning of read.warnings) onWarn?.(warning);
  return read.body === "" ? "" : snapshotEnvelope("project-instructions", read.body);
}

export interface FactsSnapshotOptions {
  readonly cwd: string;
  /** clock 注入（缺省 Date.now——测试假钟锚按天幂等/跨天新条） */
  readonly now?: () => number;
  /** 告警面（缺省 stderr） */
  readonly onWarn?: (message: string) => void;
}

/** 日期 + 项目指令 + 权限档快照插件：装配位紧随 skill 装配（两宿主写死——落位互序的单一真相） */
export function createFactsSnapshotPlugin(options: FactsSnapshotOptions): Plugin {
  return {
    name: "facts-snapshot",
    inject: ["agent-loop"],
    // S0 软依赖：permission 在场则排后（服务面 render/kick 期懒解析——排序非功能
    // 承载，迟到 provide 下一 kick 亦可见）
    softInject: ["permission"],
    apply: (ctx): Disposer => {
      const loop = ctx.use(agentLoopServiceToken);
      const now = options.now ?? (() => Date.now());
      const warn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
      const offs = [
        createTailSnapshot({ ctx, loop, spec: { id: "date", render: () => renderDateSnapshot(new Date(now())), onWarn: warn } }),
        createTailSnapshot({ ctx, loop, spec: { id: "project-instructions", render: () => renderInstructionsSnapshot(options.cwd, warn), onWarn: warn } }),
        createRequestSnapshot({ ctx, loop, spec: { id: "model", render: (dial) => renderModelSnapshot(dial.model), onWarn: warn } }),
        // 权限档快照（plan 模式告知）：permission 服务缺席（纯工具世界）→ 空串零注入；
        // 非 owner 会话渲染观察者变体（plan 指引的「等批准」仅对锚定会话成立——planControl
        // owner 判定，planKit 缺席世界无锚 = 全观察者变体）。服务面 render/kick 期懒解析
        createTailSnapshot({ ctx, loop, spec: { id: "permission-mode", render: (session) => {
          const mode = ctx.tryUse(permissionMode);
          if (mode === undefined) return "";
          if (mode.get() !== "plan") return renderPermissionModeSnapshot(mode.get());
          return ctx.tryUse(planControl)?.owner === session ? renderPermissionModeSnapshot("plan") : renderPermissionModeNonOwnerSnapshot("plan");
        }, onWarn: warn } }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
