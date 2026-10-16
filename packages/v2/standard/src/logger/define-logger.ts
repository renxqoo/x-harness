import { defineService } from "../../../core/src/index";
import type { Result } from "../../../core/src/index";
import type { LogInput } from "./types";

export interface Logger {
  debug(input: LogInput): Promise<Result<void>>;
  info(input: LogInput): Promise<Result<void>>;
  warn(input: LogInput): Promise<Result<void>>;
  error(input: LogInput): Promise<Result<void>>;
}

const defined = defineService<Logger>({ name: "standard/logger", methods: { debug: {}, info: {}, warn: {}, error: {} } });
if (!defined.ok) throw new Error("Invalid logger contract");
export const logger = defined.value;
