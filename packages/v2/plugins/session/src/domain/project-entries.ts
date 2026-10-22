import type { SessionEntry, SessionResult } from "../contracts/types";
import { fail } from "./fail";

export interface ProjectionNode {
  readonly position: number;
  readonly seq: number;
}

export function projectEntries(input: {
  nodes: readonly ProjectionNode[];
  entries: readonly SessionEntry[];
  revision: number;
  maximum: number;
}): SessionResult<{ nodes: readonly ProjectionNode[] }> {
  let nodes = [...input.nodes];

  for (const [index, entry] of input.entries.entries()) {
    if (entry.kind === "event") continue;

    const seq = input.revision + index + 1;
    let position = seq;

    if (entry.replace) {
      const start = nodes.findIndex((node) => node.seq === entry.replace!.startSeq);
      const end = nodes.findIndex((node) => node.seq === entry.replace!.endSeq);

      if (start < 0 || end < start) return fail("invalid-replacement");

      position = nodes[start]!.position;
      nodes.splice(start, end - start + 1, { position, seq });
    } else nodes.push({ position, seq });

    if (nodes.length > input.maximum) return fail("capacity-exceeded");
  }

  return { ok: true, value: { nodes } };
}
