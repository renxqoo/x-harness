import { expect, it } from "vitest";
import type { FileHandle } from "node:fs/promises";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFileIO } from "../create-file-io";
import { directStore } from "./direct-store";
import { fixtures, value, policy, key, hash, commit } from "./helpers";
const fixture = fixtures();

function wrap(
  handle: FileHandle,
  overrides: Partial<Record<keyof FileHandle, unknown>>,
): FileHandle {
  return new Proxy(handle, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof FileHandle];

      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it.each(["write", "sync", "zero-write", "short-write"])(
  "%s outcomes preserve retry identity and never publish half a batch",
  async (kind) => {
    const f = await fixture();
    const io = createFileIO();
    const open = io.open;
    let armed = false;
    let fired = false;
    let wrote = false;

    io.open = async (...args) => {
      const file = await open(...args);

      if (String(args[0]) !== f.file) return file;

      return wrap(file, {
        write: async (...input: [Buffer, number, number, number]) => {
          if (input[0].toString().includes('"kind":"commit"')) wrote = true;

          if (armed && !fired && kind !== "sync") {
            fired = true;

            if (kind === "write") throw new Error("disk");

            if (kind === "zero-write") return { bytesWritten: 0, buffer: input[0] };

            const buffer = input[0];
            return file.write(buffer.subarray(0, 3), 0, 3, input[3]);
          }

          return file.write(...input);
        },
        sync: async () => {
          if (armed && !fired && kind === "sync" && wrote) {
            fired = true;
            throw new Error("sync");
          }

          await file.sync();
        },
      });
    };

    const opened = await directStore(f.path, { io });

    try {
      value(await opened.storage.initialize({ namespace: key.namespace, policy }));
      value(await opened.storage.create({ ...key, origin: hash, metadata: "null" }));
      armed = true;
      const first = await opened.storage.commit(commit());
      expect(first.ok).toBe(kind === "short-write");
      expect(fired).toBe(true);
      armed = false;
      const retry = value(await opened.storage.commit(commit()));
      expect(retry.revision).toBe(1);
      expect(value(await f.storage.read(key)).head.revision).toBe(1);
    } finally {
      value(await opened.store.close());
    }
  },
);
it("rename failure leaves no target and directory-sync failure can be retried durably", async () => {
  const f = await fixture();
  const io = createFileIO();
  const rename = io.rename;
  let armed = false;
  let syncArmed = false;
  const open = io.open;
  let directorySyncs = 0;
  let published = false;

  io.rename = async (...args) => {
    if (armed && String(args[1]) === f.file) throw new Error("rename");

    const result = await rename(...args);

    if (String(args[1]) === f.file) published = true;

    return result;
  };

  io.open = async (...args) => {
    const file = await open(...args);

    if (String(args[0]) !== dirname(f.file)) return file;

    return wrap(file, {
      sync: async () => {
        directorySyncs++;

        if (syncArmed && published) {
          syncArmed = false;
          throw new Error("directory-sync");
        }

        await file.sync();
      },
    });
  };

  const opened = await directStore(f.path, { io });

  try {
    value(await opened.storage.initialize({ namespace: key.namespace, policy }));
    armed = true;
    expect(await opened.storage.create({ ...key, origin: hash, metadata: "null" })).toMatchObject({
      error: { code: "storage-unavailable" },
    });
    await expect(stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    armed = false;
    const previous = directorySyncs;
    syncArmed = true;
    expect(await opened.storage.create({ ...key, origin: hash, metadata: "null" })).toMatchObject({
      error: { code: "storage-unavailable" },
    });
    expect((await stat(f.file)).isFile()).toBe(true);
    value(await opened.storage.create({ ...key, origin: hash, metadata: "null" }));
    expect(directorySyncs).toBeGreaterThan(previous + 1);
  } finally {
    value(await opened.store.close());
  }
});
it("recursive parent creation syncs every new directory entry including its existing ancestor", async () => {
  const f = await fixture();
  const io = createFileIO();
  const open = io.open;
  const paths: string[] = [];

  io.open = async (...args) => {
    const file = await open(...args);
    return wrap(file, {
      sync: async () => {
        paths.push(String(args[0]));
        await file.sync();
      },
    });
  };

  const opened = await directStore(join(f.path, "new-parent/store"), { io });

  try {
    expect(paths).toContain(f.path);
    expect(paths).toContain(join(f.path, "new-parent"));
  } finally {
    value(await opened.store.close());
  }
});
it("same-instance unchanged heads avoid rereading old record bodies", async () => {
  const f = await fixture();
  const io = createFileIO();
  const open = io.open;
  let bytes = 0;

  io.open = async (...args) => {
    const file = await open(...args);
    return String(args[0]) !== f.file
      ? file
      : wrap(file, {
          read: async (...input: Parameters<FileHandle["read"]>) => {
            const result = await file.read(...input);
            bytes += result.bytesRead;
            return result;
          },
        });
  };

  const opened = await directStore(f.path, { io });

  try {
    value(await opened.storage.initialize({ namespace: key.namespace, policy }));
    value(await opened.storage.create({ ...key, origin: hash, metadata: "null" }));
    value(await opened.storage.commit(commit()));
    bytes = 0;
    value(await opened.storage.read(key));
    value(await opened.storage.read(key));
    expect(bytes).toBe(0);
    const second = await f.open();
    value(await second.storage.commit(commit(1, "second")));
    const prior = (await readFile(f.file)).length;
    bytes = 0;
    expect(value(await opened.storage.read(key)).head.revision).toBe(2);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(prior);
  } finally {
    value(await opened.store.close());
  }
});
it("cancellation during staging sync never crosses the later rename publication point", async () => {
  const f = await fixture();
  const io = createFileIO();
  const open = io.open;
  const controller = new AbortController();
  let armed = false;

  io.open = async (...args) => {
    const file = await open(...args);
    return String(args[0]) !== join(f.path, "pending.jsonl")
      ? file
      : wrap(file, {
          sync: async () => {
            await file.sync();

            if (armed) controller.abort();
          },
        });
  };

  const opened = await directStore(f.path, { io, signal: controller.signal });

  try {
    value(await opened.storage.initialize({ namespace: key.namespace, policy }));
    armed = true;
    expect(await opened.storage.create({ ...key, origin: hash, metadata: "null" })).toMatchObject({
      error: { code: "cancelled" },
    });
    expect(await f.storage.read(key)).toMatchObject({ error: { code: "not-found" } });
  } finally {
    value(await opened.store.close());
  }
});
it("close drains actual work, rejects queued operations and can retry a failed descriptor close", async () => {
  const f = await fixture();
  const io = createFileIO();
  const open = io.open;
  let failClose = true;

  io.open = async (...args) => {
    const file = await open(...args);
    return String(args[0]).endsWith("store.lock")
      ? wrap(file, {
          close: async () => {
            if (failClose) {
              failClose = false;
              throw new Error("close");
            }

            await file.close();
          },
        })
      : file;
  };

  const opened = await directStore(f.path, { io });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const active = opened.store.run(undefined, async () => {
    started();
    await new Promise<void>((done) => {
      release = done;
    });
    return { ok: true, value: undefined };
  });
  await ready;
  const queued = opened.store.run(undefined, async () => ({ ok: true, value: undefined }));
  let closed = false;
  const closing = opened.store.close().then((result) => {
    closed = true;
    return result;
  });
  expect(await queued).toMatchObject({ error: { code: "cancelled" } });
  expect(closed).toBe(false);
  release();
  value(await active);
  expect(await closing).toMatchObject({ error: { code: "storage-unavailable" } });
  value(await opened.store.close());
  value(await opened.store.close());
  expect(
    await opened.store.run(undefined, async () => ({ ok: true, value: undefined })),
  ).toMatchObject({ error: { code: "closed" } });
});
it.each(["record", "footer"])(
  "cancellation at the %s boundary respects the commit confirmation phase",
  async (phase) => {
    const f = await fixture();
    const io = createFileIO();
    const open = io.open;
    const controller = new AbortController();
    let footerWritten = false;

    io.open = async (...args) => {
      const file = await open(...args);

      if (String(args[0]) !== f.file) return file;

      return wrap(file, {
        write: async (...input: [Buffer, number, number, number]) => {
          const result = await file.write(...input);

          if (input[0].toString().includes('"kind":"commit"')) footerWritten = true;
          else if (phase === "record") controller.abort();

          return result;
        },
        sync: async () => {
          if (phase === "footer" && footerWritten) controller.abort();

          await file.sync();
        },
      });
    };

    const opened = await directStore(f.path, { io, signal: controller.signal });

    try {
      value(await opened.storage.initialize({ namespace: key.namespace, policy }));
      value(await opened.storage.create({ ...key, origin: hash, metadata: "null" }));
      const result = await opened.storage.commit(commit());
      expect(controller.signal.aborted).toBe(true);
      expect(result.ok).toBe(phase === "footer");

      if (phase === "record") expect(result).toMatchObject({ error: { code: "cancelled" } });

      expect(value(await f.storage.read(key)).head.revision).toBe(phase === "footer" ? 1 : 0);
    } finally {
      value(await opened.store.close());
    }
  },
);
