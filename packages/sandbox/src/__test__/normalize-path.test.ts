import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath } from "../normalize-path.ts";

interface FakeTree {
  readonly root: string;
  readonly dirs: Readonly<Record<"inputFirst" | "homeBun" | "homeLocal" | "homeBin" | "extra" | "missing", string>>;
  readonly existing: ReadonlySet<string>;
}

function fakeTree(): FakeTree {
  const root = mkdtempSync(join(tmpdir(), "xh-npath-"));
  const dirs = {
    inputFirst: join(root, "input-first"),
    homeBun: join(root, "home", ".bun", "bin"),
    homeLocal: join(root, "home", ".local", "bin"),
    homeBin: join(root, "home", "bin"),
    extra: join(root, "extra", "bin"),
    missing: join(root, "nope"),
  };
  const existing = new Set([dirs.inputFirst, dirs.homeBun, dirs.homeLocal, dirs.homeBin, dirs.extra]);
  for (const dir of existing) mkdirSync(dir, { recursive: true });
  return { root, dirs, existing };
}

describe("normalizePath：GUI 宿主残缺 PATH 症状（command not found: tavily / bun / brew）", () => {
  it("残缺 PATH（仅 /usr/bin:/bin）补齐 homebrew/bun 目录：~/.bun/bin 与 /opt/homebrew/bin（存在时）进入结果", () => {
    const tree = fakeTree();
    try {
      const out = normalizePath({
        path: "/usr/bin:/bin",
        home: join(tree.root, "home"),
        isDir: (p) => tree.existing.has(p) || p === "/usr/bin" || p === "/bin" || p === "/opt/homebrew/bin",
      });
      const entries = out.split(":");
      expect(entries).toContain(tree.dirs.homeBun);
      expect(entries).toContain(tree.dirs.homeLocal);
      expect(entries).toContain(tree.dirs.homeBin);
      expect(entries.indexOf("/usr/bin")).toBeLessThan(entries.indexOf("/opt/homebrew/bin"));
      expect(entries).not.toContain(tree.dirs.missing);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("调用方 PATH 优先：输入目录排在一切补齐目录之前", () => {
    const tree = fakeTree();
    try {
      const out = normalizePath({
        path: `${tree.dirs.inputFirst}:/usr/bin`,
        home: join(tree.root, "home"),
        isDir: (p) => tree.existing.has(p) || p === "/usr/bin",
      });
      expect(out.split(":")[0]).toBe(tree.dirs.inputFirst);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("extraDirs 追加在输入 PATH 之后、标准目录之前", () => {
    const tree = fakeTree();
    try {
      const out = normalizePath({
        path: tree.dirs.inputFirst,
        home: join(tree.root, "home"),
        extraDirs: [tree.dirs.extra],
        isDir: (p) => tree.existing.has(p) || p === "/usr/bin" || p === "/bin",
      });
      const entries = out.split(":");
      expect(entries.indexOf(tree.dirs.inputFirst)).toBeLessThan(entries.indexOf(tree.dirs.extra));
      expect(entries.indexOf(tree.dirs.extra)).toBeLessThan(entries.indexOf("/usr/bin"));
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("去重：重复目录只出现一次；空段被丢弃；不存在的目录被丢弃", () => {
    const tree = fakeTree();
    try {
      const out = normalizePath({
        path: `${tree.dirs.inputFirst}::${tree.dirs.inputFirst}:${tree.dirs.missing}`,
        home: join(tree.root, "home"),
        isDir: (p) => tree.existing.has(p),
      });
      const entries = out.split(":");
      expect(entries.filter((e) => e === tree.dirs.inputFirst)).toHaveLength(1);
      expect(entries).not.toContain("");
      expect(entries).not.toContain(tree.dirs.missing);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("PATH 未设时仍产出可用标准集（垃圾输入降级不崩溃）", () => {
    const out = normalizePath({ path: undefined, isDir: () => true });
    expect(out).toContain("/usr/bin");
    expect(out).toContain("/bin");
  });

  it("~ 展开基于显式 home，不依赖调用进程的 HOME", () => {
    const tree = fakeTree();
    try {
      const custom = join(tree.root, "home", "custom-bin");
      const out = normalizePath({
        path: "~/custom-bin",
        home: join(tree.root, "home"),
        isDir: (p) => p === custom || tree.existing.has(p),
      });
      expect(out.split(":")[0]).toBe(custom);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("裸 ~ 等价 home 根；全目录不存在时退回原始 PATH 输入", () => {
    const tree = fakeTree();
    try {
      const home = join(tree.root, "home");
      const bare = normalizePath({ path: "~", home, extraDirs: ["~"], isDir: (p) => p === home });
      expect(bare.split(":")[0]).toBe(home);
      expect(bare.split(":")).toHaveLength(1);
      const none = normalizePath({ path: "/ghost/bin", home, isDir: () => false });
      expect(none).toBe("/ghost/bin");
      const unset = normalizePath({ path: undefined, home, isDir: () => false });
      expect(unset).toBe("");
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});
