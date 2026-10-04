import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * sdk 垫片防护：host-hub 对 agent-sdk 的再导出必须具名化。
 *
 * 背景：打包态构建（agent-app sync-resources）以 `--external '@x-harness/*'`
 * 产出插件宿主形态。Bun 1.4.2 对「被消费模块的 `export * from <external>`」
 * 会生成引用未声明命名空间变量的 `__reExport`（cli.js:1950 宿主启动即崩，
 * pai-diagnostics 2026-10-04）。具名再导出在 external 下编译正确。
 *
 * 两条不变量：
 * ① 任何源文件不得出现 `export * from "<包说明符>"`（相对路径会被内联，安全）；
 * ② 每个垫片再导出的名字集合 == 目标模块导出集合（减 default）——
 *    sdk 侧新增导出而垫片漏转时立即红，而不是消费方 typecheck 报错时才发现。
 */

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SDK_ROOT = join(SRC_ROOT, "../../../packages/agent-sdk");

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((name) => join(dir, name.toString()))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
}

/** 目标模块的导出集合：运行时名走 Bun.Transpiler.scan，类型名走声明正则。 */
function scanTargetExports(code: string): { runtime: string[]; types: string[] } {
  const runtime = new Bun.Transpiler({ loader: "ts" })
    .scan(code)
    .exports.filter((name) => name !== "default");
  const rest = code.replace(/^export \* from .*$/gm, "");
  const types = [
    ...[...rest.matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1]!),
    ...[...rest.matchAll(/^export type \{([^}]+)\}/gm)].flatMap((m) =>
      m[1]!
        .split(",")
        .map((part) => part.trim().replace(/^type /, ""))
        .filter(Boolean),
    ),
  ];
  return { runtime, types };
}

/** 纯垫片判定：全部有效行都是再导出语句，且至少一条指向 agent-sdk。 */
function isPureAgentSdkShim(path: string): boolean {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
  const reExportLine = /^export (?:type )?\{[^}]+\} from "[^"]+";$/;
  return lines.length > 0 && lines.every((line) => reExportLine.test(line)) &&
    lines.some((line) => line.includes('from "@x-harness/agent-sdk/'));
}

/** 解析垫片里的具名再导出语句：specifier → 导出名集合（运行时与类型合并校验）。 */
function parseShimReExports(code: string): Map<string, Set<string>> {
  const bySpec = new Map<string, Set<string>>();
  for (const match of code.matchAll(/^export (type )?\{([^}]+)\} from "([^"]+)";/gm)) {
    const names = match[2]!
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const spec = match[3]!;
    const set = bySpec.get(spec) ?? new Set<string>();
    for (const name of names) set.add(name);
    bySpec.set(spec, set);
  }
  return bySpec;
}

describe("agent-sdk 垫片再导出不变量", () => {
  const tsFiles = listTsFiles(SRC_ROOT);

  it("不得出现包说明符的 star 再导出（external 下 Bun 1.4.2 编译为未声明变量引用）", () => {
    const offenders = tsFiles.filter((path) => /^export \* from "[^./]/m.test(readFileSync(path, "utf8")));
    expect(
      offenders.map((path) => path.replace(SRC_ROOT, "")),
      "改为具名再导出：export { ... } from / export type { ... } from",
    ).toEqual([]);
  });

  it("每个垫片再导出集合与目标模块一致", () => {
    // 纯垫片 = 文件除空行/注释外只有再导出语句（有本地代码的文件是定制转出面，不适用全量一致）
    const shims = tsFiles.filter(isPureAgentSdkShim);
    expect(shims.length).toBeGreaterThan(0);

    const mismatches = shims.flatMap(collectShimMismatches);
    expect(mismatches).toEqual([]);
  });
});

/** 单个垫片与其目标的导出集差异描述（空数组 = 一致）。 */
function collectShimMismatches(shim: string): string[] {
  const results: string[] = [];
  for (const [spec, exported] of parseShimReExports(readFileSync(shim, "utf8"))) {
    const target = join(SDK_ROOT, spec.replace("@x-harness/agent-sdk/", ""));
    const { runtime, types } = scanTargetExports(readFileSync(target, "utf8"));
    const expected = new Set([...runtime, ...types]);
    const missing = [...expected].filter((name) => !exported.has(name));
    const extra = [...exported].filter((name) => !expected.has(name));
    if (missing.length > 0 || extra.length > 0) {
      const missingNote = missing.length > 0 ? ` 缺: ${missing.join(", ")}` : "";
      const extraNote = extra.length > 0 ? ` 多: ${extra.join(", ")}` : "";
      results.push(`${shim.replace(SRC_ROOT, "")} -> ${spec}${missingNote}${extraNote}`);
    }
  }
  return results;
}
