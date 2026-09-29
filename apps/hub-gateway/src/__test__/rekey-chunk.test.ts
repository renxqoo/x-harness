import { describe, expect, it, vi } from "vitest";
import { chunkFrame, CHUNK_SEGMENT_BYTES } from "@x-harness/remote-protocol";
import type { Frame } from "@x-harness/remote-protocol";

describe("rekey 调度（performRekey 面）", () => {
  it("到期设备会话触发 rekey 帧 + rekeyCounter 持久化 + 审计", { timeout: 15000 }, async () => {
    const { startGateway } = await import("../main.ts");
    const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "rekey-"));
    await mkdir(join(dir, "devices"), { recursive: true });
    await writeFile(join(dir, "gateway.json"), "{}", "utf8");
    const gw = await startGateway({
      agentDir: dir,
      hostOverride: { command: process.execPath, args: [new URL("./fake-host.ts", import.meta.url).pathname, "--fake-host"] },
      rekeySweepMs: 150,
      log: () => {},
    });
    const gwEph = (await import("@x-harness/remote-protocol")).generateBoxKeyPair();
    const devEph = (await import("@x-harness/remote-protocol")).generateBoxKeyPair();
    const shared = (await import("@x-harness/remote-protocol")).x25519(gwEph.secret, devEph.pub)!;
    const session = gw.cryptoSessions.establish({ deviceId: "d_rk", sharedSecret: shared, initiator: true });
    (session as { establishedAt: number }).establishedAt = Date.now() - 25 * 60 * 60 * 1000;
    gw.devices.put({ deviceId: "d_rk", name: "R", deviceType: "phone", platform: "ios", appVersion: "1", longTermPub: "rk", scope: "full", pairedAt: 0, lastSeenAt: 0, rekeyCounter: 0 });
    await new Promise((r) => { setTimeout(r, 600); });
    const entryAfter = gw.devices.get("d_rk");
    expect(entryAfter?.rekeyCounter).toBeGreaterThan(0);

    const auditFiles = await readFile(join(dir, "audit", (await (await import("node:fs/promises")).readdir(join(dir, "audit")))[0]!), "utf8");
    expect(auditFiles).toContain("rekey-performed");
    await gw.stop();
  });
});

describe("chunk 出站（sendToDevice 链路）", () => {
  it("大帧切段数与段尺寸预算（§3.5：段密文+base64 ≤12MiB）", () => {
    const frame: Frame = { kind: "event", streamId: "ev:t1", seq: 1, body: { threadId: "t1", name: "n", payload: { blob: "x".repeat(CHUNK_SEGMENT_BYTES + 100) } } };
    const segs = chunkFrame(frame);
    expect(segs).not.toBeNull();
    expect(segs!.length).toBe(2);
    for (const seg of segs!) {
      const sealed = Buffer.from(seg.data, "base64");
      expect(sealed.length).toBeLessThanOrEqual(CHUNK_SEGMENT_BYTES);
    }
  });
});

void vi;
