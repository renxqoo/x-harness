import { defineService } from "@x-harness/core";
import type { ExecEnv } from "./types.ts";

export const execEnv = defineService<ExecEnv>("exec-env");
