import { expect, it } from "vitest";
import { createHost } from "../../../core/src/index";
import type { LogRecord } from "../index";
import { createLoggerPlugin, logger } from "../index";
import { value } from "./helpers";

it("logger filters levels and copies caller fields before invoking the sink", async () => {
  const records: LogRecord[] = []; const host = value(createHost());
  value(await host.install([value(createLoggerPlugin({ level: "info", now: () => 42, write(record) { records.push(record); } }))]));
  const log = value(host.use(logger)); const fields = { nested: { id: 1 } };
  value(await log.debug({ message: "hidden" })); value(await log.info({ message: "created", fields })); fields.nested.id = 2;
  value(await log.warn({ message: "warning" })); value(await log.error({ message: "error" }));
  expect(records.map((record) => record.level)).toEqual(["info", "warn", "error"]);
  expect(records[0]).toEqual({ message: "created", fields: { nested: { id: 1 } }, time: 42, level: "info" });
  expect(Object.isFrozen(records[0]!.fields)).toBe(true); value(await host.close());
});

it.each([{}, { write: 1 }, { write() {}, level: "trace" }, { write() {}, now: 1 }, { write() {}, unknown: 1 }])("logger rejects malformed options", (options) => {
  expect(createLoggerPlugin(options as Parameters<typeof createLoggerPlugin>[0]).ok).toBe(false);
});

it("logger never executes input getters and reports neutral sink and clock errors", async () => {
  const host = value(createHost()); let reads = 0; let writes = 0;
  value(await host.install([value(createLoggerPlugin({ write() { writes += 1; throw new Error("private sink"); } }))]));
  const log = value(host.use(logger));
  for (const input of [null, { message: "x", unknown: true }, { message: "x".repeat(4097) }, { message: "x", fields: "x".repeat(65536) }, Object.defineProperty({}, "message", { get() { reads += 1; return "secret"; } })]) {
    expect((await log.info(input as Parameters<typeof log.info>[0])).ok).toBe(false);
  }
  const failed = await log.info({ message: "accepted" }); expect(failed).toMatchObject({ ok: false, error: { code: "callback-failed" } });
  expect(JSON.stringify(failed)).not.toContain("private sink"); expect(reads).toBe(0); expect(writes).toBe(1); value(await host.close());
  const other = value(createHost()); value(await other.install([value(createLoggerPlugin({ now: () => NaN, write() {} }))]));
  expect(await value(other.use(logger)).info({ message: "clock" })).toMatchObject({ ok: false, error: { code: "callback-failed" } }); value(await other.close());
});

it("logger includes level and timestamp metadata in the total record budget", async () => {
  let writes = 0; const host = value(createHost()); value(await host.install([value(createLoggerPlugin({ write() { writes += 1; } }))]));
  const log = value(host.use(logger));
  expect(await log.info({ message: "m", fields: "x".repeat(65500) })).toMatchObject({ ok: false, error: { code: "invalid-input" } }); expect(writes).toBe(0);
  value(await log.info({ message: "m", fields: "x".repeat(65000) })); expect(writes).toBe(1); value(await host.close());
});
