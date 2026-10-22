import { definePlugin } from "../../../core/src/index";
import type { Plugin } from "../../../core/src/index";
import { createFault } from "../../../core/src/validation";
import { sessionStorage } from "../../session/src/storage";
import type { SessionResult } from "../../session/src/contracts";
import { readOptions } from "./read-options";
import type { JsonlSessionOptions } from "./read-options";
import { openJsonlStore } from "./open-store";
import { createJsonlStorage } from "./create-storage-service";
import { failure } from "./fail";

export function createJsonlSessionPlugin(input: JsonlSessionOptions = {}): SessionResult<Plugin> {
  const options = readOptions(input);

  if (!options.ok) return options;

  return {
    ok: true,
    value: definePlugin({
      name: "session-jsonl",
      provides: { storage: sessionStorage },
      async setup(ctx) {
        const opened = await ctx.resource({
          async open() {
            try {
              return {
                ok: true as const,
                value: await openJsonlStore(options.value.path, options.value.limits),
              };
            } catch (error) {
              return failure(error);
            }
          },
          async close(store) {
            const result = await store.close();
            return result.ok ? result : createFault("callback-failed");
          },
        });
        return opened.ok ? ctx.service({ storage: createJsonlStorage(opened.value) }) : opened;
      },
    }),
  };
}
