import { createServer } from "node:net";
import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { GW_COMMANDS, parseFrame, type Frame, type FrameKind } from "@x-harness/remote-protocol";

export interface OwnerSession {
  send(frame: Omit<Frame, "streamId" | "seq"> & { streamId: string; seq: number }): void;
  closed: boolean;
}

export interface OwnerServerOptions {
  socketPath: string;
  pidFile: string;
  onFrame(session: OwnerSession, frame: Frame): void;
  onConnect?(session: OwnerSession): void;
  onClose?(session: OwnerSession): void;
  log(message: string): void;
}

export interface OwnerServerHandle {
  close(): Promise<void>;
  socketPath: string;
}

export function startOwnerServer(options: OwnerServerOptions): Promise<OwnerServerHandle> {
  if (existsSync(options.socketPath)) {
    try {
      unlinkSync(options.socketPath);
    } catch {
    }
  }
  writeFileSync(options.pidFile, String(process.pid), { encoding: "utf8" });
  const sessions = new Set<OwnerSession>();
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let nextSeq = 1;
    const session: OwnerSession = {
      closed: false,
      send(frame) {
        if (session.closed) return;
        socket.write(`${JSON.stringify(frame)}\n`);
      },
    };
    sessions.add(session);
    options.onConnect?.(session);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) return;
        let line = buffer.subarray(0, nl).toString("utf8");
        buffer = buffer.subarray(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) continue;
        const frame = parseFrame(line);
        if (frame === null) {
          session.send({ kind: "error", streamId: "owner", seq: nextSeq++, body: { code: "bad-frame" } });
        } else {
          nextSeq = Math.max(nextSeq, frame.seq + 1);
          options.onFrame(session, frame);
        }
      }
    });
    socket.on("close", () => {
      session.closed = true;
      sessions.delete(session);
      options.onClose?.(session);
    });
    socket.on("error", () => {
      session.closed = true;
      sessions.delete(session);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      try {
        chmodSync(options.socketPath, 0o600);
      } catch {
        options.log("owner socket chmod 0600 failed (platform mapping)");
      }
      resolve({ close: () =>
        new Promise<void>((resolve2) => {
          server.close(() => resolve2());
        }), socketPath: options.socketPath });
    });
  });
}

export function isGwCommand(command: string): command is (typeof GW_COMMANDS)[number] {
  return (GW_COMMANDS as readonly string[]).includes(command);
}

export type { Frame, FrameKind };
