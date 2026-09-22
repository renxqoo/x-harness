// worker 单元件（无进程）：meta-fold 折叠矩阵、entries-window 游标矩阵、main 入口
// 导入（词表/常量面）、catalog-types 形状、script 模式快照。
import { describe, expect, test } from "vitest";
import type { SessionEvent } from "@x-harness/session";
import { foldDial, foldMeta, metaTailOf } from "../shared/meta-fold.ts";
import { entryWindow } from "../worker/entries-window.ts";
import { projectEntries } from "../shared/entries-project.ts";
import { resolveWorkerCatalog, scriptCatalog, workerCatalogFromEnv, catalogEntryOf, catalogModelIds } from "../shared/worker-catalog.ts";
import { imagesUnsupported, thinkingUnsupported, THINKING_LEVELS, PERMISSION_MODES } from "../worker/meta-state.ts";
import { parseCommand } from "@x-harness/commands";
import { withinResponseBudget } from "../worker/worker-read-commands.ts";
import * as workerMain from "../worker/main.ts";
import type { HubProviderProfile } from "../shared/catalog-types.ts";

void workerMain;

function meta(seq: number, key: string, value: unknown): SessionEvent {
  return { type: "session/meta", seq, time: seq, data: { key, value } } as SessionEvent;
}

describe("meta-fold（WAL 尾值单源）", () => {
  test("foldMeta last-wins 全量折叠", () => {
    const record = foldMeta([meta(0, "title", "a"), meta(1, "dial", { provider: "p", model: "m" }), meta(2, "title", "b")]);
    expect(record).toEqual({ title: "b", dial: { provider: "p", model: "m" } });
  });

  test("foldDial 三级回退：meta 显式 > request/header 隐式 > fallback", () => {
    const header = { type: "request/header", seq: 0, time: 0, data: { model: "h-model", provider: "h-prov", tools: [] } } as SessionEvent;
    expect(foldDial([header], { provider: "f", model: "f-model" })).toEqual({ provider: "h-prov", model: "h-model" });
    expect(foldDial([header, meta(1, "dial", { model: "m-model" })], { provider: "f", model: "f-model" })).toEqual({ provider: "f", model: "m-model" });
    expect(foldDial([meta(0, "other", 1)], { provider: "f", model: "f-model" })).toEqual({ provider: "f", model: "f-model" });
    // 坏形状 meta dial（非对象/空 model）跳过
    expect(foldDial([meta(0, "dial", "junk"), meta(1, "dial", { model: "" })], { provider: "f", model: "f-model" })).toEqual({ provider: "f", model: "f-model" });
  });

  test("metaTailOf 单键反向扫首中即止", () => {
    expect(metaTailOf([meta(0, "a", 1), meta(1, "b", 2), meta(2, "a", 3)], "a")).toBe(3);
    expect(metaTailOf([meta(0, "a", 1)], "missing")).toBeUndefined();
  });
});

describe("entries-window 游标矩阵（0 基）", () => {
  const lines = projectEntries([
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: 2, data: { turn: 1, step: 0, content: [] } },
    { type: "assistant/message", seq: 2, time: 3, data: { turn: 1, step: 0, content: [] } },
  ] as SessionEvent[]);

  test("缺省全量 + leafSeq", () => {
    const r = entryWindow(lines, {});
    expect(r.ok && r.entries).toHaveLength(3);
    expect(r.ok && r.leafSeq).toBe(2);
    expect(r.ok && r.hasMore).toBe(false);
  });

  test("since 排他前向 / before 排他后向 / 空窗收敛", () => {
    const since = entryWindow(lines, { since: 0 });
    expect(since.ok && since.entries.map((e) => e.seq)).toEqual([1, 2]);
    const before = entryWindow(lines, { before: 2 });
    expect(before.ok && before.entries.map((e) => e.seq)).toEqual([0, 1]);
    const empty = entryWindow(lines, { since: 2, before: 0 });
    expect(empty.ok && empty.entries).toEqual([]);
  });

  test("limit 取最近 N + hasMore；非法 limit/游标显式失败", () => {
    const r = entryWindow(lines, { limit: 2 });
    expect(r.ok && r.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.ok && r.hasMore).toBe(true);
    expect(entryWindow(lines, { limit: 0 }).ok).toBe(false);
    expect(entryWindow(lines, { limit: 5001 }).ok).toBe(false);
    expect(entryWindow(lines, { since: 99 }).ok).toBe(false);
    expect(entryWindow(lines, { before: 99 }).ok).toBe(false);
  });
});

