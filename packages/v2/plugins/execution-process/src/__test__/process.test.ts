import { expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../index";

const input = () => ({
  argv: ["/bin/echo", "hello"],
  cwd: tmpdir(),
  env: { PATH: "/usr/bin:/bin" },
  signal: new AbortController().signal,
  maxOutputBytes: 65536,
});

it.each([
  null,
  {},
  { ...input(), signal: {} },
  { ...input(), argv: [] },
  { ...input(), argv: ["echo"] },
  { ...input(), env: { INVALID: 2 } },
  { ...input(), env: { "A=B": "x" } },
  { ...input(), maxOutputBytes: 0 },
  { ...input(), stdin: "x".repeat(262145) },
  { ...input(), onMessage: 2 },
  { ...input(), cwd: "relative" },
])("invalid process options fail safely %#", async (value) => {
  expect(await runProcess(value as never)).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
it("already cancelled commands do not start", async () => {
  const abort = new AbortController();
  abort.abort();
  expect(await runProcess({ ...input(), signal: abort.signal })).toMatchObject({
    ok: false,
    error: { code: "cancelled" },
  });
});
it("missing programs fail without leaking spawn errors", async () => {
  expect(await runProcess({ ...input(), argv: ["/xh-no-program"] })).toMatchObject({
    ok: false,
    error: { code: "execution-failed" },
  });
});
it("stdin writing and stdout draining proceed concurrently", async () => {
  const result = await runProcess({
    ...input(),
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(65536));for await (const x of Bun.stdin.stream()){}",
    ],
    stdin: "y".repeat(131072),
    maxOutputBytes: 65536,
  });
  expect(result).toMatchObject({ ok: true, value: { exitCode: 0, stdout: "x".repeat(65536) } });
});
it("decoded replacement bytes obey the same output budget", async () => {
  expect(
    await runProcess({
      ...input(),
      argv: [process.execPath, "-e", "process.stdout.write(new Uint8Array([255,255]))"],
      maxOutputBytes: 2,
    }),
  ).toMatchObject({ ok: false, error: { code: "output-limit" } });
});
it("a closed output pipe does not release a still running owned process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xh-group-test-"));

  try {
    const pidFile = join(directory, "pid"),
      heartbeat = join(directory, "heartbeat");
    const child = `process.on('SIGTERM',()=>{});await Bun.write(${JSON.stringify(heartbeat)},'0');await Bun.write(${JSON.stringify(pidFile)},String(process.pid));for(let i=1;;i++){await Bun.sleep(5);await Bun.write(${JSON.stringify(heartbeat)},String(i))}`;
    const parent = `Bun.spawn([process.execPath,'-e',${JSON.stringify(child)}],{stdout:'ignore',stderr:'ignore'});while(!await Bun.file(${JSON.stringify(pidFile)}).exists())await Bun.sleep(1);process.exit(0)`;
    const result = await runProcess({ ...input(), argv: [process.execPath, "-e", parent] });
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    const pid = Number(await readFile(pidFile, "utf8"));
    const stopped = await readFile(heartbeat, "utf8");
    await Bun.sleep(100);
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 1000 },
      )
      .toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("throwing IPC consumers fail neutrally and drain their worker", async () => {
  const result = await runProcess({
    ...input(),
    argv: [process.execPath, "-e", "process.send?.({hello:true});await Bun.sleep(30000)"],
    onMessage() {
      throw new Error("secret");
    },
  });
  expect(result).toMatchObject({ ok: false, error: { code: "execution-failed" } });
  expect(JSON.stringify(result)).not.toContain("secret");
});
