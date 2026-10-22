import type { Repository } from "./types";
import type { ConversationNode, ConversationPage, SessionResult } from "../contracts/types";
import { readInput, identifier, count } from "../domain/read-input";
import { fail } from "../domain/fail";
import { readStoredHead } from "../domain/read-stored-head";
import { readStoredRecord } from "../domain/read-stored-record";

export async function readConversation(
  store: Repository,
  raw: unknown,
): Promise<SessionResult<ConversationPage>> {
  const input = readInput(raw, ["id", "after", "revision", "limit"]);

  if (!input.ok) return input;

  const { id, after } = input.value;
  const limit = input.value.limit ?? store.options.limits.pageSize;

  if (
    !identifier(id) ||
    !count(limit) ||
    limit < 1 ||
    limit > store.options.limits.maxPageSize ||
    (input.value.revision !== undefined && !count(input.value.revision))
  )
    return fail("invalid-input");

  const namespace = store.options.namespace;
  let position = 0;
  let cursorRevision: number | undefined;

  if (after !== undefined) {
    if (typeof after !== "string" || after.length > 320) return fail("invalid-input");

    const [ns, cursorId, rev, pos, extra] = after.split(":");

    if (
      ns !== namespace ||
      cursorId !== id ||
      extra !== undefined ||
      !/^[0-9]+$/.test(rev ?? "") ||
      !/^[1-9][0-9]*$/.test(pos ?? "")
    )
      return fail("invalid-input");

    cursorRevision = Number(rev);
    position = Number(pos);

    if (!count(cursorRevision) || !count(position)) return fail("invalid-input");
  }

  if (
    cursorRevision !== undefined &&
    input.value.revision !== undefined &&
    cursorRevision !== input.value.revision
  ) {
    const state = await store.storage.read({ namespace, id });

    if (!state.ok) return state;

    const head = readStoredHead(state.value.head, store.options.limits.maxMetadataBytes);
    return head.ok ? fail("revision-conflict") : head;
  }

  const requiredRevision = cursorRevision ?? (input.value.revision as number | undefined);
  const result = await store.storage.conversation({
    namespace,
    id,
    position,
    limit,
    maxPageBytes: store.options.limits.maxPageBytes,
    ...(requiredRevision !== undefined ? { revision: requiredRevision } : {}),
  });

  if (!result.ok) return result;

  const nodes: ConversationNode[] = [];
  let previous = position;

  for (const row of result.value.records) {
    const record = readStoredRecord(row, store.options.limits.maxRecordBytes);

    if (!record.ok) return record;

    if (
      !count(row.position) ||
      !row.position ||
      row.position <= previous ||
      record.value.entry.kind !== "message"
    )
      return fail("storage-corrupt");

    previous = row.position;
    nodes.push(
      Object.freeze({
        position: row.position,
        seq: record.value.seq,
        time: record.value.time,
        message: record.value.entry.message,
      }),
    );
  }

  if (
    (result.value.next !== undefined &&
      (result.value.next <= position ||
        (nodes.at(-1)?.position ?? position) > result.value.next)) ||
    (result.value.next === undefined && nodes.some((node) => node.position > result.value.revision))
  )
    return fail("storage-corrupt");

  const next = `${namespace}:${id}:${result.value.revision}:${result.value.next}`;
  const page = Object.freeze({
    revision: result.value.revision,
    nodes: Object.freeze(nodes),
    ...(result.value.next !== undefined ? { next } : {}),
  });

  if (new TextEncoder().encode(JSON.stringify(page)).length > store.options.limits.maxPageBytes)
    return fail("record-too-large");

  return { ok: true, value: page };
}
