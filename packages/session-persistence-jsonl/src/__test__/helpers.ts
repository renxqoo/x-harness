import { createContext, loadPlugins } from "@x-harness/core";
import type { Context, Disposer } from "@x-harness/core";
import { sessionPlugin } from "@x-harness/session";
import { sessionArchive, sessionStore } from "@x-harness/session";
import type { Result } from "@x-harness/core";
import type { SessionArchive, SessionStore } from "@x-harness/session";
import { createJsonlSessionPersistence } from "../plugin.ts";

export interface World {
  ctx: Context;
  store: SessionStore;
  archive: SessionArchive;
  unload: readonly Disposer[];
  ioErrors: string[];
}

export async function makeWorld(root: string): Promise<World> {
  const ioErrors: string[] = [];
  const ctx = createContext();
  const unload = await loadPlugins(ctx, [
    sessionPlugin,
    createJsonlSessionPersistence({ root, onIoError: (message) => ioErrors.push(message) }),
  ]);
  return { ctx, store: ctx.use(sessionStore), archive: ctx.use(sessionArchive), unload, ioErrors };
}

/** 测试用 Result 解包：失败即抛（失败路径另行显式断言） */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** fire-and-forget 路径（created 首灌 / disposed 终排空）的同步点：轮询直到谓词为真 */
export async function waitUntil(probe: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error("waitUntil timeout");
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
