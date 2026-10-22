import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { readWorkerInput } from "./read-worker-input";
import { restrictCommand } from "./restrict-command";
import { systemReadRoots } from "./system-read-roots";
import { createRules } from "./create-rules";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

async function run() {
  let initialized = false;

  try {
    const reader = Bun.stdin.stream().getReader();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;

        bytes += chunk.value.byteLength;

        if (bytes > 262144) throw new Error("input");

        text += decoder.decode(chunk.value, { stream: true });
      }

      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    const parsed = readWorkerInput(JSON.parse(text));

    if (!parsed) throw new Error("input");

    const { target, profile, work, jobRoot, protectedPaths } = parsed;
    const reads = [
      ...systemReadRoots,
      ...profile.readRoots,
      ...profile.writeRoots,
      work,
      target.argv[0]!,
    ];
    await SandboxManager.initialize(
      {
        network: {
          allowedDomains: [...profile.allowedDomains],
          deniedDomains: [],
          strictAllowlist: true,
        },
        filesystem: {
          denyRead: ["/"],
          allowRead: reads,
          allowWrite: [...profile.writeRoots, work],
          denyWrite: protectedPaths,
        },
      },
      undefined,
      false,
    );
    initialized = true;
    const env: Record<string, string> = { ...target.env, TMPDIR: work };
    const proxyKeys = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ];
    const command = [
      "exec",
      "/usr/bin/env",
      "-i",
      ...Object.entries(env).map(([k, v]) => quote(k + "=" + v)),
      ...proxyKeys.map((key) =>
        key === "NO_PROXY" || key === "no_proxy" ? key + "=" : key + '="${' + key + '-}"',
      ),
      ...target.argv.map(quote),
    ].join(" ");
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/sh");

    if (wrapped.argv.length !== 3 || wrapped.argv[0] !== "/bin/sh" || wrapped.argv[1] !== "-c")
      throw new Error("shape");

    const restricted = restrictCommand(
      wrapped.argv[2]!,
      createRules({
        readRoots: reads,
        writeRoots: profile.writeRoots,
        scratch: work,
        jobRoot,
        protectedPaths,
        network: profile.allowedDomains.length > 0,
      }),
    );

    if (!restricted.ok) throw new Error("shape");

    const child = Bun.spawn(["/bin/sh", "-c", restricted.value], {
      cwd: target.cwd,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        LANG: "C.UTF-8",
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    await SandboxManager.reset();
    initialized = false;
    process.send?.({ kind: "done", exitCode });
  } catch {
    if (initialized) await SandboxManager.reset().catch(() => undefined);

    process.send?.({ kind: "failed", code: "backend-unavailable" });
  }
}

await run();
