// ExecEnv 服务 token（docs/EXEC-ENV.md §0）：装配即选择——localEnvPlugin（无围栏）或 sandbox provider。

import { defineService } from "@x-harness/core";
import type { ExecEnv } from "./types.ts";

export const execEnv = defineService<ExecEnv>("exec-env");
