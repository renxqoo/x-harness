import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { connect as netConnect } from "node:net";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../main.ts";

let gw: Awaited<ReturnType<typeof startGateway>>;
let agentDir: string;

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "gw-pair-fail-"));
  await mkdir(join(agentDir, "devices"), { recursive: true });
  await writeFile(join(agentDir, "gateway.json"), JSON.stringify({ remoteEnabled: false, relayUrl: "", relayKeyFingerprint: "" }), "utf8");
  const fakeHost = new URL("./fake-host.ts", import.meta.url).pathname;
  gw = await startGateway({ agentDir, hostOverride: { command: process.execPath, args: [fakeHost, "--fake-host"] }, log: () => {} });
}, 30000);

afterAll(async () => {
  await gw.stop();
});

describe("症状回归：配对失败以未捕获 rejection 穿出网关进程（配对命令之后再无应答）", () => {
  it("gw/pairing/start 失败回原因，随后 gw/status 仍可应答", { timeout: 20000 }, async () => {
    const ownerSock = netConnect(gw.ownerServer.socketPath);
    await new Promise<void>((resolve, reject) => {
      ownerSock.once("connect", resolve);
      ownerSock.once("error", reject);
    });
    const lines: string[] = [];
    ownerSock.on("data", (c: Buffer) => {
      for (const line of c.toString().split("\n")) if (line) lines.push(line);
    });
    const waitOwner = async (id: string, ms = 8000): Promise<Record<string, unknown>> => {
      for (let i = 0; i < ms / 50; i++) {
        await new Promise((r) => {
          setTimeout(r, 50);
        });
        const hit = lines.find((l) => l.includes(`"id":"${id}"`));
        if (hit !== undefined) return JSON.parse(hit).body as Record<string, unknown>;
      }
      throw new Error(`owner response timeout: ${id}`);
    };

    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 1, body: { command: "gw/pairing/start", id: "pfail", args: { scope: "interact", mode: "qr" } } })}\n`);
    const failed = await waitOwner("pfail");
    expect(failed.success).toBe(false);
    expect(String(failed.error)).toContain("relayKeyFingerprint");

    ownerSock.write(`${JSON.stringify({ kind: "command", streamId: "owner", seq: 2, body: { command: "gw/status", id: "pafter", args: {} } })}\n`);
    const status = await waitOwner("pafter");
    expect(status.success).toBe(true);
    expect((status.data as { hostAlive: boolean }).hostAlive).toBe(true);

    ownerSock.destroy();
  });
});