describe("worker-catalog 解析", () => {
  test("缺席/坏 JSON/坏形状 → 空目录（显式可观察）；合法快照解析 + default 回落链", () => {
    expect(workerCatalogFromEnv({}).providers).toEqual([]);
    expect(workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: "junk" }).providers).toEqual([]);
    expect(workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify({ providers: [{ provider: "x", protocol: "bogus", baseUrl: "u", models: ["m"] }] }) }).providers).toEqual([]);
    const snapshot = JSON.stringify({
      providers: [{ provider: "p1", protocol: "anthropic", baseUrl: "https://p1", apiKey: "k", models: ["m1", "m2"] }],
      default: { provider: "p1", model: "m2" },
      modelMeta: { m1: { reasoning: false } },
    });
    const catalog = workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: snapshot });
    expect(catalog.default).toEqual({ provider: "p1", model: "m2" });
    expect(catalogEntryOf(catalog, { provider: "p1", model: "m1" })?.baseUrl).toBe("https://p1");
    expect(catalogEntryOf(catalog, { provider: "p1", model: "zz" })).toBeUndefined();
    expect(catalogModelIds(catalog)).toEqual(["m1", "m2"]);
    // default 缺席 → 首档案首模型回落
    const noDefault = workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify({ providers: [{ provider: "p1", protocol: "openai", baseUrl: "https://p1", models: ["m1"] }] }) });
    expect(noDefault.default).toEqual({ provider: "p1", model: "m1" });
  });

  test("script 模式快照 + resolveWorkerCatalog 注入缝", () => {
    expect(scriptCatalog().default).toEqual({ provider: "script", model: "script-1" });
    expect(resolveWorkerCatalog({ HUB_WORKER_PROVIDER: "script" }).providers[0]?.provider).toBe("script");
    expect(resolveWorkerCatalog({}).providers).toEqual([]);
  });

  test("thinking 校验：reasoning:false / openai 协议放行 / 缺席档案", () => {
    const catalog = scriptCatalog();
    expect(thinkingUnsupported(catalog, { provider: "script", model: "script-1" }, "high")).toBeUndefined();
    expect(thinkingUnsupported(catalog, { provider: "script", model: "script-1" }, "off")).toBeUndefined();
    expect(thinkingUnsupported(catalog, { provider: "gone", model: "x" }, "low")).toBe("model does not support thinking");
    // openai 协议思考已接通（pi-adapter reasoning 注入）——协议门撤除，仅余 reasoning:false 门
    const openaiLike = { providers: [{ provider: "o", protocol: "openai", baseUrl: "https://o", apiKey: "", models: ["m"] }], default: { provider: "o", model: "m" }, modelMeta: {} };
    const oc = workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify(openaiLike) });
    expect(thinkingUnsupported(oc, { provider: "o", model: "m" }, "low")).toBeUndefined();
    const openaiNoReason = workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify({ providers: [{ provider: "o2", protocol: "openai", baseUrl: "https://o", apiKey: "", models: ["m2"] }], default: { provider: "o2", model: "m2" }, modelMeta: { m2: { reasoning: false } } }) });
    expect(thinkingUnsupported(openaiNoReason, { provider: "o2", model: "m2" }, "low")).toBe("model does not support thinking");
    const noReason = workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify({ providers: [{ provider: "a", protocol: "anthropic", baseUrl: "https://a", apiKey: "", models: ["m"] }], default: { provider: "a", model: "m" }, modelMeta: { m: { reasoning: false } } }) });
    expect(thinkingUnsupported(noReason, { provider: "a", model: "m" }, "low")).toBe("model does not support thinking");
  });
});

