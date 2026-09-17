// jsonl 持久化桥：pending 内存队列 + per-id 串行链（一切磁盘写只经此链，docs/SESSION.md §1.8 单一不变量）。
// 链来源三处：created 首灌（构造期全量）、flush 增量排空、disposed/卸载终排空；同 id 重用 fail-closed。

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { sessionArchive, sessionCreated, sessionDisposed, sessionEvent, sessionFlush, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { createArchiveReader } from "./archive.ts";
import { openSessionWriter } from "./writer.ts";
import type { SessionWriter } from "./writer.ts";
import { isEexistError } from "./writer.ts";

export interface JsonlPersistenceOptions {
  readonly root: string;
  /** fire-and-forget 路径（created 首灌/disposed 终排空）的 I/O 失败上报；缺省写 stderr */
  readonly onIoError?: (message: string) => void;
}

interface LiveSession {
  readonly id: SessionId;
  header: SessionHeader | undefined;
  pending: SessionEvent[];
  chain: Promise<void>;
  writer: SessionWriter | undefined;
  closed: boolean;
  dead: string | undefined;
}

export function createJsonlSessionPersistence(options: JsonlPersistenceOptions): Plugin {
  return {
    name: "session-persistence-jsonl",
    inject: ["session"],
    apply: (ctx: Context): Disposer => {
      const report =
        options.onIoError ??
        ((message: string) => {
          process.stderr.write(`${message}\n`);
        });
      const rootReady = mkdir(options.root, { recursive: true });
      void rootReady.catch(() => {}); // 拒绝由各链段 await 时拿到；此处仅消未处理拒绝

      const store = ctx.use(sessionStore);
      const lives = new Map<SessionId, LiveSession>();

      function liveOf(id: SessionId): LiveSession {
        const existing = lives.get(id);
        if (existing !== undefined) return existing;
        const fresh: LiveSession = {
          id,
          header: undefined,
          pending: [],
          chain: Promise.resolve(),
          writer: undefined,
          closed: false,
          dead: undefined,
        };
        lives.set(id, fresh);
        return fresh;
      }

      /** 段入链串行执行；返回原始段 promise（flush 路径经它上浮错误），链本身吞错续命 */
      function runSegment(live: LiveSession, segment: () => Promise<void>): Promise<void> {
        const run = live.chain.then(segment);
        live.chain = run.then(
          () => {},
          () => {},
        );
        return run;
      }

      async function ensureWriter(live: LiveSession): Promise<SessionWriter> {
        if (live.writer !== undefined) return live.writer;
        // created 未达（如持久化晚于会话创建装载）：fail-closed，不写盘
        if (live.header === undefined) throw new Error(`writer-unopened:${live.id}`);
        try {
          live.writer = await openSessionWriter(join(options.root, live.id), live.header);
          return live.writer;
        } catch (error) {
          if (isEexistError(error)) {
            live.dead = `session-id-reused:${live.id}`;
            report(live.dead);
          }
          throw error;
        }
      }

      /** 排空：dead 抛错（flush 屏障经 parallel 聚合上浮）；closed 后 no-op */
      async function drainSteps(live: LiveSession): Promise<void> {
        if (live.dead !== undefined) throw new Error(live.dead);
        if (live.closed) return;
        const writer = live.writer !== undefined ? live.writer : await ensureWriter(live);
        if (live.pending.length > 0) {
          const batch = live.pending;
          const lines = batch.map((event) => `${JSON.stringify(event)}\n`);
          // 写入成功后才移除已写批次：失败时按序保留供下次 flush 重试；
          // await 期间新到事件只追加在尾部（slice 按批次长度截断，不误删）
          await writer.append(lines);
          live.pending = live.pending.slice(batch.length);
        }
        await writer.sync();
      }

      function closeSteps(live: LiveSession): Promise<void> {
        return runSegment(live, async () => {
          await rootReady;
          if (!live.closed && live.dead === undefined) await drainSteps(live);
          live.closed = true;
          const writer = live.writer;
          live.writer = undefined;
          if (writer !== undefined) await writer.close();
        });
      }

      const offs = [
        ctx.on(sessionCreated, ({ header }) => {
          // 重生（同 id 重建）时整体重置条目——旧 closed/dead 属于已终结的前一代；
          // 仅保留串行链，让在飞的终排空先完成
          const previous = lives.get(header.id);
          const live: LiveSession = {
            id: header.id,
            header,
            // 首灌 = 构造期全量（seed 前缀 + end-seed）；created 广播先于该会话一切活回路 append，无窗口
            pending: [...(store.get(header.id)?.events() ?? [])],
            chain: previous?.chain ?? Promise.resolve(),
            writer: undefined,
            closed: false,
            dead: undefined,
          };
          lives.set(header.id, live);
          void runSegment(live, async () => {
            await rootReady;
            await drainSteps(live);
          }).catch((error) => {
            report(`session-created-persist-failed:${header.id}:${errorText(error)}`);
          });
        }),
        ctx.on(sessionEvent, ({ session, event }) => {
          liveOf(session).pending.push(event);
        }),
        ctx.on(sessionFlush, ({ session }) => {
          const live = lives.get(session);
          if (live === undefined) return undefined;
          return runSegment(live, async () => {
            await rootReady;
            await drainSteps(live);
          });
        }),
        ctx.on(sessionDisposed, ({ session }) => {
          const live = lives.get(session);
          if (live === undefined) return;
          void closeSteps(live).catch((error) => {
            report(`session-dispose-persist-failed:${session}:${errorText(error)}`);
          });
        }),
      ];

      const offArchive = ctx.provide(sessionArchive, createArchiveReader(options.root));

      return () => {
        // 先拆监听再排空：teardown 期到达的事件不再入孤儿条目（同窗 flush 走空屏障语义）
        for (const off of [...offs, offArchive]) off();
        const closing = [...lives.values()].map((live) =>
          closeSteps(live).catch((error) => {
            report(`session-close-failed:${live.id}:${errorText(error)}`);
          }),
        );
        lives.clear();
        return Promise.all(closing).then(() => {});
      };
    },
  } satisfies Plugin;
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map((inner) => errorText(inner)).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}
