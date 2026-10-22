import { afterEach, expect, it } from "vitest";
import { defineService } from "../../index";
import type { CoreFault, Diagnostic, Host, Result } from "../../index";
import { clock, deferred, flush, root, value } from "../../__test__/helpers";

const hosts: Host[] = [];

const create = (options?: Parameters<typeof root>[0]) => {
  const host = root(options);
  hosts.push(host);
  return host;
};

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

const service = (name: string) =>
  value(
    defineService<{ run(input: string): Promise<Result<string>> }>({ name, methods: { run: {} } }),
  );

const ok = (): Result<void> => ({ ok: true, value: undefined });

function failure(result: Result<unknown>): CoreFault {
  expect(result.ok).toBe(false);

  if (result.ok) throw new Error("Expected failure");

  return result.error;
}

function recorded(host: Host, error: CoreFault) {
  const diagnostic = host.diagnostics().find((item) => item.id === error.diagnosticId);
  expect(diagnostic).toMatchObject({ code: error.code, scopeId: error.scopeId });
  expect(diagnostic?.details).toBe(error.details);
  return diagnostic;
}

it("diagnostic samples report omitted entries while inspect keeps all bounded work", async () => {
  const time = clock();
  const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
  const gate = deferred<Result<void>>();

  for (let index = 0; index < 12; index += 1)
    value(host.startTask({ label: "界".repeat(160), run: () => gate.promise }));

  await flush();
  const closing = host.close();
  await flush();
  time.advance(10);
  const error = failure(await closing);
  expect(error.details).toMatchObject({
    work: { total: 12, omitted: 4, items: expect.any(Array) },
  });
  const details = error.details as { work: { items: unknown[] } };
  expect(details.work.items).toHaveLength(8);
  expect(new TextEncoder().encode(JSON.stringify(error.details)).length).toBeLessThan(65536);
  expect(host.inspect().work).toHaveLength(12);
  expect(Object.isFrozen(details.work.items)).toBe(true);
  gate.resolve(ok());
  await flush();
});

it("sink mutation and reentry cannot change the returned diagnostic details", async () => {
  let host!: Host;
  const token = service("missing");
  const seen: Diagnostic[] = [];
  host = create({
    onDiagnostic(diagnostic) {
      seen.push(diagnostic);
      host.use(token);
      Reflect.set(diagnostic.details as object, "definition", "corrupt");
      throw new Error("private sink");
    },
  });
  const error = failure(await host.install([{ name: "consumer", requires: { token }, setup: ok }]));
  expect(seen).toHaveLength(1);
  expect(error.details).toEqual({ definition: "service/missing" });
  recorded(host, error);
  expect(JSON.stringify(host.diagnostics())).not.toContain("private sink");
});

it("invalid token diagnostic paths never invoke untrusted metadata getters", () => {
  const host = create();
  let reads = 0;
  const token = Object.defineProperties(
    {},
    {
      kind: {
        get() {
          reads += 1;
          throw new Error("private getter");
        },
      },
      name: {
        get() {
          reads += 1;
          throw new Error("private getter");
        },
      },
    },
  );
  expect(() => host.use(token as Parameters<Host["use"]>[0])).not.toThrow();
  expect(reads).toBe(0);
  expect(JSON.stringify(host.diagnostics())).not.toContain("private getter");
});

it.each(["scope", "plugin"] as const)(
  "late %s close completion cannot emit a second timeout diagnostic",
  async (mode) => {
    const time = clock();
    const host = create({ scheduler: time.scheduler, limits: { closeTimeoutMs: 10 } });
    const gate = deferred<Result<void>>();
    const installed = value(
      await host.install([
        {
          name: "blocked",
          setup(ctx) {
            return ctx.startTask({ label: "drain", run: () => gate.promise });
          },
        },
      ]),
    );
    await flush();
    const closing = mode === "scope" ? host.close() : host.uninstall(installed.plugins[0]!);
    await flush();
    time.advance(10);
    const error = failure(await closing);
    recorded(host, error);
    expect(host.diagnostics().filter((item) => item.code === "close-incomplete")).toHaveLength(1);
    gate.resolve(ok());
    await flush();
    expect(host.diagnostics().filter((item) => item.code === "close-incomplete")).toHaveLength(1);
  },
);

it("failed cleanup summaries sample resources and retain their failed state", async () => {
  const host = create();

  for (let index = 0; index < 10; index += 1)
    value(
      host.addCleanup(() => {
        throw new Error("private disposer");
      }),
    );

  const error = failure(await host.close());
  expect(error.details).toMatchObject({
    resources: {
      total: 10,
      omitted: 2,
      items: expect.arrayContaining([
        {
          id: expect.any(String),
          kind: "cleanup",
          state: "failed",
          owner: expect.any(Object),
          executor: expect.any(Object),
        },
      ]),
    },
  });
  recorded(host, error);
  expect(host.inspect().resources.every((resource) => resource.state === "failed")).toBe(true);
  expect(JSON.stringify(host.diagnostics())).not.toContain("private disposer");
});

it.each(["live", "closed"])(
  "retained diagnostic snapshots release retired tokens in a %s host",
  async (mode) => {
    const child = Bun.spawn(
      ["bun", new URL("./diagnostics.gc-case.ts", import.meta.url).pathname, mode],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, BUN_JSC_useJIT: "false" },
      },
    );
    const timeout = setTimeout(() => child.kill(), 5000);

    try {
      const [output, errors, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(errors).toBe("");
      expect(status).toBe(0);
      expect(JSON.parse(output)).toEqual({
        tokenCollected: true,
        kernelCollected: mode === "closed",
      });
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  },
);
