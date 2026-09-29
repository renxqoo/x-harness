import { defineService } from "@x-harness/core";
import type { SystemPromptService } from "./types.ts";

export const systemPrompt = defineService<SystemPromptService>("system-prompt");
