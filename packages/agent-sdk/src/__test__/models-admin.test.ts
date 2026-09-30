import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addModel, removeModel, modelShapeOf } from "../commands/models.ts";

describe("models admin（providers.json 唯一真相）", () => {
  it("addModel 新 provider 建档（含 apiKeyEnv 透传）与既有 provider 追加模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-models-"));
    try {
      const added = await addModel(root, { id: "m1", provider: "p1", protocol: "openai", baseUrl: "https://p1", apiKeyEnv: "KEY_P1", contextWindow: 1000 });
      expect(added.ok).toBe(true);
      const appended = await addModel(root, { id: "m2", provider: "p1", maxTokens: 500 });
      expect(appended.ok).toBe(true);
      const raw = JSON.parse(await readFile(join(root, "providers.json"), "utf8")) as { providers: Array<{ name: string; models: unknown[]; apiKeyEnv?: string }> };
      const p1 = raw.providers.find((p) => p.name === "p1");
      expect(p1?.models.length).toBe(2);
      expect(p1?.apiKeyEnv).toBe("KEY_P1");
      if (appended.ok) expect(appended.model?.maxTokens).toBe(500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("addModel 校验失败不动文件（invalid_input 家族）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-models-"));
    try {
      const noId = await addModel(root, { provider: "p1" });
      expect(noId.ok === false && noId.error.code).toBe("invalid_input");
      const badProtocol = await addModel(root, { id: "m1", provider: "newp", protocol: "grpc", baseUrl: "https://x" });
      expect(badProtocol.ok === false && badProtocol.error.code).toBe("invalid_input");
      const badWindow = await addModel(root, { id: "m1", provider: "p1", contextWindow: -5 });
      expect(badWindow.ok === false && badWindow.error.code).toBe("invalid_input");
      const raw = await readFile(join(root, "providers.json"), "utf8").catch(() => "");
      expect(raw).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removeModel 拒绝 preset、删除 custom 并清空 provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdk-models-"));
    try {
      await addModel(root, { id: "m1", provider: "p1", protocol: "openai", baseUrl: "https://p1" });
      const missing = await removeModel(root, "no-such");
      expect(missing.ok === false && missing.error.code).toBe("model_unavailable");
      const removed = await removeModel(root, "m1");
      expect(removed.ok).toBe(true);
      const raw = JSON.parse(await readFile(join(root, "providers.json"), "utf8")) as { providers: unknown[] };
      expect(raw.providers.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("modelShapeOf 展平 entry 形状", () => {
    expect(modelShapeOf(undefined)).toBeUndefined();
    const shape = modelShapeOf({ model: "m", provider: "p", reasoning: true, source: "custom", contextWindow: 8 });
    expect(shape).toEqual({ id: "m", provider: "p", contextWindow: 8, reasoning: true, source: "custom" });
  });
});
