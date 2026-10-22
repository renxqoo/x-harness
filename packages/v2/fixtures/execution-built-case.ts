import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, definePlugin } from "../core/src/index";
import type { Result } from "../core/src/index";
import * as sourceTools from "../plugins/tools/src/index";
import * as sourceScheduler from "../plugins/tool-scheduler/src/index";
import * as sourceSandbox from "../plugins/sandbox/src/index";
import { execution } from "../plugins/execution/src/index";
const builtTools = (await import(
  new URL("../plugins/tools/dist/index.js", import.meta.url).href
)) as typeof sourceTools;
const builtScheduler = (await import(
  new URL("../plugins/tool-scheduler/dist/index.js", import.meta.url).href
)) as typeof sourceScheduler;
const builtSandbox = (await import(
  new URL("../plugins/sandbox/dist/index.js", import.meta.url).href
)) as typeof sourceSandbox;
const builtExecution = (await import(
  new URL("../plugins/execution/dist/index.js", import.meta.url).href
)) as typeof import("../plugins/execution/src/index");

function value<T, E>(result: Result<T, E>) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

if (
  builtTools.tools !== sourceTools.tools ||
  builtScheduler.toolScheduler !== sourceScheduler.toolScheduler ||
  builtExecution.execution !== execution
)
  throw new Error("split public identity");

for (const ordinary of [false, true])
  for (const [toolApi, schedulerApi, sandboxApi, policyApi] of [
    [sourceTools, builtScheduler, builtSandbox, builtTools],
    [builtTools, sourceScheduler, sourceSandbox, sourceTools],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), "xh-execution-chain-")),
      host = value(
        createHost({ limits: { callTimeoutMs: 15000, closeTimeoutMs: 3000, maxCallDepth: 256 } }),
      );
    let authors = 0,
      permissions = 0;

    try {
      await writeFile(join(directory, "document.txt"), "stored-value");
      const tool = ordinary
        ? definePlugin({
            name: "ordinary-reader",
            requires: {
              toolCatalog: toolApi.toolCatalog,
              toolPreparation: toolApi.toolPreparation,
              toolDispatch: toolApi.toolDispatch,
            },
            setup(ctx) {
              const entry = {
                signal: ctx.signal,
                tool: {
                  name: "read",
                  concurrency: 2,
                  inputSchema: {
                    type: "object" as const,
                    properties: { allowed: { type: "boolean" } },
                    required: ["allowed"],
                    additionalProperties: false,
                  },
                },
              };
              const catalog = ctx.middleware("toolCatalog", (query, next) => {
                const sent = query.visit(entry);
                return sent.ok ? next(query) : sent;
              });

              if (!catalog.ok) return catalog;

              const prepare = ctx.middleware("toolPreparation", (request, next) =>
                request.ownerSignal === ctx.signal && request.name === "read"
                  ? {
                      ok: true,
                      value: {
                        actions: { allowed: request.input.allowed === true },
                        execution: {
                          profile: "workspace",
                          argv: ["/bin/cat", join(directory, "document.txt")],
                        },
                      },
                    }
                  : next(request),
              );

              if (!prepare.ok) return prepare;

              return ctx.middleware("toolDispatch", async (request, next) => {
                if (request.ownerSignal !== ctx.signal || request.name !== "read")
                  return next(request);

                authors++;
                const output = await request.execution!.run();
                return output.ok
                  ? { ok: true, value: { content: [{ type: "text", text: output.value.stdout }] } }
                  : {
                      ok: false,
                      error: {
                        source: "tools",
                        code: "execution-failed",
                        message: "execution-failed",
                      },
                    };
              });
            },
          })
        : value(
            toolApi.createToolPlugin({
              name: "read",
              concurrency: 2,
              inputSchema: {
                type: "object",
                properties: { allowed: { type: "boolean" } },
                required: ["allowed"],
                additionalProperties: false,
              },
              prepare: async (input) => ({
                ok: true,
                value: {
                  actions: { allowed: input.allowed },
                  execution: {
                    profile: "workspace",
                    argv: ["/bin/cat", join(directory, "document.txt")],
                  },
                },
              }),
              async execute(_input, call) {
                authors++;
                const result = await call.execution!.run();

                if (!result.ok)
                  return {
                    ok: false,
                    error: {
                      source: "tools",
                      code: "execution-failed",
                      message: "execution-failed",
                    },
                  };

                return {
                  ok: true,
                  value: { content: [{ type: "text", text: result.value.stdout }] },
                };
              },
            }),
          );
      const policy = ordinary
        ? definePlugin({
            name: "ordinary-policy",
            requires: {
              toolAccess: policyApi.toolAccess,
              toolExecutionAccess: policyApi.toolExecutionAccess,
            },
            setup(ctx) {
              const base = ctx.guard("toolAccess", () => ({ ok: true, value: { kind: "allow" } }));

              if (!base.ok) return base;

              return ctx.guard("toolExecutionAccess", (authorization) => {
                permissions++;
                const plan = authorization.plan;

                if (
                  !Object.isFrozen(plan.execution?.argv) ||
                  plan.initiator.id !== "host" ||
                  !plan.resources.some((r) => r.domain === "filesystem")
                )
                  throw new Error("incomplete plan");

                return plan.actions.allowed
                  ? authorization.allow({ signal: ctx.signal })
                  : { ok: true, value: { kind: "deny", reason: "not-approved" } };
              });
            },
          })
        : value(
            policyApi.createToolPolicyPlugin({
              name: "review",
              async authorize(plan) {
                permissions++;

                if (
                  !Object.isFrozen(plan.execution?.argv) ||
                  plan.initiator.id !== "host" ||
                  !plan.resources.some((r) => r.domain === "filesystem")
                )
                  throw new Error("incomplete plan");

                return { ok: true, value: { kind: plan.actions.allowed ? "allow" : "deny" } };
              },
            }),
          );
      value(
        await host.install([
          value(toolApi.createToolsPlugin({ access: ordinary ? "required" : "allow" })),
          value(
            schedulerApi.createToolSchedulerPlugin({ access: "allow", limits: { concurrency: 2 } }),
          ),
          value(sandboxApi.createSandboxPlugin({ profiles: { workspace: { cwd: directory } } })),
          policy,
          tool,
        ]),
      );
      const service = value(host.use(schedulerApi.toolScheduler));
      const report = value(
        await service.batch({
          calls: [
            { name: "read", callId: "allowed", input: { allowed: true } },
            { name: "read", callId: "denied", input: { allowed: false } },
            { name: "read", callId: "blocked", input: { allowed: true }, dependsOn: ["denied"] },
          ],
        }),
      );

      if (process.platform === "darwin") {
        const first = value(report.results[0]!.result);

        if (first.content[0]?.type !== "text" || first.content[0].text !== "stored-value")
          throw new Error("process result lost");
      } else if (report.results[0]!.result.ok)
        throw new Error("unsupported sandbox did not fail closed");

      if (
        report.results[1]!.result.ok ||
        report.results[2]!.result.ok ||
        authors !== 1 ||
        permissions !== 2
      )
        throw new Error("permission or dependency handling failed");

      if (host.inspect().activeTasks !== 0) throw new Error("owned work not drained");
    } finally {
      value(await host.close());
      await rm(directory, { recursive: true, force: true });
    }
  }

process.stdout.write("execution chain source/dist passed\n");
