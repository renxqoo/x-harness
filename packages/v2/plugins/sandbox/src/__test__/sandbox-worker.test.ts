import { afterEach, beforeEach, expect, it, vi } from "vitest";

const manager = vi.hoisted(() => ({
  initialize: vi.fn<(...args: unknown[]) => Promise<void>>(),
  wrapWithSandboxArgv: vi.fn<(command: string, shell: string) => Promise<{ argv: string[] }>>(),
  reset: vi.fn<() => Promise<void>>(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: manager }));

const input = () => ({
  target: {
    cwd: "/workspace",
    argv: ["/bin/echo", "a'b", "$(touch /unwanted)"],
    env: { VALUE: "space and 'quote'", HTTP_PROXY: "untrusted" },
  },
  profile: {
    readRoots: ["/workspace/input"],
    writeRoots: ["/workspace/output"],
    allowedDomains: [] as string[],
  },
  work: "/scratch/job/work",
  jobRoot: "/scratch/job",
  protectedPaths: ["/sdk"],
});

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const send = vi.fn<(message: unknown) => boolean>();
const spawn = vi.fn<(argv: unknown, options: unknown) => { exited: Promise<number> }>();
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
let stream: ReadableStream<Uint8Array<ArrayBuffer>>;

function feed(chunks: readonly Uint8Array<ArrayBuffer>[]) {
  stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);

      controller.close();
    },
  });
}

async function run(raw: unknown = input()) {
  feed([new TextEncoder().encode(JSON.stringify(raw))]);
  await import("../sandbox-worker");
}

beforeEach(() => {
  vi.resetModules();
  manager.initialize.mockReset().mockResolvedValue(undefined);
  manager.reset.mockReset().mockResolvedValue(undefined);
  manager.wrapWithSandboxArgv.mockReset().mockImplementation(async (command) => ({
    argv: ["/bin/sh", "-c", "/usr/bin/sandbox-exec -p '(version 1)' /bin/sh -c " + quote(command)],
  }));
  send.mockReset().mockReturnValue(true);
  spawn.mockReset().mockImplementation(() => ({ exited: Promise.resolve(7) }));
  process.send = send as typeof process.send;
  vi.spyOn(Bun.stdin, "stream").mockImplementation(() => stream);
  vi.spyOn(Bun, "spawn").mockImplementation(
    (...args) => spawn(...args) as ReturnType<typeof Bun.spawn>,
  );
});

afterEach(() => {
  if (originalSend) Object.defineProperty(process, "send", originalSend);
  else delete process.send;

  vi.restoreAllMocks();
});

it("worker applies filesystem and network restrictions, quotes arguments and releases the backend before replying", async () => {
  await run();

  expect(manager.initialize).toHaveBeenCalledWith(
    {
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: ["/"],
        allowRead: expect.arrayContaining([
          "/workspace/input",
          "/workspace/output",
          "/scratch/job/work",
          "/bin/echo",
        ]),
        allowWrite: ["/workspace/output", "/scratch/job/work"],
        denyWrite: ["/sdk"],
      },
    },
    undefined,
    false,
  );

  const command = manager.wrapWithSandboxArgv.mock.calls[0]![0];

  expect(command).toContain(quote("VALUE=space and 'quote'"));
  expect(command).toContain(quote("TMPDIR=/scratch/job/work"));
  expect(command).toContain(quote("a'b"));
  expect(command).toContain(quote("$(touch /unwanted)"));
  expect(command).toContain('HTTP_PROXY="${HTTP_PROXY-}"');
  expect(command.indexOf('HTTP_PROXY="${HTTP_PROXY-}"')).toBeGreaterThan(
    command.indexOf(quote("HTTP_PROXY=untrusted")),
  );
  expect(command).toContain("NO_PROXY=");
  expect(command).toContain("no_proxy=");
  expect(spawn).toHaveBeenCalledWith(
    ["/bin/sh", "-c", expect.stringContaining("(deny network*)")],
    {
      cwd: "/workspace",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "C.UTF-8",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const spawned = spawn.mock.calls[0]![0] as readonly string[];

  expect(spawned[2]).toContain('(deny file-write* (subpath "/sdk"))');
  expect(manager.reset).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "done", exitCode: 7 });
  expect(manager.reset.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  expect(stream.locked).toBe(false);
});

