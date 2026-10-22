import { expect, it } from "vitest";
import { definePlugin, defineService } from "../../../../core/src/index";
import type { AgentLoopService } from "../index";
import { agentLoop, agentRunAccess, agentCheckpoint } from "../index";
import { createToolPlugin } from "../../../tools/src/index";
import { world, value, request, answer, toolTurn } from "./helpers";
it("two callers sharing agent-loop retain separate trusted authorization identities", async () => {
  const a = value(defineService<AgentLoopService>({ name: "client-a", methods: { run: {} } })),
    b = value(defineService<AgentLoopService>({ name: "client-b", methods: { run: {} } }));
  const clients = [a, b].map((client, i) =>
    definePlugin({
      name: i ? "client-b" : "client-a",
      requires: { agentLoop },
      provides: { client },
      setup: (ctx) =>
        ctx.service({ client: { run: (input, call) => call.deps.agentLoop.run(input) } }),
    }),
  );
  const observed: string[] = [];
  let models = 0;
  const policy = definePlugin({
    name: "policy",
    requires: { agentRunAccess },
    setup: (ctx) =>
      ctx.guard("agentRunAccess", (input) => {
        observed.push(input.caller.origin.pluginName!);
        expect(input.caller.initiator.kind).toBe("host");
        return {
          ok: true,
          value:
            input.caller.origin.pluginName === "client-a"
              ? { kind: "allow" }
              : { kind: "deny", reason: "caller" },
        };
      }),
  });
  const f = await world({
    agent: { access: "required" },
    plugins: [policy, ...clients],
    async run(input) {
      models++;
      return answer(input);
    },
  });

  try {
    expect((await value(f.host.use(a)).run(request)).ok).toBe(true);
    expect(await value(f.host.use(b)).run(request)).toMatchObject({
      ok: false,
      error: { code: "access-denied" },
    });
    expect(observed).toEqual(["client-a", "client-a", "client-b"]);
    expect(models).toBe(1);
    expect(
      await f.service.run({ ...request, caller: { origin: { pluginName: "client-a" } } } as never),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  } finally {
    value(await f.host.close());
  }
});
it("revoking run policy after the response checkpoint blocks tool submission", async () => {
  let allowed = true,
    writes = 0;
  const policy = definePlugin({
    name: "policy",
    requires: { agentRunAccess },
    setup: (ctx) =>
      ctx.guard("agentRunAccess", () => ({
        ok: true,
        value: allowed ? { kind: "allow" } : { kind: "deny", reason: "revoked" },
      })),
  });
  const saving = definePlugin({
    name: "save",
    requires: { agentCheckpoint },
    setup: (ctx) =>
      ctx.middleware("agentCheckpoint", (input, next) => {
        if (input.phase === "response") allowed = false;

        return next(input);
      }),
  });
  const tool = value(
    createToolPlugin({
      name: "write",
      inputSchema: { type: "object" },
      async execute() {
        writes++;
        return { ok: true, value: { content: [] } };
      },
    }),
  );
  const f = await world({
    agent: { access: "required" },
    plugins: [policy, saving, tool],
    run: (input) => toolTurn(input, [{ name: "write", callId: "a" }]),
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "access-denied" },
    });
    expect(writes).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
it("removing a tool from the model context also removes its execution capability", async () => {
  let writes = 0;
  const { agentContext } = await import("../index");
  const filter = definePlugin({
    name: "filter",
    requires: { agentContext },
    setup: (ctx) =>
      ctx.middleware("agentContext", (input) => ({
        ok: true,
        value: { ...input.request, tools: [] },
      })),
  });
  const tool = value(
    createToolPlugin({
      name: "write",
      inputSchema: { type: "object" },
      async execute() {
        writes++;
        return { ok: true, value: { content: [] } };
      },
    }),
  );
  const f = await world({
    plugins: [filter, tool],
    run: (input) => toolTurn(input, [{ name: "write", callId: "a" }]),
  });

  try {
    expect(await f.service.run(request)).toMatchObject({
      ok: false,
      error: { code: "invalid-model-output" },
    });
    expect(writes).toBe(0);
  } finally {
    value(await f.host.close());
  }
});
