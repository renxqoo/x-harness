import { defineService } from "../../../../core/src/index";
import type { LlmProviderService } from "../contracts";
import { readLlmError } from "../domain/read-error";

export function defineLlmProvider(name: string) {
  return defineService<LlmProviderService>({
    name,
    methods: { stream: { failure: readLlmError }, describe: { failure: readLlmError } },
  });
}
