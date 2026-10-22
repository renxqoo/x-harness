import { defineService } from "../../../core/src/index";
import type { Result } from "../../../core/src/index";

export interface Timer {
  sleep(input: { readonly ms: number }): Promise<Result<void>>;
}
const defined = defineService<Timer>({ name: "standard/timer", methods: { sleep: {} } });

if (!defined.ok) throw new Error("Invalid timer contract");

export const timer = defined.value;
