// 大级试运行切片（docs/PLUGIN-MANAGER.md 测试口径 worker-slice）：
// 验证四条最高风险假设，跑不通则回改方案再全量——验证的是流程本身。
//   ① bun + vitest 下 node:worker_threads 可用且能加载 TS 模块入口
//   ② 内核（@x-harness/core）能在 worker 内真实启动
//   ③ 用户 TS 插件从磁盘动态加载（绝对路径 import + query 缓存 bust）
//   ④ 消息桥双向（服务 RPC main→worker / svc-call worker→main / 事件投递）+ 卡死击杀真实工作
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, defineEvent, defineService } from "@x-harness/core";
import type { WorkerToMain } from "../worker/protocol.ts";

const HOST_PATH = resolve(import.meta.dirname, "../worker/host.ts");
const CORE_PATH = resolve(import.meta.dirname, "../../../core/src/index.ts");
const tempDirs: string[] = [];

const noop = (): void => {};

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  worker: Worker;
  received: WorkerToMain[];
  wait(predicate: (m: WorkerToMain) => boolean, ms?: number): Promise<WorkerToMain>;
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  emitIn(token: string, payload: unknown): void;
  terminate(): Promise<void>;
}

function bootWorker(pluginPath: string, platform: { services: Map<string, unknown> }): Harness {
  const received: WorkerToMain[] = [];
  const waiters: { predicate: (m: WorkerToMain) => boolean; resolve(m: WorkerToMain): void; timer: ReturnType<typeof setTimeout> }[] = [];
  const worker = new Worker(HOST_PATH);
  let callId = 0;
  const pendingCalls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  worker.on("message", (message: WorkerToMain) => {
    received.push(message);
    if (message.t === "ready") {
      worker.postMessage({ t: "proceed" }); // 三段式：ready 后放行 apply
    }
    if (message.t === "svc-call") {
      const impl = platform.services.get(message.service) as Record<string, unknown> | undefined;
      Promise.resolve()
        .then(() => {
          if (impl === undefined || typeof impl[message.method] !== "function") {
            throw new Error(`no platform service ${message.service}`);
          }
          return (impl[message.method] as (...a: unknown[]) => unknown)(...message.args);
        })
        .then(
          (value) => worker.postMessage({ t: "svc-result", id: message.id, ok: true, value }),
          (error: unknown) =>
            worker.postMessage({ t: "svc-result", id: message.id, ok: false, error: String(error) }),
        );
      return;
    }
    if (message.t === "call-result") {
      const pending = pendingCalls.get(message.id);
      if (pending === undefined) return;
      pendingCalls.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      return;
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter === undefined) continue;
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(message);
      }
    }
  });

  worker.postMessage({ t: "boot", pluginPath, kernelApiVersion: 1 });

  return {
    worker,
    received,
    wait(predicate, ms = 4000) {
      const existing = received.toReversed().find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<WorkerToMain>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          const at = waiters.findIndex((w) => w.resolve === resolveWait);
          if (at >= 0) waiters.splice(at, 1);
          rejectWait(new Error("slice: message wait timeout"));
        }, ms);
        waiters.push({ predicate, resolve: resolveWait, timer });
      });
    },
    call(service, method, args) {
      callId += 1;
      const id = callId;
      return new Promise<unknown>((resolveCall, rejectCall) => {
        pendingCalls.set(id, { resolve: resolveCall, reject: rejectCall });
        worker.postMessage({ t: "call", id, service, method, args });
      });
    },
    emitIn(token, payload) {
      worker.postMessage({ t: "emit", token, payload });
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

async function writePlugin(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pm-slice-"));
  tempDirs.push(dir);
  const file = join(dir, `${name}.ts`);
  await writeFile(file, source, "utf8");
  return file;
}

describe("worker 桥切片（大级试运行）", () => {
  it("完整链路：boot→ready→提供桥→服务 RPC→事件投递→平台服务反向调用", async () => {
    const platform = createContext();
    const platformServices = new Map<string, unknown>();
    platformServices.set(
      "pm-slice-platform",
      { greet: (who: string) => `hello ${who} from platform` },
    );
    platform.provide(defineService<{ greet(w: string): string }>("pm-slice-platform"), platformServices.get("pm-slice-platform") as { greet(w: string): string });

    const pluginPath = await writePlugin(
      "full",
      `import { defineEvent, defineService } from "${CORE_PATH}";
export const ping = defineEvent<{ v: number }>("pm-slice-ping");
export default {
  name: "slice-full",
  apply: (ctx) => {
    ctx.provide(defineService<{ hello(name: string): string }>("pm-slice-svc"), {
      hello: (n) => \`hi \${n} from worker\`,
    });
    ctx.on(ping, ({ v }) => {
      void v;
    });
  },
};
`,
    );

    const h = bootWorker(pluginPath, { services: platformServices });
    try {
      await expect(h.wait((m) => m.t === "ready")).resolves.toMatchObject({ pluginName: "slice-full" });
      await expect(h.wait((m) => m.t === "provided" && m.service === "pm-slice-svc")).resolves.toBeTruthy();
      await expect(h.wait((m) => m.t === "listening" && m.token === "pm-slice-ping")).resolves.toMatchObject({ mode: "emit" });
      await expect(h.wait((m) => m.t === "apply-done")).resolves.toBeTruthy();

      // main → worker 服务 RPC
      await expect(h.call("pm-slice-svc", "hello", ["world"])).resolves.toBe("hi world from worker");

      // main → worker 事件投递 → 监听器执行 → heard 回流
      h.emitIn("pm-slice-ping", { v: 7 });
      await expect(h.wait((m) => m.t === "heard" && m.token === "pm-slice-ping")).resolves.toMatchObject({ payload: { v: 7 } });

      // 平台存活（main 侧照常）
      const tick = defineEvent<{ v: number }>("pm-slice-platform-alive");
      const heard: number[] = [];
      platform.on(tick, ({ v }) => heard.push(v));
      platform.emit(tick, { v: 1 });
      expect(heard).toEqual([1]);
    } finally {
      await h.terminate();
    }
  });

  it("反向：worker 插件经 use 调用平台服务（svc-call RPC）", async () => {
    const platformServices = new Map<string, unknown>();
    platformServices.set("pm-slice-db", { query: (sql: string) => `rows(${sql})` });
    const pluginPath = await writePlugin(
      "reverse",
      `import { defineService } from "${CORE_PATH}";
export default {
  name: "slice-reverse",
  apply: (ctx) => {
    ctx.provide(defineService<{ run(sql: string): Promise<string> }>("pm-slice-runner"), {
      run: async (sql) => {
        const db = ctx.use(defineService<{ query(sql: string): string }>("pm-slice-db"));
        return db.query(sql);
      },
    });
  },
};
`,
    );
    const h = bootWorker(pluginPath, { services: platformServices });
    try {
      await h.wait((m) => m.t === "apply-done");
      await expect(h.call("pm-slice-runner", "run", ["select 1"])).resolves.toBe("rows(select 1)");
    } finally {
      await h.terminate();
    }
  });

  it("卡死击杀：apply 死循环 → main 超时 terminate → 装载失败、平台无恙", async () => {
    const platform = createContext();
    const platformServices = new Map<string, unknown>();
    const pluginPath = await writePlugin(
      "hang",
      `export default {
  name: "slice-hang",
  apply: () => {
    while (true) {} // 同步死循环：冻结 worker 事件循环——main 侧唯一生路是 terminate
  },
};
`,
    );
    const h = bootWorker(pluginPath, { services: platformServices });
    try {
      // ready 会在 apply 前发出；apply-done 永远不来
      await expect(h.wait((m) => m.t === "ready")).resolves.toMatchObject({ pluginName: "slice-hang" });
      const applyDone = h.wait((m) => m.t === "apply-done", 600);
      await expect(applyDone).rejects.toThrow("timeout");
      await h.terminate(); // 击杀
      // 平台无恙
      const tick = defineEvent<{ v: number }>("pm-slice-after-kill");
      const heard: number[] = [];
      platform.on(tick, ({ v }) => heard.push(v));
      platform.emit(tick, { v: 1 });
      expect(heard).toEqual([1]);
      expect(() => platform.effect(noop)).not.toThrow();
    } finally {
      await h.terminate();
    }
  }, 15000);

  it("worker 崩溃收殓：apply 抛错 → apply-error 回流，平台继续", async () => {
    const platform = createContext();
    const platformServices = new Map<string, unknown>();
    const pluginPath = await writePlugin(
      "crash",
      `export default {
  name: "slice-crash",
  apply: () => {
    throw new Error("apply exploded");
  },
};
`,
    );
    const h = bootWorker(pluginPath, { services: platformServices });
    try {
      await expect(h.wait((m) => m.t === "apply-error")).resolves.toMatchObject({
        error: expect.stringContaining("apply exploded"),
      });
      const tick = defineEvent<{ v: number }>("pm-slice-after-crash");
      const heard: number[] = [];
      platform.on(tick, ({ v }) => heard.push(v));
      platform.emit(tick, { v: 1 });
      expect(heard).toEqual([1]);
    } finally {
      await h.terminate();
    }
  });
});
