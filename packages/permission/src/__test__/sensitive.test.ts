// argv 敏感面（U12——直通档读底线/保护写补偿）：argv 文件实参命中拒读表/保护写面 →
// 管线强制 ask；普通界内路径不误伤；~user 形保守敏感。

import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { argvSensitiveHit } from "../sensitive.ts";
import { parseBash } from "../bash/ast.ts";
import { baselineDenyRules, DEFAULT_DENY_READ_OUTSIDE } from "../baseline.ts";

/** C①（2026-09-28）：基线表内核单源——测试与中心装配同源；恒拒/条件两表分传（生产同构） */
const DENY_READ = baselineDenyRules().filter((r) => r.tool === "Read" && r.outsideRoots !== true).map((r) => r.pattern);
const DENY_READ_OUTSIDE = DEFAULT_DENY_READ_OUTSIDE;
const DENY_WRITE = baselineDenyRules().filter((r) => r.tool === "Write").map((r) => r.pattern);

const ROOT = "/w/app";

function hitOf(source: string, protectedWrite: readonly string[] = []) {
  const parsed = parseBash(source);
  if (!parsed.ok) throw new Error(`unparseable: ${source}`);
  return argvSensitiveHit(parsed.commands, ROOT, { protectedWrite, denyRead: DENY_READ, denyWrite: DENY_WRITE, denyReadOutside: DENY_READ_OUTSIDE, allowRoots: [ROOT] });
}

describe("argvSensitiveHit", () => {
  it("拒读表命中：~/.ssh/~/.aws（任意位置）与 .env 族（根集外）（相对/绝对/~ 三形态）", () => {
    expect(hitOf("cat ~/.ssh/id_rsa")).toMatchObject({ kind: "deny-read" });
    expect(hitOf("cp ~/.aws/credentials .")).toMatchObject({ kind: "deny-read" });
    expect(hitOf(`cat ${join(homedir(), ".gcp", "key.json")}`)).toMatchObject({ kind: "deny-read" });
  });

  it(".env 族位置条件（2026-09-28 裁决）：根集外命中 deny-read；根集内（项目本地配置）不敏感", () => {
    const tables = { protectedWrite: [] as readonly string[], denyRead: DENY_READ, denyWrite: DENY_WRITE, denyReadOutside: DENY_READ_OUTSIDE, allowRoots: [ROOT] };
    const parsedOutside = parseBash("cat /etc/app/.env");
    const outside = argvSensitiveHit(parsedOutside.ok ? parsedOutside.commands : [], ROOT, tables);
    expect(outside).toMatchObject({ kind: "deny-read" });
    expect(hitOf("cat sub/.envrc")).toBeUndefined(); // ROOT 根集内——项目配置放行
    expect(hitOf("cat .env")).toBeUndefined();
  });

  it("保护写面命中：.git 内部与宿主附加（settings 文件——U13）", () => {
    expect(hitOf("tee .git/hooks/pre-commit")).toMatchObject({ kind: "protect-write" });
    expect(hitOf("cat /w/app/.git/config")).toMatchObject({ kind: "protect-write" });
    expect(hitOf("echo x >> /w/app/.x-harness/hub-settings.json", ["/w/app/.x-harness/hub-settings.json"])).toMatchObject({ kind: "protect-write" });
  });

  it("普通界内路径不敏感；~user 形保守敏感；旗标不扫", () => {
    expect(hitOf("cat src/main.ts")).toBeUndefined();
    expect(hitOf("mkdir -p build/out")).toBeUndefined();
    expect(hitOf("~")).toBeUndefined(); // 无 argv 实参
    expect(hitOf("cat ~root/pwn")).toMatchObject({ kind: "deny-read" }); // ~user 不可解析——保守
    expect(hitOf("grep -e ~/.ssh/pattern file")).toMatchObject({ kind: "deny-read" }); // 非旗值位置的路径实参
  });
});
