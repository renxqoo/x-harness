import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createHost } from "../../../../core/src/index";
import { createJsonlSessionPlugin } from "../../../session-jsonl/src/index";
import { createSessionPlugin, session } from "../index";
import type { SessionOptions } from "../index";
import { fixtures, value } from "./helpers";

export function listFixtures() {
  const sql = fixtures();
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  return async (kind: "sqlite" | "postgres" | "jsonl", limits?: SessionOptions["limits"]) => {
    if (kind !== "jsonl") return sql(kind, limits);

    const directory = await mkdtemp(join(tmpdir(), "session-list-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "store");
    const options = { namespace: crypto.randomUUID(), ...(limits ? { limits } : {}) };

    const open = async (override: SessionOptions = {}) => {
      const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
      cleanups.push(() => host.close());
      value(
        await host.install([
          value(createJsonlSessionPlugin({ path })),
          value(createSessionPlugin({ ...options, ...override })),
        ]),
      );
      return { host, service: value(host.use(session)) };
    };

    return { ...(await open()), open, options, directory };
  };
}
