import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalogSnapshot, scriptSnapshotOf } from "../catalog.ts";

describe("in-process catalog 快照（K9 半边）", () => {
  it("providers.json + credentials.json → adapters/dial/谓词全链", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-catalog-"));
    try {
      await writeFile(join(root, "providers.json"), JSON.stringify({
        providers: [
          { name: "p1", protocol: "anthropic", baseUrl: "https://p1.example", apiKeyEnv: "KEY_P1", models: ["m1"] },
          { name: "p2", protocol: "openai", baseUrl: "https://p2.example", apiKey: "inline-key", models: ["m2"] },
          { name: "p3", protocol: "anthropic", baseUrl: "https://p3.example", models: ["m3"] },
        ],
        default: { provider: "p2", model: "m2" },
      }), "utf8");
      await writeFile(join(root, "credentials.json"), JSON.stringify({ p1: { apiKey: "cred-key" } }), "utf8");
      const snapshot = await loadCatalogSnapshot(root, { KEY_P1: "env-key" });
      expect(snapshot.adapters.map((a) => a.name).sort()).toEqual(["p1", "p2"]);
      expect(snapshot.dial).toEqual({ provider: "p2", model: "m2" });
      expect(snapshot.dialable("p1/m1")).toBe(true);
      expect(snapshot.dialable("p3/m3")).toBe(false);
      expect(snapshot.dialable("m1")).toBe(true);
      expect(snapshot.resolveProviderOf("m3")).toBeUndefined();
      expect(snapshot.fallbackDial).toEqual({ provider: "p2", model: "m2" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("credentials 优先于 env、env 优先于无 key（p3 无 key 被跳过）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-catalog2-"));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "providers.json"), JSON.stringify({
        providers: [{ name: "px", protocol: "anthropic", baseUrl: "https://x", apiKey: "inline", apiKeyEnv: "KEY_PX", models: ["mx"] }],
        default: { provider: "px", model: "mx" },
      }), "utf8");
      await writeFile(join(root, "credentials.json"), JSON.stringify({ px: { apiKey: "" } }), "utf8");
      const snapshot = await loadCatalogSnapshot(root, {});
      expect(snapshot.adapters.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scriptSnapshotOf：非 script env 返回 undefined", () => {
    expect(scriptSnapshotOf({})).toBeUndefined();
    expect(scriptSnapshotOf({ HUB_WORKER_PROVIDER: "script" })?.dial).toEqual({ provider: "script", model: "script-1" });
  });
});
