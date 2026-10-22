import { describe, expect, it } from "vitest";
import { fixtures, value, message, event } from "./helpers";
import type { SessionEntry } from "../index";

const setup = fixtures();

for (const kind of ["sqlite", "postgres"] as const)
  describe(`${kind} deterministic replay`, () => {
    it.each([1, 42, 777])(
      "seed %i keeps incremental conversation equal to an independent history replay",
      async (seed) => {
        const { service } = await setup(kind);
        value(await service.create({ id: "one" }));
        let state = seed;
        const expected: { seq: number; text: string }[] = [];

        const random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };

        for (let step = 0; step < 48; step++) {
          let entry: SessionEntry;
          const roll = random();

          if (roll < 0.3) entry = event({ step });
          else if (roll < 0.65 || !expected.length) {
            entry = message(`message-${step}`);
            expected.push({ seq: step + 1, text: `message-${step}` });
          } else {
            const start = Math.floor(random() * expected.length);
            const end = start + Math.floor(random() * (expected.length - start));
            entry = message(`summary-${step}`, {
              startSeq: expected[start]!.seq,
              endSeq: expected[end]!.seq,
            });
            expected.splice(start, end - start + 1, { seq: step + 1, text: `summary-${step}` });
          }

          value(
            await service.append({
              id: "one",
              expectedRevision: step,
              commitId: `commit-${step}`,
              entries: [entry],
            }),
          );
          expect(
            value(await service.conversation({ id: "one" })).nodes.map((node) => ({
              seq: node.seq,
              text:
                node.message.content[0]!.type === "text"
                  ? node.message.content[0]!.text
                  : "invalid",
            })),
          ).toEqual(expected);
        }

        const history = value(await service.history({ id: "one" })).records;
        const replay: number[] = [];

        for (const record of history) {
          if (record.entry.kind !== "message") continue;

          if (!record.entry.replace) replay.push(record.seq);
          else {
            const left = replay.indexOf(record.entry.replace.startSeq);
            const right = replay.indexOf(record.entry.replace.endSeq);
            replay.splice(left, right - left + 1, record.seq);
          }
        }

        expect(replay).toEqual(expected.map((node) => node.seq));
        value(await service.fork({ id: "replayed", sourceId: "one", throughRevision: 48 }));
        expect(
          value(await service.conversation({ id: "replayed" })).nodes.map((node) => node.seq),
        ).toEqual(replay);
      },
    );
  });
