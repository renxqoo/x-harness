import type { Disposer, Plugin } from "@x-harness/core";
import { execEnv } from "../tokens.ts";
import { createLocalEnv } from "./env.ts";

export interface LocalEnvPluginOptions {
  readonly root?: string;
}

export function createLocalEnvPlugin(options: LocalEnvPluginOptions = {}): Plugin {
  return {
    name: "exec-env-local",
    apply: (ctx): Disposer => ctx.provide(execEnv, createLocalEnv(options.root ?? process.cwd())),
  };
}
