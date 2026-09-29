import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface Scene {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly chunks: readonly (string | Buffer)[];
  readonly destroy?: boolean;
  readonly destroyAfterMs?: number;
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
        setTimeout(() => res.destroy(), scene.destroyAfterMs);
        return;
      }
      if (scene.afterDone !== undefined) {
        setTimeout(() => res.write(scene.afterDone?.frame ?? ""), scene.afterDone.delayMs);
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
