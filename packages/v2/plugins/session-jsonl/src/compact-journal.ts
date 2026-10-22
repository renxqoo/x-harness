import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Journal, Operation } from "./types";
import { encodeLine } from "./encode-line";
import { recordLine } from "./read-record";
import { publishFile } from "./publish-file";
import { writeLine } from "./write-line";

export function headerLine(
  namespace: string,
  state: Journal,
  mode: "empty" | "fork" | "snapshot",
): string {
  return encodeLine({
    kind: "header",
    namespace,
    head: state.head,
    mode,
    receipts: mode === "snapshot" ? state.commits.size : 0,
  });
}

export function basePayload(state: Journal) {
  return {
    kind: "base",
    revision: state.head.revision,
    bytes: state.head.bytes,
    records: state.head.revision,
    receipts: state.commits.size,
    nodes: state.nodes,
  };
}

export function compactSize(namespace: string, state: Journal): number {
  if (state.compactBytes !== undefined) return state.compactBytes;

  let size =
    Buffer.byteLength(headerLine(namespace, state, "snapshot")) +
    state.recordBytes +
    Buffer.byteLength(encodeLine(basePayload(state)));

  for (const commit of state.commits.values())
    size += Buffer.byteLength(`${JSON.stringify({ commit })}\n`);

  state.compactBytes = size;
  return size;
}

export async function compactJournal(
  op: Operation,
  input: { source: FileHandle; path: string; namespace: string },
  state: Journal,
): Promise<void> {
  const { source, path, namespace } = input;

  if (state.end <= Math.max(1048576, 2 * compactSize(namespace, state))) return;

  const header = headerLine(namespace, state, "snapshot");
  const initial = JSON.parse(header) as { checksum: string };
  let offset = Buffer.byteLength(header);
  const chain = createHash("sha256").update(initial.checksum);
  let checksum = "";
  await publishFile(op, path, async (target) => {
    await writeLine(target, header, 0);

    for (const index of state.records) {
      op.check();
      const raw = await recordLine(source, index);
      chain.update(raw);
      offset += await writeLine(target, raw, offset);
    }

    for (const commit of state.commits.values()) {
      op.check();
      const raw = `${JSON.stringify({ commit })}\n`;
      chain.update(raw);
      offset += await writeLine(target, raw, offset);
    }

    const footer = basePayload(state);
    checksum = chain.update(JSON.stringify(footer)).digest("hex");
    offset += await writeLine(target, encodeLine(footer, checksum), offset);
  });
  let recordOffset = Buffer.byteLength(header);

  for (const index of state.records) {
    index.offset = recordOffset;
    recordOffset += index.length;
  }

  state.end = offset;
  state.digest = checksum;
  state.identity = "";
}
