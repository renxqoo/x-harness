import { defineService } from "@x-harness/core";
import type { BackgroundTasks } from "./tasks.ts";

export const backgroundTasks = defineService<BackgroundTasks>("background-tasks");
