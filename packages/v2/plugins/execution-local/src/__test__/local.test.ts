import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import { execution } from "../../../execution/src/index";
import { createLocalExecutionPlugin } from "../index";

function value<T, E>(result: Result<T, E>) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

async function world(limits: Parameters<typeof createLocalExecutionPlugin>[0]["limits"] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "xh-local-test-"));
  const host = value(createHost({ limits: { callTimeoutMs: 3000, closeTimeoutMs: 1000 } }));

  try {
    value(
      await host.install([
        value(
          createLocalExecutionPlugin({
            profiles: {
              workspace: { cwd: directory, env: { CUSTOM: "frozen" }, allowEnv: ["CUSTOM"] },
            },
            limits,
          }),
        ),
      ]),
    );
    return {
      directory,
      host,
      service: value(host.use(execution)),
      async close() {
        value(await host.close());
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await host.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

it("local execution freezes argv cwd and the complete environment without inheriting host secrets", async () => {
  const w = await world();
  const key = "XH_EXECUTION_SECRET";
  const previous = process.env[key];

  try {
    const target = value(await w.service.prepare({ profile: "workspace", argv: ["/usr/bin/env"] }));
    process.env[key] = "private-secret";
    const output = value(await w.service.run({ target }));
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("CUSTOM=frozen");
    expect(output.stdout).not.toContain(key);
    expect(target.restrictions.isolation).toBe("none");
    expect(target.resources).toEqual([
      { domain: "filesystem", path: [], mode: "write", scope: "subtree" },
    ]);
    expect(await w.service.run({ target })).toMatchObject({ ok: false, error: { code: "closed" } });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;

    await w.close();
  }
});
it("local commands report nonzero exits and output in a single result", async () => {
  const w = await world();

  try {
    const target = value(
      await w.service.prepare({
        profile: "workspace",
        argv: ["/bin/sh", "-c", "printf hello; printf error >&2; exit 7"],
      }),
    );
    expect(value(await w.service.run({ target }))).toEqual({
      exitCode: 7,
      stdout: "hello",
      stderr: "error",
    });
  } finally {
    await w.close();
  }
});
it.each([
  {},
  { profile: "absent", argv: ["/bin/echo"] },
  { profile: "workspace", argv: ["echo"] },
  { profile: "workspace", argv: [] },
  { profile: "workspace", argv: ["/bin/echo"], env: { PATH: "/tmp" } },
  { profile: "workspace", argv: ["/bin/echo"], cwd: "/" },
])("bad local targets fail safely %#", async (input) => {
  const w = await world();

  try {
    expect((await w.service.prepare(input as never)).ok).toBe(false);
  } finally {
    await w.close();
  }
});
it("executable symlink replacement after preparation fails closed", async () => {
  const w = await world();

  try {
    const executable = join(w.directory, "command");
    await symlink("/bin/echo", executable);
    const target = value(
      await w.service.prepare({ profile: "workspace", argv: [executable, "safe"] }),
    );
    await unlink(executable);
    await symlink("/usr/bin/true", executable);
    expect(await w.service.run({ target })).toMatchObject({
      ok: false,
      error: { code: "target-changed" },
    });
  } finally {
    await w.close();
  }
});
it("output limits terminate the process and release actual owned work", async () => {
  const w = await world({ maxOutputBytes: 16 });

  try {
    const target = value(
      await w.service.prepare({
        profile: "workspace",
        argv: ["/bin/sh", "-c", "printf 12345678901234567890"],
      }),
    );
    expect(await w.service.run({ target })).toMatchObject({
      ok: false,
      error: { code: "output-limit" },
    });
    await expect
      .poll(() => ({ calls: w.host.inspect().activeCalls, tasks: w.host.inspect().activeTasks }))
      .toEqual({ calls: 0, tasks: 0 });
  } finally {
    await w.close();
  }
});
it("cancellation drains a running process group before its owned tasks finish", async () => {
  const w = await world();

  try {
    const target = value(
      await w.service.prepare({
        profile: "workspace",
        argv: ["/bin/sh", "-c", "trap '' TERM; sleep 30"],
      }),
    );
    const signal = new AbortController();
    const pending = w.service.run({ target, signal: signal.signal });
    await expect.poll(() => w.host.inspect().activeTasks).toBeGreaterThan(0);
    signal.abort();
    expect((await pending).ok).toBe(false);
    await expect
      .poll(() => ({ calls: w.host.inspect().activeCalls, tasks: w.host.inspect().activeTasks }), {
        timeout: 2000,
      })
      .toEqual({ calls: 0, tasks: 0 });
  } finally {
    await w.close();
  }
});
it("executable changes preserve inode identity checks and reject changed contents", async () => {
  const w = await world();

  try {
    const program = join(w.directory, "script");
    await writeFile(program, "#!/bin/sh\nprintf safe", { mode: 493 });
    const target = value(await w.service.prepare({ profile: "workspace", argv: [program] }));
    await writeFile(program, "#!/bin/sh\nprintf changed");
    expect(await w.service.run({ target })).toMatchObject({
      ok: false,
      error: { code: "target-changed" },
    });
  } finally {
    await w.close();
  }
});
it("the complete merged environment obeys its budget", async () => {
  const w = await world();

  try {
    const target = await w.service.prepare({
      profile: "workspace",
      argv: ["/usr/bin/env"],
      env: { CUSTOM: "x".repeat(16300) },
    });
    expect(target).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  } finally {
    await w.close();
  }
});
it("local profiles reject network restrictions they cannot enforce", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xh-local-config-")),
    host = value(createHost());

  try {
    const plugin = value(
      createLocalExecutionPlugin({
        profiles: { workspace: { cwd: directory, allowedDomains: [] } },
      }),
    );
    expect((await host.install([plugin])).ok).toBe(false);
  } finally {
    value(await host.close());
    await rm(directory, { recursive: true, force: true });
  }
});
it("an oversized static environment cannot install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xh-local-env-")),
    host = value(createHost());

  try {
    const plugin = value(
      createLocalExecutionPlugin({
        profiles: { workspace: { cwd: directory, env: { LARGE: "x".repeat(16384) } } },
      }),
    );
    expect((await host.install([plugin])).ok).toBe(false);
  } finally {
    value(await host.close());
    await rm(directory, { recursive: true, force: true });
  }
});
it("provider capacity remains occupied until cancelled commands actually stop", async () => {
  const w = await world({ maxActiveRequests: 1 });

  try {
    const a = value(
        await w.service.prepare({
          profile: "workspace",
          argv: ["/bin/sh", "-c", "trap '' TERM; printf ready; sleep 30"],
        }),
      ),
      b = value(await w.service.prepare({ profile: "workspace", argv: ["/bin/echo", "next"] }));
    const abort = new AbortController();
    const pending = w.service.run({ target: a, signal: abort.signal });
    await expect.poll(() => w.host.inspect().activeTasks).toBeGreaterThan(0);
    expect(await w.service.run({ target: b })).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    abort.abort();
    expect((await pending).ok).toBe(false);
    await expect.poll(() => w.host.inspect().activeTasks).toBe(0);
    expect(await w.service.run({ target: b })).toMatchObject({
      ok: true,
      value: { stdout: "next\n" },
    });
  } finally {
    await w.close();
  }
});
