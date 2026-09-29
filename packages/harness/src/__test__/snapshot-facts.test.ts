import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_SUPERSEDES, isSnapshotNode } from "@x-harness/agent-loop";
import type { SurfaceNode } from "@x-harness/session";
import { INSTRUCTIONS_CAP_BYTES, localToday, readInstructionFiles, renderDateSnapshot, renderModelSnapshot, renderPermissionModeNonOwnerSnapshot, renderPermissionModeSnapshot } from "../snapshot-facts.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "xh-snap-"));
  dirs = [...dirs, dir];
  return dir;
};

const at = (iso: string): Date => new Date(iso);

describe("日期快照（A）", () => {
  it("信封 kind=date + 作废声明；同日幂等（render 全文唯一）、跨日新条——UTC 正午锚点（任意机器时区同判）", () => {
    const noon = at("2026-09-21T12:00:00Z");
    const day1 = renderDateSnapshot(noon);
    expect(day1).toContain('<snapshot kind="date">');
    expect(day1).toContain(SNAPSHOT_SUPERSEDES);
    expect(day1).toContain(`Today's date: ${localToday(noon)} (`);
    expect(localToday(noon)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(renderDateSnapshot(new Date(noon.getTime() + 30 * 60_000))).toBe(day1);
    expect(renderDateSnapshot(new Date(noon.getTime() + 24 * 3_600_000))).not.toBe(day1);
  });

  it("isSnapshotNode 对日期快照消息形态成立（跨包谓词闭环）", () => {
    const node = { seq: 0, event: { type: "user/message", surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: renderDateSnapshot(at("2026-09-21T10:00:00+08:00")) }] } } } as unknown as SurfaceNode;
    expect(isSnapshotNode(node)).toBe(true);
  });
});

describe("模型快照（powered-by 身份行——请求时点注入）", () => {
  it("信封 kind=model + 作废声明 + 单行正文；isSnapshotNode 谓词成立", () => {
    const text = renderModelSnapshot("glm-5.3");
    expect(text).toBe(`<snapshot kind="model">\n${SNAPSHOT_SUPERSEDES}\nYou are powered by the model glm-5.3.\n</snapshot>`);
    const node = { seq: 0, event: { type: "user/message", surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text }] } } } as unknown as SurfaceNode;
    expect(isSnapshotNode(node)).toBe(true);
  });
});

describe("权限档快照（plan 模式告知——kick 时点注入）", () => {
  it("plan 档 = 行为指引（只读 + plan_submit 出口）；其余档 = 事实行（恒渲染使退出 supersede 旧指引）", () => {
    const planText = renderPermissionModeSnapshot("plan");
    expect(planText).toContain('<snapshot kind="permission-mode">');
    expect(planText).toContain(SNAPSHOT_SUPERSEDES);
    expect(planText).toContain("research and read only");
    expect(planText).toContain("plan_submit");
    expect(renderPermissionModeSnapshot("auto")).toBe(`<snapshot kind="permission-mode">\n${SNAPSHOT_SUPERSEDES}\nPermission mode: auto.\n</snapshot>`);
    const node = { seq: 0, event: { type: "user/message", surfaceOp: "append", data: { turn: 0, step: 0, content: [{ type: "text", text: planText }] } } } as unknown as SurfaceNode;
    expect(isSnapshotNode(node)).toBe(true);
  });

  it("非 owner 会话变体：plan 档渲染观察者事实行（无「等批准」指引、不含 You are in plan mode）", () => {
    const observer = renderPermissionModeNonOwnerSnapshot("plan");
    expect(observer).toContain('<snapshot kind="permission-mode">');
    expect(observer).toContain("only the session that entered plan mode can submit");
    expect(observer).not.toContain("You are in plan mode");
    expect(renderPermissionModeNonOwnerSnapshot("auto")).toBe(`<snapshot kind="permission-mode">\n${SNAPSHOT_SUPERSEDES}\nPermission mode: auto.\n</snapshot>`);
  });
});

describe("项目指令读取（C'）", () => {
  it("缺席零注入（无文件 → body 空串）", () => {
    const dir = makeDir();
    expect(readInstructionFiles(dir).body).toBe("");
    expect(readInstructionFiles(dir).warnings).toEqual([]);
  });

  it("合并序：AGENTS.md 在前、CLAUDE.md 在后，以 --- 分隔", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "CLAUDE.md"), "claude body");
    writeFileSync(join(dir, "AGENTS.md"), "agents body");
    expect(readInstructionFiles(dir).body).toBe("agents body\n---\n\nclaude body");
  });

  it("同内容去重：软链/复制形态只注一份", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "same body");
    symlinkSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
    expect(readInstructionFiles(dir).body).toBe("same body");
  });

  it("64KB 上限以读到 buffer 长度为准：超限整文件拒注+告警，另一文件照常（TOCTOU 面不可黑盒测——stat 预判与 buffer 判定在确定性夹具下等价，本用例不区分二者）", () => {
    const dir = makeDir();
    const big = Buffer.alloc(INSTRUCTIONS_CAP_BYTES + 1, 0x61);
    writeFileSync(join(dir, "AGENTS.md"), big);
    writeFileSync(join(dir, "CLAUDE.md"), "small");
    const read = readInstructionFiles(dir);
    expect(read.body).toBe("small");
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("AGENTS.md");
    expect(read.warnings[0]).toContain("skipped");
  });

  it("读取失败分流：ENOENT 静默、其余 IO 错误告警跳过（fail-open 可见——不与缺席同路吞掉）", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "secret", { mode: 0o000 });
    const read = readInstructionFiles(dir);
    expect(read.body).toBe("");
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("AGENTS.md");
    expect(read.warnings[0]).toContain("unreadable");
    const absent = readInstructionFiles(join(dir, "nope"));
    expect(absent.body).toBe("");
    expect(absent.warnings).toEqual([]);
  });
});
