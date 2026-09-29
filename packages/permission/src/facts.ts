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

export interface AdjudicationFacts {
  readonly face: "tool" | "path" | "bash";
  readonly tool: string;
  readonly path?: string;
  readonly pathAbsent?: true;
  readonly kind?: ToolKind;
  readonly root?: string;
  readonly inRoot?: boolean;
  readonly parseFailed?: "unparseable" | "parser-unavailable";
  readonly elevation?: true;
  readonly segments?: readonly ParsedCommand[];
  readonly hardDenyKind?: string;
  readonly sensitiveHit?: { readonly kind: string; readonly pattern: string };
  readonly redirectReadDeny?: string;
  readonly redirectUnresolvable?: true;
  readonly hasOutputRedirect?: boolean;
  readonly roots?: readonly string[];
}

const DEV_NULL = "/dev/null";

function targetOf(target: string, root: string): string | null {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  if (/^~[A-Za-z0-9_.-]/.test(target)) return null;
  return resolve(root, target);
}

interface SegmentFacts {
  hardDenyKind?: string;
  sensitiveHit?: { readonly kind: string; readonly pattern: string };
  redirectReadDeny?: string;
  redirectUnresolvable?: true;
  hasOutputRedirect?: true;
}

function tablesOf(input: BashPipelineInput): DenyTables {
  return denyTablesOf(input);
}

function verbFactsOf(cmd: import("./bash/ast.ts").ParsedCommand, input: BashPipelineInput & { cwd: string }, out: SegmentFacts): void {
  if (cmd.argv.length === 0) return;
  if (out.hardDenyKind === undefined) {
    const kind = hardDeny(cmd.argv);
    if (kind !== undefined || cmd.ask === "hard-deny:sudo") out.hardDenyKind = kind ?? "sudo";
  }
  if (out.hardDenyKind === undefined && cmd.argv.some((word) => ELEVATION_TEXT.test(word))) out.hardDenyKind = "sudo";
  if (out.sensitiveHit === undefined) out.sensitiveHit = argvSensitiveHit([cmd], input.cwd, tablesOf(input)) ?? undefined;
}

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
