// 同包共享的 SSE 假服务器装置（docs/LLM.md §3）：Scene 表驱动——分片写制造撕裂、destroy 断连、
// afterDone 挂连接（终止符后 trailing / 连接释放断言用）。
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface Scene {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** 每个元素为一次 write（string | 字节片——按 Buffer.subarray 切片制造真撕裂） */
  readonly chunks: readonly (string | Buffer)[];
  /** 直接断开连接（不写任何响应体） */
  readonly destroy?: boolean;
  /** 写完 chunks 后延迟断连（读体中断：分片已产出、流中途断） */
  readonly destroyAfterMs?: number;
  /** 写完 chunks 后延迟追加 trailing 帧且不 end——只有客户端 cancel 能释放 */
  readonly afterDone?: { readonly delayMs: number; readonly frame: string };
}

export interface SceneServer {
  readonly baseUrl: string;
  readonly captured: () => CapturedRequest | undefined;
  readonly nextScene: (scene: Scene) => void;
  readonly onSocketClose: (fn: () => void) => void;
  readonly close: () => Promise<void>;
}

export interface CapturedRequest {
  readonly method?: string;
  readonly path?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

export async function startSceneServer(): Promise<SceneServer> {
  const server = createServer(cb);
  let capturedValue: CapturedRequest | undefined;
  let scenes: Scene[] = [];
  const closeWatchers: Array<() => void> = [];

  function cb(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      capturedValue = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>,
      };
      const scene = scenes.shift() ?? { status: 200, chunks: [] };
      if (scene.destroy) {
        res.destroy();
        return;
      }
      res.writeHead(scene.status, { "content-type": "text/event-stream", ...scene.headers });
      for (const piece of scene.chunks) res.write(piece);
      if (scene.destroyAfterMs !== undefined) {
        setTimeout(() => res.destroy(), scene.destroyAfterMs); // 读体中断：流中途断
        return;
      }
      if (scene.afterDone !== undefined) {
        setTimeout(() => res.write(scene.afterDone?.frame ?? ""), scene.afterDone.delayMs); // 不 end：等客户端关
        return;
      }
      res.end();
    });
  }

  server.on("connection", (socket: Socket) => {
    socket.on("close", () => {
      for (const watcher of closeWatchers) watcher();
    });
  });

  return await new Promise<SceneServer>((resolve) => {
    const listening = server as Server;
    listening.listen(0, "127.0.0.1", () => {
      const address = listening.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        captured: () => capturedValue,
        nextScene: (scene: Scene) => {
          scenes = [...scenes, scene];
        },
        onSocketClose: (fn: () => void) => {
          closeWatchers.push(fn);
        },
        close: () =>
          new Promise<void>((done) => {
            listening.close(() => done());
          }),
      });
    });
  });
}
