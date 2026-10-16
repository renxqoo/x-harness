import { definePlugin } from "../../../core/src/index";
import type { Invocation, Plugin, Result } from "../../../core/src/index";
import { createFault, readData, readJsonValue } from "../../../core/src/validation";
import { logger } from "./define-logger";
import { readLog } from "./read-log";
import type { LoggerOptions, LogInput, LogLevel } from "./types";

const levels: readonly LogLevel[] = Object.freeze(["debug", "info", "warn", "error"]);

export function createLoggerPlugin(input: LoggerOptions): Result<Plugin> {
  const read = readData(input);
  if (!read.ok || Object.keys(read.value).some((key) => !["write", "level", "now"].includes(key)) || typeof read.value.write !== "function" ||
      (read.value.level !== undefined && !levels.includes(read.value.level as LogLevel)) ||
      (read.value.now !== undefined && typeof read.value.now !== "function")) return createFault("invalid-input");
  const options = read.value as unknown as LoggerOptions;
  const minimum = levels.indexOf(options.level ?? "info");
  const now = options.now ?? Date.now;
  return { ok: true, value: definePlugin({ name: "logger", provides: { logger }, setup(ctx) {
    const log = async (level: LogLevel, input: LogInput, call: Pick<Invocation, "signal">): Promise<Result<void>> => {
      const parsed = readLog(input);
      if (!parsed.ok) return parsed;
      if (levels.indexOf(level) < minimum) return { ok: true, value: undefined };
      if (call.signal.aborted) return createFault("cancelled");
      try {
        const time = now();
        if (!Number.isFinite(time)) return createFault("callback-failed");
        const record = readJsonValue({ ...parsed.value, level, time });
        if (!record.ok) return createFault("invalid-input");
        await options.write(record.value as unknown as import("./types").LogRecord, call.signal);
        return { ok: true, value: undefined };
      } catch { return createFault("callback-failed"); }
    };
    return ctx.service({ logger: {
      debug: (input, call) => log("debug", input, call), info: (input, call) => log("info", input, call),
      warn: (input, call) => log("warn", input, call), error: (input, call) => log("error", input, call),
    } });
  } }) };
}
