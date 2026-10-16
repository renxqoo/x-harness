import { join } from "node:path";
import type { ProjectConfig } from "./types";

export function renderProject(config: ProjectConfig): ReadonlyMap<string, string> {
  const core = JSON.stringify(join(config.sdk, "core/src/index.ts")); const validation = JSON.stringify(join(config.sdk, "core/src/validation.ts"));
  const application = JSON.stringify(join(config.sdk, "application/src/index.ts"));
  return new Map([
    ["package.json", JSON.stringify({ name: config.name, private: true, type: "module", scripts: { start: "bun main.ts", typecheck: "bun check.ts", build: "bun build main.ts --target bun --outdir dist", test: "bun test plugin.test.ts" } }, null, 2) + "\n"],
    ["tsconfig.json", JSON.stringify({ compilerOptions: { target: "ESNext", lib: ["ESNext", "DOM"], module: "ESNext", moduleResolution: "bundler", strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [config.types] }, include: ["*.ts"] }, null, 2) + "\n"],
    ["contracts.ts", `import { defineService } from ${core};
import type { Result } from ${core};
import { createFault } from ${validation};
export interface Greeting { greet(input: string): Promise<Result<string>> }
const defined = defineService<Greeting>({ name: "${config.name}/greeting", methods: { greet: { input: (input) => typeof input === "string" ? { ok: true, value: input } : createFault("invalid-input") } } });
if (!defined.ok) throw new Error("Invalid greeting contract");
export const greeting = defined.value;
`],
    ["plugin.ts", `import { definePlugin } from ${core};
import { greeting } from "./contracts";
export default definePlugin({ name: "${config.name}", provides: { greeting }, setup(ctx) {
  return ctx.service({ greeting: { async greet(name) { return { ok: true, value: "Hello, " + name }; } } });
} });
`],
    ["plugin.test.ts", `import { expect, test } from "bun:test";
import { createApplication } from ${application};
import { greeting } from "./contracts";
import plugin from "./plugin";
test("plugin provides a validated greeting and closes cleanly", async () => {
  const created = createApplication(); if (!created.ok) throw new Error("Application creation failed");
  const app = created.value;
  try {
    const installed = await app.setPlugins([plugin]); expect(installed.ok).toBe(true);
    const service = app.use(greeting); if (!service.ok) throw new Error("Service unavailable");
    expect(await service.value.greet("world")).toEqual({ ok: true, value: "Hello, world" });
    expect((await service.value.greet(42 as unknown as string)).ok).toBe(false);
  } finally { expect((await app.close()).ok).toBe(true); }
  expect(app.inspect().effects).toBe(0); expect(app.inspect().activeTasks).toBe(0);
});
`],
    ["check.ts", `const child = Bun.spawn(["bun", ${JSON.stringify(config.compiler)}, "--noEmit", "-p", "tsconfig.json"], { stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
export {};
`],
    ["README.md", `# ${config.name}\n\n这是一个通用服务插件示例。contracts.ts 定义服务接口；plugin.ts 实现服务；main.ts 负责装配和关闭。\n\n运行环境为 Bun，SDK 使用生成时指定的本地目录。无需联网或安装即可在该 SDK 所在机器执行。移动工程或 SDK 后重新生成配置。\n\n执行 bun run typecheck、bun run test、bun run build、bun run start。部署时运行 bun dist/main.js。\n\n服务通过 app.use(greeting) 获取，插件通过 ctx.service 注册。需要依赖时声明 requires，并通过 call.deps 调用。\n`],
    ["main.ts", `import { createApplication } from ${application};
import type { Result } from ${core};
import { greeting } from "./contracts";
import plugin from "./plugin";
async function main(): Promise<Result<string>> {
  const created = createApplication(); if (!created.ok) return created;
  const app = created.value;
  const installed = await app.setPlugins([plugin]);
  const service = installed.ok ? app.use(greeting) : installed;
  const result = service.ok ? await service.value.greet("world") : service;
  const closed = await app.close(); if (!closed.ok) return closed;
  return result;
}
const result = await main(); console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
`],
    [".ready", "ready\n"],
  ]);
}
