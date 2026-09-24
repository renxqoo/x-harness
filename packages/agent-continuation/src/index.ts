export { createContinuationPlugin } from "./plugin.ts";
export type { ContinuationOptions } from "./plugin.ts";
export {
  DEFAULT_MAX_OUTPUT_CONTINUATIONS,
  decideContinuation,
  GIVE_UP,
  OUTPUT_CONTINUATION_INSTRUCTION,
  OUTPUT_CONTINUATION_SOURCE,
  validateMaxOutputContinuations,
} from "./policy.ts";
export type { ContinuationDecideInput } from "./policy.ts";
export { continuationsSinceStop } from "./count.ts";