it("worker decodes UTF-8 across chunk boundaries and preserves a requested network allowlist", async () => {
  const raw = input();
  raw.target.argv = ["/bin/echo", "你好"];
  raw.profile.allowedDomains = ["example.com"];
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const start = bytes.findIndex((value) => value > 127);

  feed([bytes.slice(0, start + 1), bytes.slice(start + 1, start + 2), bytes.slice(start + 2)]);
  await import("../sandbox-worker");

  expect(manager.wrapWithSandboxArgv.mock.calls[0]![0]).toContain("'你好'");
  expect(manager.initialize.mock.calls[0]![0]).toMatchObject({
    network: { allowedDomains: ["example.com"], strictAllowlist: true },
  });
  const spawned = spawn.mock.calls[0]![0] as readonly string[];

  expect(spawned[2]).not.toContain("(deny network*)");
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "done", exitCode: 7 });
  expect(stream.locked).toBe(false);
});

it.each([null, {}, { ...input(), work: "relative" }])(
  "malformed worker control fails before initializing or spawning %#",
  async (raw) => {
    await run(raw);

    expect(manager.initialize).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.reset).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
    expect(stream.locked).toBe(false);
  },
);

it.each(["{", "x".repeat(262145)])(
  "invalid JSON and oversized control release the reader without starting the backend %#",
  async (text) => {
    feed([new TextEncoder().encode(text)]);
    await import("../sandbox-worker");

    expect(manager.initialize).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
    expect(stream.locked).toBe(false);
  },
);

it("a failed control stream releases its reader and returns a neutral failure", async () => {
  stream = new ReadableStream({
    start(controller) {
      controller.error(new Error("private read detail"));
    },
  });
  await import("../sandbox-worker");

  expect(manager.initialize).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
  expect(stream.locked).toBe(false);
});

it("backend initialization failure prevents command execution and does not reset an uninitialized backend", async () => {
  manager.initialize.mockRejectedValueOnce(new Error("private backend detail"));
  await run();

  expect(manager.wrapWithSandboxArgv).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(manager.reset).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
});

it.each([
  { argv: [] },
  { argv: ["/bin/bash", "-c", "/usr/bin/sandbox-exec -p '(version 1)' /bin/echo"] },
  { argv: ["/bin/sh", "-x", "/usr/bin/sandbox-exec -p '(version 1)' /bin/echo"] },
  { argv: ["/bin/sh", "-c", "exec /bin/echo unsafe"] },
])(
  "an unrecognized backend wrapper is never spawned and resets the initialized backend %#",
  async ({ argv }) => {
    manager.wrapWithSandboxArgv.mockResolvedValueOnce({ argv });
    await run();

    expect(spawn).not.toHaveBeenCalled();
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
  },
);

it.each(["wrapper", "spawn", "exit", "reset"])(
  "a backend %s rejection returns one neutral failure and releases initialized resources",
  async (stage) => {
    const error = new Error("private backend detail");

    if (stage === "wrapper") manager.wrapWithSandboxArgv.mockRejectedValueOnce(error);
    else if (stage === "spawn")
      spawn.mockImplementationOnce(() => {
        throw error;
      });
    else if (stage === "exit")
      spawn.mockImplementationOnce(() => ({ exited: Promise.reject(error) }));
    else manager.reset.mockRejectedValueOnce(error);

    await run();

    expect(manager.reset).toHaveBeenCalledTimes(stage === "reset" ? 2 : 1);
    expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
  },
);

it("cleanup rejection does not leak backend diagnostics or reject the worker module", async () => {
  manager.wrapWithSandboxArgv.mockRejectedValueOnce(new Error("private wrapper detail"));
  manager.reset.mockRejectedValueOnce(new Error("private cleanup detail"));
  await run();

  expect(manager.reset).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "failed", code: "backend-unavailable" });
});

it("worker execution without an IPC receiver still releases the backend", async () => {
  process.send = undefined;
  await run();

  expect(spawn).toHaveBeenCalledOnce();
  expect(manager.reset).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
