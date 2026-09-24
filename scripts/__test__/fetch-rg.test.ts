// fetch-rg 纯函数、幂等判定与 tar 抽取单测（docs/TOOLBOX.md §5 获取形态）：平台映射 /
// sha 表 / manifest 幂等 / target 解析 / extractWithTar 真链路（本地 tar 造 fixture——零网络；
// 网络下载面由打包机实跑背书 fetch:rg）。

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RG_TARGETS, RG_VERSION, distBinDir, extractWithTar, isUpToDate, manifestOf, memberPathOf, resolveRequestedTarget, targetKeyOf, targetOf, downloadUrlOf } from "../fetch-rg.ts";

let dir = "";
afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("fetch-rg 平台矩阵（按平台打包——什么平台打什么包）", () => {
  it("targetKeyOf：darwin/linux × arm64/x64 四键；win32 → null（POSIX-only）", () => {
    expect(targetKeyOf("darwin", "arm64")).toBe("darwin-arm64");
    expect(targetKeyOf("darwin", "x64")).toBe("darwin-x64");
    expect(targetKeyOf("linux", "arm64")).toBe("linux-arm64");
    expect(targetKeyOf("linux", "x64")).toBe("linux-x64");
    expect(targetKeyOf("win32", "x64")).toBeNull();
    expect(targetKeyOf("darwin", "ia32")).toBeNull();
  });

  it("矩阵四目标 sha256 全在场且定长；linux-x64 = musl 静态（15.1.0 无 x64-gnu 官方资产）", () => {
    expect(Object.keys(RG_TARGETS).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
    for (const target of Object.values(RG_TARGETS)) {
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(target.triple).not.toContain(" ");
    }
    expect(targetOf("linux-x64").triple).toBe("x86_64-unknown-linux-musl");
  });

  it("downloadUrlOf/memberPathOf：官方 release 固定布局", () => {
    const t = targetOf("darwin-arm64");
    expect(downloadUrlOf(t)).toBe(`https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`);
    expect(memberPathOf(t)).toBe(`ripgrep-${RG_VERSION}-aarch64-apple-darwin/rg`);
  });

  it("distBinDir：仓根锚 apps/host-hub/dist/bin（打包 staging 口径）", () => {
    expect(distBinDir("/repo")).toBe(join("/repo", "apps/host-hub/dist/bin"));
  });
});

describe("fetch-rg --target 解析（交叉打包矩阵：mac runner 可打 linux 包）", () => {
  it("缺省取当前平台；--target 收矩阵键或 triple 两形态", () => {
    const local = resolveRequestedTarget([], "darwin", "arm64");
    if ("error" in local) throw new Error(local.error);
    expect(local.key).toBe("darwin-arm64");

    const byTriple = resolveRequestedTarget(["--target", "x86_64-unknown-linux-musl"], "darwin", "arm64");
    if ("error" in byTriple) throw new Error(byTriple.error);
    expect(byTriple.target).toBe(targetOf("linux-x64"));

    const byKey = resolveRequestedTarget(["--target", "linux-arm64"], "darwin", "arm64");
    if ("error" in byKey) throw new Error(byKey.error);
    expect(byKey.target.triple).toBe("aarch64-unknown-linux-gnu");
  });

  it("不支持的平台（缺省）与未知 target（显式）→ fail-closed 报错带已知清单", () => {
    const unsupported = resolveRequestedTarget([], "win32", "x64");
    expect("error" in unsupported && unsupported.error).toContain("unsupported platform");
    const unknown = resolveRequestedTarget(["--target", "nope"], "darwin", "arm64");
    expect("error" in unknown && unknown.error).toContain("x86_64-unknown-linux-musl");
  });

  it("--target 漏值 → fail-closed 报错（不静默回落当前平台）", () => {
    const missing = resolveRequestedTarget(["--target"], "darwin", "arm64");
    expect("error" in missing && missing.error).toContain("requires a value");
  });
});

describe("fetch-rg extractWithTar（真 tar 抽取——零网络全链）", () => {
  it("抽单成员到 dest：内容精确（多成员档案不串成员）", async () => {
    dir = mkdtempSync(join(tmpdir(), "xh-frg-tar-"));
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg/rg"), "fake-binary-bytes");
    writeFileSync(join(dir, "pkg/README.md"), "noise");
    const archive = join(dir, "bundle.tar.gz");
    const proc = Bun.spawn(["tar", "-czf", archive, "-C", dir, "pkg/rg", "pkg/README.md"]);
    const code = await proc.exited;
    expect(code).toBe(0);
    const dest = join(dir, "out-rg");
    await extractWithTar(archive, "pkg/rg", dest);
    expect(readFileSync(dest, "utf8")).toBe("fake-binary-bytes");
  });

  it("成员缺席 → 报 tar 退出码非零（fail-closed 非 silent 空产物）", async () => {
    dir = mkdtempSync(join(tmpdir(), "xh-frg-tar-miss-"));
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg/rg"), "x");
    const archive = join(dir, "bundle.tar.gz");
    const proc = Bun.spawn(["tar", "-czf", archive, "-C", dir, "pkg/rg"]);
    await proc.exited;
    const dest = join(dir, "out-rg");
    await expect(extractWithTar(archive, "pkg/no-such", dest)).rejects.toThrow("tar extract failed");
  });
});

describe("fetch-rg 幂等判定（rg.json manifest × 盘上 rg 双在场）", () => {
  it("manifest 与期望一致且 rg 在场 → up-to-date", () => {
    dir = mkdtempSync(join(tmpdir(), "xh-frg-ok-"));
    const target = targetOf("darwin-arm64");
    const manifestPath = join(dir, "rg.json");
    const rgPath = join(dir, "rg");
    writeFileSync(rgPath, "binary-bytes");
    writeFileSync(manifestPath, JSON.stringify(manifestOf(target)));
    expect(isUpToDate(manifestPath, rgPath, manifestOf(target))).toBe(true);
  });

  it("manifest 缺席/损坏/版本或目标不匹配/rg 缺席 → 不幂等（重取）", () => {
    dir = mkdtempSync(join(tmpdir(), "xh-frg-stale-"));
    const a = targetOf("darwin-arm64");
    const b = targetOf("linux-x64");
    const manifestPath = join(dir, "rg.json");
    const rgPath = join(dir, "rg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(rgPath, "binary-bytes");
    expect(isUpToDate(manifestPath, rgPath, manifestOf(a))).toBe(false); // manifest 缺席
    writeFileSync(manifestPath, "not json {");
    expect(isUpToDate(manifestPath, rgPath, manifestOf(a))).toBe(false); // 损坏
    writeFileSync(manifestPath, JSON.stringify(manifestOf(b)));
    expect(isUpToDate(manifestPath, rgPath, manifestOf(a))).toBe(false); // 目标不匹配（交叉重打包）
    rmSync(rgPath, { force: true });
    writeFileSync(manifestPath, JSON.stringify(manifestOf(a)));
    expect(isUpToDate(manifestPath, rgPath, manifestOf(a))).toBe(false); // rg 缺席
  });

  it("manifestOf：version/target/sha256 三字段与 RG_VERSION 同源", () => {
    const m = manifestOf(targetOf("linux-x64"));
    expect(m).toEqual({ version: RG_VERSION, target: "x86_64-unknown-linux-musl", sha256: targetOf("linux-x64").sha256 });
  });
});
