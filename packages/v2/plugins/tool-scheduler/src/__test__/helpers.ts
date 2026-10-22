import { createHost } from "../../../../core/src/index";
import type { Plugin, Result } from "../../../../core/src/index";
import { createToolsPlugin } from "../../../tools/src/index";
import { createToolSchedulerPlugin, toolScheduler } from "../index";
import type { SchedulerLimits } from "../index";

export function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const text = (text: string) => ({
  ok: true as const,
  value: { content: [{ type: "text" as const, text }] },
});
export const request = (name = "echo", callId = "call") => ({ name, callId, input: {} });

export async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

export async function world(
  plugins: readonly Plugin[] = [],
  limits: Partial<SchedulerLimits> = {},
  access: "allow" | "required" = "allow",
) {
  const host = value(
    createHost({ limits: { callTimeoutMs: 2000, closeTimeoutMs: 100, maxCallDepth: 256 } }),
  );
  const installed = value(
    await host.install([
      value(createToolsPlugin({ access: "allow" })),
      value(createToolSchedulerPlugin({ access, limits })),
      ...plugins,
    ]),
  );
  return { host, service: value(host.use(toolScheduler)), scheduler: installed.plugins[1]! };
}
