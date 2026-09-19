// 依赖门禁四用例（docs/ELEVATION-MIGRATION-W0 §5）：正例（组内互依+typebox 合法）；
// 反例 ×3——上层包经 dependencies、上层包藏 devDependencies（V5 真实违规形态）、
// 外部说明符未声明。fixture 用临时目录铸最小内核组。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kernelDependencyViolations } from "../check-kernel-deps.ts";

let root = "";
afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

/** dirName = packages/core/ 下目录名；pkgName = manifest name */
function corePkg(dirName: string, pkgName: string, opts: {
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  src?: string;
} = {}): void {
  const dir = join(root, "packages/core", dirName, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "packages/core", dirName, "package.json"), JSON.stringify({ name: pkgName, dependencies: opts.deps ?? {}, devDependencies: opts.devDeps ?? {} }));
  writeFileSync(join(dir, "index.ts"), opts.src ?? "export const x = 1;\n");
}

describe("check-kernel-deps（内核组纯净性门禁）", () => {
  it("正例：组内互依 + typebox + node 内置 → 0 违规", () => {
    root = mkdtempSync(join(tmpdir(), "xh-kd-ok-"));
    corePkg("tools", "@x-harness/tools", { deps: { "@sinclair/typebox": "^0.34.0" }, src: 'import { createHash } from "node:crypto";\nimport { Type } from "@sinclair/typebox";\nexport const x = 1;\n' });
    corePkg("system-prompt", "@x-harness/system-prompt", { deps: { "@x-harness/core": "workspace:*" }, src: 'import { createContext } from "@x-harness/core";\nexport const x = 1;\n' });
    expect(kernelDependencyViolations(root)).toEqual([]);
  });

  it("反例：core 组 import 上层包（声明于 dependencies）→ upper-layer 违规", () => {
    root = mkdtempSync(join(tmpdir(), "xh-kd-up-"));
    corePkg("tools", "@x-harness/tools", { deps: { "@x-harness/agent-loop": "workspace:*" }, src: 'import { agentLoop } from "@x-harness/agent-loop";\n' });
    const violations = kernelDependencyViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe("upper-layer");
    expect(violations[0]?.specifier).toBe("@x-harness/agent-loop");
  });

  it("反例：core 组 import 上层包藏 devDependencies（V5 形态）→ upper-layer 违规", () => {
    root = mkdtempSync(join(tmpdir(), "xh-kd-dev-"));
    corePkg("session", "@x-harness/session", { devDeps: { "@x-harness/permission": "workspace:*" }, src: 'import { permissionGrants } from "@x-harness/permission";\n' });
    const violations = kernelDependencyViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe("upper-layer"); // devDeps 藏边同样检出——门禁扫 src 说明符非声明面
  });

  it("反例：非白名单外部包 / 白名单未声明 → external-not-allowed / undeclared 违规", () => {
    root = mkdtempSync(join(tmpdir(), "xh-kd-ext-"));
    corePkg("exec-env", "@x-harness/exec-env", { src: 'import { z } from "zod";\nimport { Type } from "@sinclair/typebox";\n' });
    const reasons = kernelDependencyViolations(root).map((v) => `${v.specifier}:${v.reason}`).sort();
    expect(reasons).toEqual(["@sinclair/typebox:undeclared", "zod:external-not-allowed"]);
  });
});
