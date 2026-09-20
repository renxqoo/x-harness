// limits/images 契约矩阵（MIGRATION §5 对应行移植 + 新增锚）：缺省单点、坏值降级、
// idle/rss clamp 区间、图片块归一与坏形状整体拒绝。
import { describe, expect, test } from "vitest";
import {
  BASH_CONCURRENCY,
  CONFIRM_TIMEOUT_MS,
  clampIdleRetireMs,
  clampRssRetireBytes,
  readLimits,
} from "../shared/limits.ts";
import { normalizeImages } from "../shared/images.ts";

describe("limits", () => {
  test("缺省值单点（env 缺席）", () => {
    const l = readLimits({});
    expect(l.maxThreads).toBe(32);
    expect(l.idleRetireMs).toBe(900_000);
    expect(l.workerStaleMs).toBe(30_000);
    expect(l.workerExitTimeoutMs).toBe(10_000);
    expect(l.rssRetireBytes).toBe(0);
    expect(l.bashTimeoutMs).toBe(600_000);
    expect(CONFIRM_TIMEOUT_MS).toBe(300_000);
    expect(BASH_CONCURRENCY).toBe(8);
  });

  test("坏值降级缺省（非整数/空串）", () => {
    expect(readLimits({ HUB_MAX_THREADS: "abc" }).maxThreads).toBe(32);
    expect(readLimits({ HUB_MAX_THREADS: "" }).maxThreads).toBe(32);
    expect(readLimits({ HUB_MAX_THREADS: "4" }).maxThreads).toBe(4);
  });

  test("idle clamp 区间 [1s, 24h]", () => {
    expect(clampIdleRetireMs(1)).toBe(1_000);
    expect(clampIdleRetireMs(100 * 3600_000)).toBe(24 * 3600_000);
    expect(clampIdleRetireMs(5_000)).toBe(5_000);
  });

  test("rss：0=关；开则 [256MiB, 2TiB]（env 值过同 clamp 防死亡循环）", () => {
    expect(clampRssRetireBytes(0)).toBe(0);
    expect(clampRssRetireBytes(1000)).toBe(256 * 1024 * 1024);
    expect(clampRssRetireBytes(5 * 1024 ** 4)).toBe(2 * 1024 ** 3 * 1024);
    expect(readLimits({ HUB_RSS_RETIRE_BYTES: "1048576" }).rssRetireBytes).toBe(256 * 1024 * 1024);
  });
});

describe("images", () => {
  test("缺席/空数组归 undefined", () => {
    expect(normalizeImages(undefined)).toEqual({ ok: true, images: undefined });
    expect(normalizeImages([])).toEqual({ ok: true, images: undefined });
  });

  test("合法块归一（mediaType 字段名）", () => {
    const r = normalizeImages([{ type: "image", data: "aGk=", mediaType: "image/png" }]);
    expect(r.ok && r.images?.[0]).toEqual({ type: "image", data: "aGk=", mediaType: "image/png" });
  });

  test("坏形状整体拒绝（不静默丢块）", () => {
    for (const bad of [
      "x",
      [{}],
      [{ type: "text", data: "a", mediaType: "m" }],
      [{ type: "image", data: "", mediaType: "m" }],
      [{ type: "image", data: "a" }],
    ]) {
      expect(normalizeImages(bad).ok).toBe(false);
    }
  });
});
