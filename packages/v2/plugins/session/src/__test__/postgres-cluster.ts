import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function command(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30000);

  try {
    const errors = await new Response(child.stderr).text();

    if (await child.exited) throw new Error(`Fixture command failed: ${args[0]} ${errors}`);
  } finally {
    clearTimeout(timer);
  }
}

export function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port!;
  listener.stop(true);
  return port;
}

export async function startCluster() {
  const directory = await mkdtemp(join(tmpdir(), "session-postgres-"));
  const data = join(directory, "data");
  const port = freePort();
  let running = false;

  try {
    await command(["initdb", "-D", data, "-A", "trust", "-U", "session_test", "--no-locale"]);
    const configuration = join(data, "postgresql.conf");
    await writeFile(
      configuration,
      (await readFile(configuration, "utf8")) +
        `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${directory}'\nmax_connections=64\n`,
    );
    await command(["pg_ctl", "-D", data, "-l", join(directory, "postgres.log"), "start", "-w"]);
    running = true;
  } catch (error) {
    try {
      await command(["pg_ctl", "-D", data, "stop", "-w", "-m", "immediate"]);
    } catch {}

    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const stop = async () => {
    if (running) {
      await command(["pg_ctl", "-D", data, "stop", "-w", "-m", "immediate"]);
      running = false;
    }
  };

  return {
    directory,
    data,
    port,
    url: `postgres://session_test@127.0.0.1:${port}/postgres`,
    stop,
    async close() {
      try {
        await stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export async function startReplica(sourceUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "session-replica-"));
  const data = join(directory, "data");
  const port = freePort();
  let running = false;

  try {
    await command([
      "pg_basebackup",
      "-d",
      sourceUrl,
      "-D",
      data,
      "-R",
      "-X",
      "stream",
      "--checkpoint=fast",
    ]);
    await command([
      "pg_ctl",
      "-D",
      data,
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-p ${port} -k ${directory}`,
      "start",
      "-w",
    ]);
    running = true;
  } catch (error) {
    try {
      await command(["pg_ctl", "-D", data, "stop", "-w", "-m", "immediate"]);
    } catch {}

    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    url: `postgres://session_test@127.0.0.1:${port}/postgres`,
    promote: () => command(["pg_ctl", "-D", data, "promote", "-w"]),
    async close() {
      try {
        if (running) {
          await command(["pg_ctl", "-D", data, "stop", "-w", "-m", "immediate"]);
          running = false;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
