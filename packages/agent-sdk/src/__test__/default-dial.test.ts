
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalogSnapshot } from "../catalog.ts";

describe("resolveDefaultDial 统一（K9 尾项）", () => {
  it("default 指向无 key provider → fallbackDial undefined（不拿不可拨默认）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-defdial-"));
    try {
      await writeFile(join(root, "providers.json"), JSON.stringify({
        providers: [
          { name: "nokey", protocol: "anthropic", baseUrl: "https://n.example", models: ["m"] },
          { name: "haskey", protocol: "anthropic", baseUrl: "https://h.example", apiKey: "k", models: ["m2"] },
        ],
        default: { provider: "nokey", model: "m" },
      }), "utf8");
      const snapshot = await loadCatalogSnapshot(root, {});
      expect(snapshot.fallbackDial).toBeUndefined();
      expect(snapshot.dialable("m2")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
