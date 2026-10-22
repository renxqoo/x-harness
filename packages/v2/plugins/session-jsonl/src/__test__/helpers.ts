import { afterEach } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import type { Result } from "../../../../core/src/index";
import {
  sessionStorage,
  defaultSessionLimits,
  storagePolicyKeys,
} from "../../../session/src/storage";
import type { StoragePolicy } from "../../../session/src/storage";
import { sessionPath } from "../store-path";
import { createJsonlSessionPlugin } from "../index";

export function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  return result.value;
}

export const policy = Object.fromEntries(
  storagePolicyKeys.map((key) => [key, defaultSessionLimits[key]]),
) as unknown as StoragePolicy;
export const key = { namespace: "default", id: "one" };
export const hash = "a".repeat(64);

export function commit(
  revision = 0,
  commitId = `c${revision}`,
  nodes = [{ position: revision + 1, seq: revision + 1 }],
) {
  return {
    ...key,
    expectedRevision: revision,
    commitId,
    fingerprint: hash,
    records: [{ seq: revision + 1, time: revision, json: "opaque", bytes: 6 }],
    nodes,
  };
}

export function fixtures() {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  return async () => {
    const path = await realpath(await mkdtemp(join(tmpdir(), "session-jsonl-")));
    cleanups.push(() => rm(path, { recursive: true, force: true }));

    const open = async () => {
      const host = value(createHost({ limits: { callTimeoutMs: 30000, closeTimeoutMs: 30000 } }));
      cleanups.push(() => host.close());
      value(await host.install([value(createJsonlSessionPlugin({ path }))]));
      return { host, storage: value(host.use(sessionStorage)) };
    };

    return { ...(await open()), open, path, file: sessionPath(path, key) };
  };
}
