import type { Context, Disposer, Plugin } from "@x-harness/core";
import { defineService } from "@x-harness/core";
import { sessionAuditDrain, sessionAuditEvent, sessionCreated, sessionDisposed, sessionFlush, sessionStore } from "@x-harness/session";
import { ensureSchema } from "./schema.ts";
import { createQueryService } from "./service.ts";
import type { SqliteTelemetryOptions, TelemetryQueryService } from "./types.ts";
import { createTelemetryWriter } from "./writer.ts";

export const sqliteTelemetry = defineService<TelemetryQueryService>("sqlite-telemetry");

export function sqliteTelemetryPlugin(options: SqliteTelemetryOptions): Plugin {
  return {
    name: "telemetry-sqlite",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      ensureSchema(options.db);

      const store = ctx.use(sessionStore);
      const writer = createTelemetryWriter({
        db: options.db,
        tx: options.tx,
        resource: options.resource,
        includeBodies: options.includeBodies ?? true,
        onIoError:
          options.onIoError ??
          ((message: string) => {
            process.stderr.write(`${message}\n`);
          }),
      });

      const offs = [
        ctx.on(sessionCreated, ({ header }) => {
          writer.onCreated(header, store.get(header.id)?.events() ?? []);
        }),
        ctx.on(sessionAuditEvent, ({ session, event }) => {
          writer.onAuditEvent(session, event);
        }),
        ctx.on(sessionFlush, ({ session }) => writer.flush(session)),
        ctx.on(sessionDisposed, ({ session }) => {
          writer.onDisposed(session);
        }),
      ];

      const offProvide = ctx.provide(sqliteTelemetry, createQueryService(options.db));

      return () => {
        ctx.tryUse(sessionAuditDrain)?.drain();
        for (const off of [...offs, offProvide]) off();
        return writer.drainAll();
      };
    },
  };
}
