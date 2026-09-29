import { join } from "node:path";
import { errorText } from "@x-harness/core";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import {
  sessionArchive,
  sessionAuditDrain,
  sessionAuditEvent,
  sessionCreated,
  sessionDisposed,
  sessionFlush,
  sessionStore,
} from "@x-harness/session";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { createArchiveReader } from "./archive.ts";
import { openSessionWriter } from "./writer.ts";
import type { SessionWriter } from "./writer.ts";
import { isPermanentRejection } from "./writer.ts";

export interface JsonlPersistenceOptions {
  readonly root: string;
  readonly onIoError?: (message: string) => void;
}

interface LiveSession {
  readonly id: SessionId;
  header: SessionHeader | undefined;
  pending: SessionEvent[];
  chain: Promise<void>;
  writer: SessionWriter | undefined;
  closed: boolean;
  dead: string | undefined;
  degraded: boolean;
}

export function createJsonlSessionPersistence(options: JsonlPersistenceOptions): Plugin {
  return {
    name: "session-persistence-jsonl",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const report =
        options.onIoError ??
        ((message: string) => {
          process.stderr.write(`${message}\n`);
        });

      const store = ctx.use(sessionStore);
      const lives = new Map<SessionId, LiveSession>();

      function liveOf(id: SessionId): LiveSession {
        const existing = lives.get(id);
        if (existing !== undefined) return existing;
        const fresh: LiveSession = {
          id,
          header: undefined,
          pending: [],
          chain: Promise.resolve(),
          writer: undefined,
          closed: false,
          dead: undefined,
          degraded: false,
        };
        lives.set(id, fresh);
        return fresh;
      }

      function runSegment(live: LiveSession, segment: () => Promise<void>): Promise<void> {
        const run = live.chain.then(segment);
        live.chain = run.then(
          () => {},
          () => {},
        );
        return run;
      }

      async function ensureWriter(live: LiveSession): Promise<SessionWriter> {
        if (live.writer !== undefined) return live.writer;
        if (live.header === undefined) throw new Error(`writer-unopened:${live.id}`);
        try {
          const opened = await openSessionWriter(join(options.root, live.id), live.header, store.get(live.id)?.events() ?? []);
          live.writer = opened.writer;
          if (opened.prefixLength > 0) {
            live.pending = live.pending.slice(opened.prefixLength);
          }
          return live.writer;
        } catch (error) {
          if (isPermanentRejection(error)) {
            live.dead = error instanceof Error ? error.message : String(error);
            report(live.dead);
          }
          throw error;
        }
      }

      async function appendBatch(live: LiveSession): Promise<void> {
        const writer = live.writer;
        if (writer === undefined || live.pending.length === 0) return;
        const size = live.pending.length;
        const lines = live.pending.slice(0, size).map((event) => `${JSON.stringify(event)}\n`);
        try {
          await writer.append(lines);
        } catch (error) {
          live.degraded = true;
          throw error;
        }
        live.pending = live.pending.slice(size);
      }

      function maybeRealtime(live: LiveSession): void {
        if (live.degraded || live.dead !== undefined || live.closed || live.writer === undefined) return;
        runSegment(live, () => appendBatch(live)).catch((error: unknown) => {
          if (lives.get(live.id) !== live) return;
          report(`session-realtime-append-failed:${live.id}:${errorText(error)}`);
        });
      }

      async function drainSteps(live: LiveSession): Promise<void> {
        if (live.dead !== undefined) throw new Error(live.dead);
        if (live.closed) return;
        const writer = live.writer !== undefined ? live.writer : await ensureWriter(live);
        await appendBatch(live);
        await writer.sync();
        live.degraded = false;
      }

      function closeSteps(live: LiveSession): Promise<void> {
        return runSegment(live, async () => {
          let drainError: unknown;
          if (!live.closed && live.dead === undefined) {
            try {
              await drainSteps(live);
            } catch (error) {
              drainError = error;
            }
          }
          live.closed = true;
          const writer = live.writer;
          live.writer = undefined;
          if (writer !== undefined) await writer.close();
          if (lives.get(live.id) === live) lives.delete(live.id);
          if (drainError !== undefined) throw drainError;
        });
      }

      const offs = [
        ctx.on(sessionCreated, ({ header }) => {
          const previous = lives.get(header.id);
          const live: LiveSession = {
            id: header.id,
            header,
            pending: [...(store.get(header.id)?.events() ?? [])],
            chain: previous?.chain ?? Promise.resolve(),
            writer: undefined,
            closed: false,
            dead: undefined,
            degraded: false,
          };
          lives.set(header.id, live);
          void runSegment(live, () => drainSteps(live)).catch((error) => {
            report(`session-created-persist-failed:${header.id}:${errorText(error)}`);
          });
        }),
        ctx.on(sessionAuditEvent, ({ session, event }) => {
          const live = liveOf(session);
          live.pending.push(event);
          maybeRealtime(live);
        }),
        ctx.on(sessionFlush, ({ session }) => {
          const live = lives.get(session);
          if (live === undefined) return undefined;
          return runSegment(live, () => drainSteps(live));
        }),
        ctx.on(sessionDisposed, ({ session }) => {
          const live = lives.get(session);
          if (live === undefined) return;
          void closeSteps(live).catch((error) => {
            report(`session-dispose-persist-failed:${session}:${errorText(error)}`);
          });
        }),
      ];

      const offArchive = ctx.provide(sessionArchive, createArchiveReader(options.root));

      return () => {
        ctx.tryUse(sessionAuditDrain)?.drain();
        for (const off of [...offs, offArchive]) off();
        const closing = [...lives.values()].map((live) =>
          closeSteps(live).catch((error) => {
            report(`session-close-failed:${live.id}:${errorText(error)}`);
          }),
        );
        lives.clear();
        return Promise.all(closing).then(() => {});
      };
    },
  } satisfies Plugin;
}
