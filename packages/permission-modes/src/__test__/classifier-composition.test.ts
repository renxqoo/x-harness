// 分类器组合洞回归件（P0-1/P1-5——.adversarial/upper/u06+u07、redteam F1 迁移）：
// find -exec 载体 + 越根搜索根 / xargs 内联载荷 / 环境面写目标（全局安装·任意包执行·
// 容器生命周期·任意 target）——一律逐出只读/写安全类落 ask。

import { describe, expect, it } from "vitest";
import { classifyPipeline } from "../classifier.ts";
import { parseBash } from "@x-harness/permission";

const ROOT = "/w/app";

function classify(source: string, roots: readonly string[] = [ROOT]): "readonly" | "write" | "unclassified" {
  const parsed = parseBash(source);
  if (!parsed.ok) throw new Error(`unparseable: ${source}`);
  const hasOutputRedirect = parsed.commands.some((cmd) => cmd.redirects.some((r) => r.face === "output" && r.target !== undefined && r.target !== "/dev/null"));
  return classifyPipeline([...parsed.commands], hasOutputRedirect, roots);
}

describe("find -exec 组合洞（P0-1——搜索根从不裁决的载体豁免）", () => {
  it("越根搜索根 + -exec cat → unclassified（旧：载体跳过+载荷只读=readonly 直通外传凭证）", () => {
    for (const command of [
      `find /Users -name id_rsa -exec cat {} ;`,
      `find ~ -name "*.pem" -exec cat {} ;`,
      `find / -name .env -exec cat {} ;`,
    ]) {
      expect(classify(command), command).toBe("unclassified");
    }
  });
  it("xargs 内联载荷参与分类：`find ~ | xargs cat` → unclassified（旧：xargs 载体跳过=readonly）", () => {
    expect(classify(`find ~ -name "*.pem" | xargs cat`)).toBe("unclassified"); // 越根搜索根逐出（find 面门）
    expect(classify(`ls | xargs cat`)).toBe("readonly"); // 界内运行期文件名读=无字面敏感面，与 cat 无字面同径（越根搜索根才是 F1 攻击面）
  });
  it("界内搜索根的良性形仍只读（不误伤）", () => {
    expect(classify(`find . -name x -exec grep foo {} ;`)).toBe("readonly");
    expect(classify(`find . -name "*.ts" | xargs grep foo`)).toBe("readonly");
  });
});

describe("环境面写目标（P1-5——无路径操作数的「界内写」豁免不再成立）", () => {
  it("全局安装/任意包执行 → unclassified（含 -g/--global 旗形）", () => {
    for (const command of ["npm install -g evil-cli", "npm --global install x", "bun x some-pkg", "npm exec --yes sh", "pnpm exec rm"]) {
      expect(classify(command), command).toBe("unclassified");
    }
  });
  it("容器生命周期/任意 target/全局环境写 → unclassified（make 任意 target=任意命令——含裸 make）", () => {
    for (const command of ["docker compose down -v", "make pwn-target", "make", "pip install requests", "uv pip install x", "uv sync"]) {
      expect(classify(command), command).toBe("unclassified");
    }
  });
  it("常规界内写不误伤", () => {
    for (const command of ["npm install", "npm run build", "git add .", "docker build .", "uv run test", "cargo build"]) {
      const out = classify(command);
      expect(["write", "readonly"], command).toContain(out);
    }
  });
});
