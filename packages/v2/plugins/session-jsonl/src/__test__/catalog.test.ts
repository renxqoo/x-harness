import { join } from "node:path";
import { encodeLine } from "../encode-line";
import { expect, it } from "vitest";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fixtures, value, policy, key, hash } from "./helpers";
import { directStore } from "./direct-store";
import { createFileIO } from "../create-file-io";
import { encodeId, decodeId } from "../encode-id";
import { sessionId } from "../store-path";
const fixture = fixtures();
it("listing parses only immutable headers while historical corruption remains visible to full reads", async () => {
  const f = await fixture();
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  const head = value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  await appendFile(f.file, `${"bad historical row".repeat(50000)}\n`);
  const io = createFileIO();
  const open = io.open;
  let bytes = 0;

  io.open = async (...args) => {
    const handle = await open(...args);

    if (String(args[0]) !== f.file) return handle;

    return new Proxy(handle, {
      get(target, key) {
        if (key === "read")
          return async (...input: Parameters<typeof handle.read>) => {
            const result = await handle.read(...input);
            bytes += result.bytesRead;
            return result;
          };

        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  const opened = await directStore(f.path, { io });

  try {
    expect(
      value(
        await opened.storage.list({ namespace: key.namespace, limit: 10, maxPageBytes: 4194304 }),
      ).sessions,
    ).toEqual([{ id: key.id, createdAt: head.createdAt, metadata: "null" }]);
    expect(bytes).toBeLessThanOrEqual(65536);
    expect(await f.storage.read(key)).toMatchObject({ error: { code: "storage-corrupt" } });
  } finally {
    value(await opened.store.close());
  }
});
it("catalog rejects corrupt headers without silently hiding a session", async () => {
  const f = await fixture();
  value(await f.storage.initialize({ namespace: key.namespace, policy }));
  value(await f.storage.create({ ...key, origin: hash, metadata: "null" }));
  const raw = await readFile(f.file);
  await writeFile(f.file, raw.subarray(0, raw.length - 1));
  expect(
    await f.storage.list({ namespace: key.namespace, limit: 10, maxPageBytes: 4194304 }),
  ).toMatchObject({ error: { code: "storage-corrupt" } });
});
it("encoded identity is canonical, case independent and fits filesystem filename limits", () => {
  for (const id of ["A", "a", "0", "a-b.c_d", "Z".repeat(128), "z".repeat(128)]) {
    const encoded = encodeId(id);
    expect(decodeId(encoded)).toBe(id);
    expect(encoded).toMatch(/^[0-9a-v]+$/);
    expect(Buffer.byteLength(`${encoded}.jsonl`)).toBeLessThanOrEqual(255);
    expect(sessionId(`${encoded}.jsonl`)).toBe(id);
  }

  expect(encodeId("A")).not.toBe(encodeId("a"));

  for (const invalid of ["", "a", "zz", "AA", "00", encodeId("../escape"), `${encodeId("a")}0`])
    expect(() => decodeId(invalid)).toThrow();

  expect(() => sessionId("unrelated")).toThrow();
});
it("an incompatible path format is rejected before any existing files are rewritten", async () => {
  const f = await fixture();
  const path = join(f.path, "format.json");
  const marker = encodeLine({ kind: "session-jsonl", format: 1 });
  await writeFile(path, marker);
  expect(await f.storage.initialize({ namespace: key.namespace, policy })).toMatchObject({
    error: { code: "configuration-conflict" },
  });
  expect(await readFile(path, "utf8")).toBe(marker);
});
