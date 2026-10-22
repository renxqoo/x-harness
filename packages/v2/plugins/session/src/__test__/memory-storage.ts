import type {
  SessionStorage,
  StoragePolicy,
  StoredHead,
  StoredRecord,
  StorageNode,
  StoredCommit,
} from "../storage";
import { createStorageListPage } from "../storage";
import type { SessionResult } from "../contracts";

export function memoryStorage(): SessionStorage {
  const policies = new Map<string, StoragePolicy>();
  const heads = new Map<string, StoredHead>();
  const records = new Map<string, readonly StoredRecord[]>();
  const views = new Map<string, readonly StorageNode[]>();
  const commits = new Map<string, StoredCommit>();

  const key = (input: { namespace: string; id: string }) => `${input.namespace}/${input.id}`;

  const ok = <T>(value: T): SessionResult<T> => ({ ok: true, value: structuredClone(value) });

  const fail = (code: import("../contracts").SessionErrorCode): SessionResult<never> => ({
    ok: false,
    error: { source: "session", code },
  });

  const page = <T extends StoredRecord>(
    items: readonly T[],
    input: { limit: number; maxPageBytes: number },
  ): SessionResult<{ records: readonly T[]; more: boolean }> => {
    let bytes = 1024;
    const selected: T[] = [];

    for (const item of items) {
      if (selected.length >= input.limit || bytes + item.bytes + 256 > input.maxPageBytes) break;

      bytes += item.bytes + 256;
      selected.push(item);
    }

    return items.length && !selected.length
      ? fail("record-too-large")
      : ok({ records: selected, more: selected.length < items.length });
  };

  return {
    async list(input) {
      const policy = policies.get(input.namespace);

      if (!policy) return fail("configuration-conflict");

      const page = createStorageListPage(input, policy);
      const entries = [...heads.entries()]
        .filter(([key]) => key.startsWith(`${input.namespace}/`))
        .map(([, head]) => head)
        .sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));

      for (const head of entries) {
        if (head.id <= (input.after ?? "")) continue;

        const result = page.add({
          id: head.id,
          createdAt: head.createdAt,
          metadata: head.metadata,
          ...(head.parent ? { parent: head.parent } : {}),
        });

        if (!result.ok) return result;

        if (!result.value) break;
      }

      return ok(page.finish());
    },
    async initialize(input) {
      const old = policies.get(input.namespace);

      if (old && JSON.stringify(old) !== JSON.stringify(input.policy))
        return fail("configuration-conflict");

      policies.set(input.namespace, structuredClone(input.policy));
      return ok(undefined);
    },
    async create(input) {
      const id = key(input);
      const old = heads.get(id);

      if (old) return old.origin === input.origin ? ok(old) : fail("already-exists");

      if (!policies.has(input.namespace)) return fail("not-found");

      const head = {
        id: input.id,
        origin: input.origin,
        metadata: input.metadata,
        createdAt: Date.now(),
        revision: 0,
        bytes: 0,
      };
      heads.set(id, head);
      records.set(id, []);
      views.set(id, []);
      return ok(head);
    },
    async read(input) {
      const id = key(input);
      const head = heads.get(id);

      if (!head) return fail("not-found");

      const commit = input.commitId ? commits.get(`${id}/${input.commitId}`) : undefined;

      if (commit) return ok({ head, commit });

      return ok({ head, ...(input.projection ? { nodes: views.get(id)! } : {}) });
    },
    async commit(input) {
      if (!input.records.length) return fail("invalid-input");

      const id = key(input);
      const head = heads.get(id);

      if (!head) return fail("not-found");

      const existing = commits.get(`${id}/${input.commitId}`);

      if (existing)
        return existing.fingerprint === input.fingerprint
          ? ok(existing.receipt)
          : fail("commit-conflict");

      if (head.revision !== input.expectedRevision) return fail("revision-conflict");

      const revision = input.expectedRevision + input.records.length;
      const receipt = {
        commitId: input.commitId,
        firstSeq: input.expectedRevision + 1,
        lastSeq: revision,
        revision,
      };
      records.set(id, [...records.get(id)!, ...structuredClone(input.records)]);
      views.set(id, structuredClone(input.nodes));
      heads.set(id, {
        ...head,
        revision,
        bytes: head.bytes + input.records.reduce((n, r) => n + r.bytes, 0),
      });
      commits.set(`${id}/${input.commitId}`, { fingerprint: input.fingerprint, receipt });
      return ok(receipt);
    },
    async history(input) {
      const id = key(input);
      const head = heads.get(id);

      if (!head) return fail("not-found");

      const revision = input.throughRevision ?? head.revision;

      if (revision > head.revision || input.after > revision) return fail("invalid-input");

      const result = page(
        records.get(id)!.filter((r) => r.seq > input.after && r.seq <= revision),
        input,
      );

      if (!result.ok) return result;

      return ok({
        revision,
        records: result.value.records,
        ...(result.value.more ? { next: result.value.records.at(-1)!.seq } : {}),
      });
    },
    async conversation(input) {
      const id = key(input);
      const head = heads.get(id);

      if (!head) return fail("not-found");

      if (input.revision !== undefined && input.revision !== head.revision)
        return fail("revision-conflict");

      const nodes = views.get(id)!;

      if (input.position && !nodes.some((n) => n.position === input.position))
        return fail("invalid-input");

      const result = page(
        nodes
          .filter((n) => n.position > input.position)
          .map((n) => ({
            ...records.get(id)!.find((r) => r.seq === n.seq)!,
            position: n.position,
          })),
        input,
      );

      if (!result.ok) return result;

      return ok({
        revision: head.revision,
        records: result.value.records,
        ...(result.value.more ? { next: result.value.records.at(-1)!.position } : {}),
      });
    },
    async fork(input) {
      const id = key(input);
      const old = heads.get(id);

      if (old) return old.origin === input.origin ? ok(old) : fail("already-exists");

      const sourceKey = key({ namespace: input.namespace, id: input.sourceId });
      const source = heads.get(sourceKey);

      if (!source) return fail("not-found");

      if (input.throughRevision > source.revision) return fail("invalid-input");

      const prefix = records.get(sourceKey)!.filter((r) => r.seq <= input.throughRevision);

      if (prefix.reduce((n, r) => n + r.bytes, 0) !== input.bytes) return fail("storage-corrupt");

      const head = {
        id: input.id,
        origin: input.origin,
        metadata: input.metadata,
        createdAt: Date.now(),
        revision: input.throughRevision,
        bytes: input.bytes,
        parent: { id: input.sourceId, revision: input.throughRevision },
      };
      heads.set(id, head);
      records.set(id, structuredClone(prefix));
      views.set(id, structuredClone(input.nodes));
      return ok(head);
    },
    async getCommit(input) {
      const receipt = commits.get(`${key(input)}/${input.commitId}`);
      return receipt ? ok(receipt) : fail("not-found");
    },
  };
}
