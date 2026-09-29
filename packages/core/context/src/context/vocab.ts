import { defineEvent } from "./tokens.ts";

export const serviceProvided = defineEvent<{ readonly service: string }>("service/provided");
export const pluginLoaded = defineEvent<{ readonly plugin: string }>("plugin/loaded");
export const pluginUnloaded = defineEvent<{ readonly plugin: string }>("plugin/unloaded");
export const pluginError = defineEvent<{ readonly plugin: string; readonly error: string }>(
  "plugin/error",
);
export const contextDisposing = defineEvent<Record<string, never>>("context/disposing");

export const pluginEvent = defineEvent<{
  readonly plugin: string;
  readonly kind: string;
  readonly data: unknown;
  readonly ts: number;
}>("plugin/event", { freeze: "shell" });
