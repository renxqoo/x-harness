import type { BashPipelineInput } from "./adjudicate.ts";
import { writableRoots } from "./adjudicate.ts";
import { baselineOf } from "../baseline.ts";
import type { DenyTables } from "../sensitive.ts";
import { denyReadHit } from "../sensitive.ts";

function denyReadPatternsOf(input: BashPipelineInput): readonly string[] {
  return [...baselineOf(input.baseline).denyRead, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Read" && rule.outsideRoots !== true).map((rule) => rule.pattern)];
}

function denyReadOutsidePatternsOf(input: BashPipelineInput): readonly string[] {
  return [...baselineOf(input.baseline).denyReadOutside, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Read" && rule.outsideRoots === true).map((rule) => rule.pattern)];
}

export function denyWritePatternsOf(input: BashPipelineInput): readonly string[] {
  return [...baselineOf(input.baseline).denyWrite, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Write").map((rule) => rule.pattern)];
}

export function denyTablesOf(input: BashPipelineInput): DenyTables {
  return {
    protectedWrite: input.protectedWrite ?? [],
    denyRead: denyReadPatternsOf(input),
    denyWrite: denyWritePatternsOf(input),
    denyReadOutside: denyReadOutsidePatternsOf(input),
    allowRoots: writableRoots(input),
  };
}

export function denyReadHitOf(input: BashPipelineInput, path: string): string | undefined {
  return denyReadHit(denyTablesOf(input), path, input.root);
}
