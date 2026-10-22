import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject } from "../index";
import { runCreate } from "../cli";

it("generated local SDK projects typecheck, test, build and run through real child processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-"));

  try {
    const directory = join(root, "plugin with spaces");
    const created = await createProject({ directory, name: "greeting" });
    expect(created.ok).toBe(true);

    if (!created.ok) return;

    expect(created.value.files.at(-1)).toBe(".ready");
    expect(await readFile(join(directory, ".ready"), "utf8")).toBe("ready\n");

    for (const command of [
      ["run", "typecheck"],
      ["run", "test"],
      ["run", "build"],
      ["run", "start"],
      ["dist/main.js"],
    ]) {
      const child = Bun.spawn(["bun", ...command], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ command, status, stdout, stderr }).toMatchObject({ status: 0 });

      if (command.includes("start") || command[0] === "dist/main.js")
        expect(stdout.trim()).toBe('{"ok":true,"value":"Hello, world"}');
    }

    const before = await readFile(join(directory, "plugin.ts"), "utf8");
    expect(await createProject({ directory, name: "other" })).toMatchObject({
      ok: false,
      error: { code: "target-exists" },
    });
    expect(await readFile(join(directory, "plugin.ts"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("concurrent generators cannot overwrite another generator or follow a target symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-race-"));

  try {
    const directory = join(root, "same");
    const results = await Promise.all([
      createProject({ directory, name: "first" }),
      createProject({ directory, name: "second" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "target-exists" } },
    ]);
    const link = join(root, "link");
    await symlink(directory, link);
    expect(await createProject({ directory: link, name: "third" })).toMatchObject({
      ok: false,
      error: { code: "target-exists" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("invalid options fail before creating directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-input-"));

  try {
    for (const options of [
      null,
      {},
      { directory: root, name: "../bad" },
      { directory: root, name: "Upper" },
      { directory: "relative", name: "good" },
      { directory: root + "/", name: "good" },
      { directory: join(root, "missing", "target"), name: "good" },
      { directory: join(root, "target"), name: "good", sdk: "relative" },
      { directory: join(root, "target"), name: "good", sdk: root },
      { directory: join(root, "target"), name: "good", extra: true },
    ])
      expect((await createProject(options as Parameters<typeof createProject>[0])).ok).toBe(false);

    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("CLI validates argument count and reports failures and generated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-create-cli-"));

  try {
    const cli = new URL("../cli.ts", import.meta.url).pathname;

    for (const args of [
      [],
      ["-x", "name"],
      [join(root, "bad"), "INVALID"],
      [join(root, "generated"), "cli-demo"],
    ]) {
      const child = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      if (args.at(-1) === "cli-demo") {
        expect(status).toBe(0);
        expect(JSON.parse(stdout).files).toContain(".ready");
        expect(stderr).toBe("");
      } else {
        expect(status).toBe(1);
        expect(stderr.length).toBeGreaterThan(0);
      }
    }

    expect(await runCreate([join(root, "generated"), "again"])).toBe(1);
    expect(
      await runCreate([
        join(root, "direct"),
        "direct-demo",
        new URL("../../../", import.meta.url).pathname,
      ]),
    ).toBe(0);
    expect(await readFile(join(root, "direct", ".ready"), "utf8")).toBe("ready\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
