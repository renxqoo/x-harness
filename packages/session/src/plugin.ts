// session 插件：装配仓库与总线 token 的桥接回调（docs/SESSION.md §1.1、§1.2）。

import type { Context, Disposer, Plugin } from "@x-harness/core";
import { createSessionStore } from "./store.ts";
import { sessionCreateGuard, sessionCreated, sessionDisposed, sessionEvent, sessionFlush, sessionStore } from "./tokens.ts";

export const sessionPlugin = {
  name: "session",
  apply: (ctx: Context): Disposer => {
    const store = createSessionStore({
      onEvent: (session, event) => {
        ctx.emit(sessionEvent, { session, event });
      },
      onGuard: (header) => ctx.dispatch(sessionCreateGuard, { header }),
      onCreated: (header) => {
        ctx.emit(sessionCreated, { header });
      },
      onFlush: (session) => ctx.dispatch(sessionFlush, { session }),
      onDisposed: (session) => {
        ctx.emit(sessionDisposed, { session });
      },
    });
    ctx.provide(sessionStore, store);
    return () => {
      for (const id of store.list()) store.dispose(id);
    };
  },
} satisfies Plugin;
