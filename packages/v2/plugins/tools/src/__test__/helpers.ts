import { createHost } from "../../../../core/src/index";
import type { Plugin, Result } from "../../../../core/src/index";
import { createToolsPlugin, tools } from "../index";
import type { ToolsOptions } from "../index";

export function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));

  return r.value;
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function world(
  plugins: readonly Plugin[] = [],
  options: ToolsOptions = { access: "allow" },
) {
  const host = value(createHost({ limits: { callTimeoutMs: 2000, closeTimeoutMs: 100 } }));
  value(await host.install([value(createToolsPlugin(options)), ...plugins]));
  return { host, service: value(host.use(tools)) };
}

export const emptySchema = { type: "object", properties: {}, additionalProperties: false } as const;
export const text = (text: string) => ({
  ok: true as const,
  value: { content: [{ type: "text" as const, text }] },
});
export const request = (
  name = "echo",
  input: Readonly<Record<string, import("../../../../core/src/index").JsonValue>> = {},
) => ({ name, callId: "call", input });

export async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
