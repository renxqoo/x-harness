import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkClient } from "../client.ts";

describe("K9 in-process reload：sdk.reloadModels()（只增不换契约）", () => {
  it("重读 providers.json → 新 provider 对已装配线程注册缺失 adapter（added 含新名）；已存在 provider 跳过", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-reload-"));
    try {
      const writeProviders = async (names: readonly string[]): Promise<void> => {
        await writeFile(join(root, "providers.json"), JSON.stringify({
          providers: names.map((name) => ({ name, protocol: "anthropic", baseUrl: `https://${name}.example`, apiKey: "k", models: [`${name}-m`] })),
          default: { provider: names[0] ?? "", model: `${names[0] ?? ""}-m` },
        }), "utf8");
      };
      await writeProviders(["a"]);
      const sdk = createSdkClient({
        mode: "in-process",
        agentDir: root,
        sessionsRoot: join(root, "sessions"),
        env: { HUB_WORKER_PROVIDER: "real", HUB_WORKER_SCRIPT: "" },
        onEvent: () => {},
      });
      const started = await sdk.startThread({ cwd: root, trusted: false });
      expect(started.ok).toBe(true);
      await writeProviders(["a", "b"]);
      const reloaded = await sdk.reloadModels();
      expect(reloaded.ok).toBe(true);
      if (reloaded.ok) expect(reloaded.value.added).toContain("b");
      const again = await sdk.reloadModels();
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.value.added).not.toContain("b");
      if (started.ok) await started.value.stop();
      await sdk.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
