// jsonl 持久化桥：pending 内存队列 + per-id 串行链（一切磁盘写只经此链，docs/SESSION.md §1.8 单一不变量）。
// 链来源三处：created 首灌（构造期全量）、flush 增量排空、disposed/卸载终排空；同 id 重用 fail-closed。
// 装配契约：须早于 session-checkpoint 装载（teardown 逆序回卷时 checkpoint 挂点先拆、本层
// 终排空殿后）；由 checkpoint 侧 softInject ["session-persistence-jsonl"] topo 固化。

import { join } from "node:path";
import { errorText } from "@x-harness/core";
import type { Context, Disposer, Plugin } from "@x-harness/core";
import { sessionArchive, sessionCreated, sessionDisposed, sessionEvent, sessionFlush, sessionStore } from "@x-harness/session";
import type { SessionEvent, SessionHeader, SessionId } from "@x-harness/session";
import { createArchiveReader } from "./archive.ts";
import { openSessionWriter } from "./writer.ts";
import type { SessionWriter } from "./writer.ts";
import { isPermanentRejection } from "./writer.ts";

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
          const opened = await openSessionWriter(join(options.root, live.id), live.header, store.get(live.id)?.events() ?? []);
          live.writer = opened.writer;
          // 续写模式：磁盘已落账前缀不重写——pending 按前缀长度裁剪（await 期间新到事件在尾部，不受影响）
          if (opened.prefixLength > 0) {
            live.pending = live.pending.slice(opened.prefixLength);
          }
          return live.writer;
        } catch (error) {
          // 永久性拒绝（重用/档案损坏/前缀不符）闩 dead 并按来源报文；瞬时 I/O 错误上抛可重试
          if (isPermanentRejection(error)) {
            live.dead = error instanceof Error ? error.message : String(error);
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
          // 长度快照：await 期间新到事件追加尾部，slice 按快照截断——活引用会让批次长度膨胀、误切未写事件
          const size = live.pending.length;
          const lines = live.pending.slice(0, size).map((event) => `${JSON.stringify(event)}\n`);
          // 写入成功后才移除已写批次：失败时按序保留供下次 flush 重试
          await writer.append(lines);
          live.pending = live.pending.slice(size);
        }
        await writer.sync();
      }

      function closeSteps(live: LiveSession): Promise<void> {
        return runSegment(live, async () => {
          // 终排空失败不得泄漏 fd：drain 捕获错误，writer 无条件关闭后再重抛
          let drainError: unknown;
          if (!live.closed && live.dead === undefined) {
            try {
              await drainSteps(live);
            } catch (error) {
              drainError = error;
            }
          }
          live.closed = true;
          const writer = live.writer;
          live.writer = undefined;
          if (writer !== undefined) await writer.close();
          if (drainError !== undefined) throw drainError;
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
          void runSegment(live, () => drainSteps(live)).catch((error) => {
            report(`session-created-persist-failed:${header.id}:${errorText(error)}`);
          });
        }),
        ctx.on(sessionEvent, ({ session, event }) => {
          liveOf(session).pending.push(event);
        }),
        ctx.on(sessionFlush, ({ session }) => {
          const live = lives.get(session);
          if (live === undefined) return undefined;
          return runSegment(live, () => drainSteps(live));
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