describe("命令词法（内核单源——BATCH3 迁移：hub 侧词法删除）", () => {
  test("命中矩阵（词法面用例随内核包 commands.test.ts 全量覆盖）", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", rawInput: "" });
    expect(parseCommand("  /compact keep goals  ")).toEqual({ name: "compact", rawInput: " keep goals" });
    expect(parseCommand("/COMPACT")).toBeUndefined(); // 大写 → conversation
    expect(parseCommand("/compactfoo")).toEqual({ name: "compactfoo", rawInput: "" }); // 未注册词形 → registry miss → conversation
    expect(parseCommand("//compact")).toBeUndefined(); // 注释形态
    expect(parseCommand("plain text")).toBeUndefined();
  });
});

describe("词表封闭性（meta-state）", () => {
  test("thinking/permission 词表与内核对齐", () => {
    expect(THINKING_LEVELS).toEqual(["off", "low", "medium", "high", "max"]);
    expect(PERMISSION_MODES).toEqual(["plan", "auto", "full"]);
  });
});

describe("catalog-types 形状（类型单点导入面）", () => {
  test("ProviderProfile 字段集（编译期形状 + 运行时样例）", () => {
    const profile: HubProviderProfile = { name: "t", protocol: "anthropic", baseUrl: "https://t", models: ["m"] };
    expect(profile.models).toEqual(["m"]);
  });
});

describe("images 能力门（BATCH2-DESIGN §1.1——meta 判据单点）", () => {
  const textOnly = {
    providers: [{ provider: "p", protocol: "anthropic", baseUrl: "http://x", apiKey: "", models: ["m1"] }],
    default: { provider: "p", model: "m1" },
    modelMeta: { m1: { reasoning: true } },
  };
  const vision = {
    ...textOnly,
    modelMeta: { m1: { reasoning: true, input: ["text", "image"] as ("text" | "image")[] } },
  };

  test("无 input 声明 / input 缺 image → 拒；声明含 image → 放行", () => {
    expect(imagesUnsupported(workerCatalogFromSnapshot(textOnly), { provider: "p", model: "m1" })).toBe(
      "invalid images: model does not accept images",
    );
    expect(imagesUnsupported(workerCatalogFromSnapshot(vision), { provider: "p", model: "m1" })).toBeUndefined();
  });

  test("scriptCatalog：script-1 声明 image 模态（携图全链测试不经门误拒）", () => {
    expect(scriptCatalog().modelMeta["script-1"]?.input).toContain("image");
  });
});

function workerCatalogFromSnapshot(snapshot: Record<string, unknown>): ReturnType<typeof workerCatalogFromEnv> {
  return workerCatalogFromEnv({ HUB_WORKER_PROVIDERS: JSON.stringify(snapshot) });
}

describe("get_messages 软上限（BATCH2 审 M6——超 worker 行限以 worker 被杀收场，改有界 failure）", () => {
  test("预算按 JSON 串长累计：超限 false / 界内 true", () => {
    expect(withinResponseBudget([{ role: "user", content: [{ type: "text", text: "hi" }] }], 8192)).toBe(true);
    const huge = [{ role: "user", content: [{ type: "text", text: "x".repeat(200 * 1024) }] }];
    expect(withinResponseBudget(huge, 100 * 1024)).toBe(false);
  });
});

describe("get_messages 软上限字节口径（收口审 K-M1——CJK 3 倍膨胀漏判回归）", () => {
  test("预算按 UTF-8 字节：CJK 串按 3 字节/字计，不按码元漏放", () => {
    const cjkMessage = { role: "user", content: [{ type: "text", text: "中".repeat(50 * 1024) }] };
    expect(JSON.stringify(cjkMessage).length).toBeLessThan(200 * 1024); // 码元口径 < 200KiB
    expect(withinResponseBudget([cjkMessage], 100 * 1024)).toBe(false); // 字节口径 ≈150KiB 超限
  });
});
