// 日期 + 项目指令快照装配（docs/TAIL-SNAPSHOT-CHANNEL.md A/C'）：易变事实出锚点、
// 走边沿注入（createTailSnapshot 共用原语——首份预锚、变更重注入尾部、内容维幂等）。
// 日期按天一条（clock 可注入——测试假钟）；项目指令每 kick 同步重读 cwd 下
// AGENTS.md/CLAUDE.md（AGENTS.md 在前、内容去重、64KB 上限以读到 buffer 长度为准）。
// worktree 语义（评审处置 M7）：全部会话注入主进程 cwd 的指令文件——per-session
// cwd 是 delegation 独立契约面，另件。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Disposer, Plugin } from "@x-harness/core";
import { agentLoopServiceToken, createTailSnapshot, snapshotEnvelope } from "@x-harness/agent-loop";

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

export interface InstructionRead {
  /** 合并正文（各文件以 --- 分隔；空 = 无指令文件/全部拒注） */
  readonly body: string;
  readonly warnings: readonly string[];
}

/** 同步读取并合并指令文件：AGENTS.md 在前；同内容（软链/复制）去重；超限/读取失败
 *  整文件拒注 + 告警（fail-open 可见——ENOENT 缺席合法静默，其余 IO 错误不吞）。
 *  纯函数面（IO 仅 readFileSync）——单测直测。 */
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

/** 日期 + 项目指令快照插件：装配位紧随 skillKit（build-world 写死——落位互序的单一真相） */
export function createFactsSnapshotPlugin(options: FactsSnapshotOptions): Plugin {
  return {
    name: "cli-facts-snapshot",
    inject: ["agent-loop"],
    apply: (ctx): Disposer => {
      const loop = ctx.use(agentLoopServiceToken);
      const now = options.now ?? (() => Date.now());
      const warn = options.onWarn ?? ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
      const offs = [
        createTailSnapshot({ ctx, loop, spec: { id: "date", render: () => renderDateSnapshot(new Date(now())), onWarn: warn } }),
        createTailSnapshot({ ctx, loop, spec: { id: "project-instructions", render: () => renderInstructionsSnapshot(options.cwd, warn), onWarn: warn } }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
