import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../../../core/src/index";
import { createSessionPlugin, session } from "../index";
import type { SessionEntry } from "../index";
import { createSqliteSessionPlugin } from "../../../session-sqlite/src/index";
import { value } from "./helpers";

interface ModelSession {
  revision: number;
  live: { position: number; seq: number }[];
  commits: Map<string, { firstSeq: number; lastSeq: number }>;
}

function makeRandom(seed: number) {
  let state = seed >>> 0 || 1;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

it("model fuzz: thousands of mixed operations keep the model and service in lockstep", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-fuzz-"));

  try {
    const host = value(createHost({ limits: { callTimeoutMs: 60000, closeTimeoutMs: 60000 } }));
    value(
      await host.install([
        value(createSqliteSessionPlugin({ path: join(directory, "fuzz.sqlite") })),
        value(createSessionPlugin({ namespace: "fuzz" })),
      ]),
    );
    const service = value(host.use(session));
    const random = makeRandom(4242);
    const ids = ["a", "b", "c", "d", "e"];
    const model = new Map<string, ModelSession>();

    for (const id of ids) {
      value(await service.create({ id }));
      model.set(id, { revision: 0, live: [], commits: new Map() });
    }

    let operations = 0;
    let checks = 0;
    const TOTAL = 5000;

    for (let op = 0; op < TOTAL; op++) {
      const roll = random();
      const id = ids[Math.floor(random() * ids.length)]!;
      const state = model.get(id)!;

      if (roll < 0.68) {
        const stale = random() < 0.08 && state.revision > 0;
        const expected = stale ? state.revision - 1 : state.revision;
        const doReplace = state.live.length >= 2 && random() < 0.3;
        const start = doReplace ? Math.floor(random() * state.live.length) : 0;
        const end = doReplace ? start + Math.floor(random() * (state.live.length - start)) : 0;
        const entry: SessionEntry = {
          kind: "message",
          message: { role: "user", content: [{ type: "text", text: `x${op}` }] },
          ...(doReplace
            ? { replace: { startSeq: state.live[start]!.seq, endSeq: state.live[end]!.seq } }
            : {}),
        };
        const result = await service.append({
          id,
          expectedRevision: expected,
          commitId: `op${op}`,
          entries: [entry],
        });
        operations++;

        if (!stale) {
          if (!result.ok)
            throw new Error(`op ${op}: model expected success, got ${result.error.code}`);

          state.revision += 1;

          if (doReplace)
            state.live.splice(start, end - start + 1, {
              position: state.live[start]!.position,
              seq: state.revision,
            });
          else state.live.push({ position: state.revision, seq: state.revision });

          state.commits.set(`op${op}`, { firstSeq: expected + 1, lastSeq: state.revision });
        } else if (result.ok) throw new Error(`op ${op}: stale revision ${expected} accepted`);
      } else if (roll < 0.78) {
        const known = [...state.commits.keys()];

        if (known.length) {
          const commitId = known[Math.floor(random() * known.length)]!;
          const result = value(await service.getCommit({ id, commitId }));
          const expected = state.commits.get(commitId)!;

          if (result.firstSeq !== expected.firstSeq || result.lastSeq !== expected.lastSeq)
            throw new Error(`op ${op}: receipt mismatch for ${commitId}`);

          checks++;
        }
      } else if (roll < 0.88) {
        const result = value(await service.history({ id, after: 0, limit: 1 }));

        if (result.revision !== state.revision)
          throw new Error(
            `op ${op}: history revision ${result.revision} drifts from model ${state.revision}`,
          );

        checks++;
      } else {
        const page = value(await service.conversation({ id, limit: 1000 }));
        const got = page.nodes.map((node) => `${node.position}:${node.seq}`).join(",");
        const want = state.live.map((node) => `${node.position}:${node.seq}`).join(",");

        if (got !== want)
          throw new Error(`op ${op} id=${id}: projection mismatch\n  got  ${got}\n  want ${want}`);

        checks++;
      }

      if (op % 1000 === 999)
        for (const sid of ids)
          if (value(await service.get({ id: sid })).revision !== model.get(sid)!.revision)
            throw new Error(`op ${op}: head revision drift for ${sid}`);
    }

    expect(operations).toBeGreaterThan(3000);
    expect(checks).toBeGreaterThan(500);
    await host.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
