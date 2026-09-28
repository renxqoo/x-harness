// 底线表单源（2026-09-29 重构裁决）：恒拒读/条件读（.env 族——根集外）/拒写三表的
// 提取与命中判定收敛于此——事实面（facts.ts）与执法面（adjudicate.ts）消费同一函数，
// 事实与执法永不分歧（重构前双写曾致 plan 档根集内 .env 重定向读误报 redirect-read）。
// 表值：内核缺省（baselineOf）+ 调用方追加（denyRules——outsideRoots 标记分流两读表）；
// 根集：bash 面 writableRoots（条件表豁免判定的基准）。

import type { BashPipelineInput } from "./adjudicate.ts";
import { writableRoots } from "./adjudicate.ts";
import { baselineOf } from "../baseline.ts";
import type { DenyTables } from "../sensitive.ts";
import { denyReadHit } from "../sensitive.ts";

/** 恒拒读表（凭据目录——任意位置拒止；调用方 Read 非 outsideRoots 追加并入） */
function denyReadPatternsOf(input: BashPipelineInput): readonly string[] {
  return [...baselineOf(input.baseline).denyRead, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Read" && rule.outsideRoots !== true).map((rule) => rule.pattern)];
}

/** 条件拒读表（.env 族——根集外拒止；调用方 Read outsideRoots 追加并入） */
function denyReadOutsidePatternsOf(input: BashPipelineInput): readonly string[] {
  return [...baselineOf(input.baseline).denyReadOutside, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Read" && rule.outsideRoots === true).map((rule) => rule.pattern)];
}

/** 拒写表（.git 元数据/保护路径——调用方 Write 追加并入；重定向输出硬线消费） */
export function denyWritePatternsOf(input: BashPipelineInput): readonly string[] {
  return [...baselineOf(input.baseline).denyWrite, ...(input.denyRules ?? []).filter((rule) => rule.tool === "Write").map((rule) => rule.pattern)];
}

/** 敏感面表组装（恒拒/条件/保护写三表 + 根集）——argv 敏感面与事实面共用 */
export function denyTablesOf(input: BashPipelineInput): DenyTables {
  return {
    protectedWrite: input.protectedWrite ?? [],
    denyRead: denyReadPatternsOf(input),
    denyWrite: denyWritePatternsOf(input),
    denyReadOutside: denyReadOutsidePatternsOf(input),
    allowRoots: writableRoots(input),
  };
}

/** 拒读命中判定（重定向读面/事实面共用——恒拒表 glob 直判 + 条件表根集外判）。
 *  豁免判单源 sensitive.denyReadHit（表组装本文件，判定语义单一真源） */
export function denyReadHitOf(input: BashPipelineInput, path: string): string | undefined {
  return denyReadHit(denyTablesOf(input), path, input.root);
}
