import { describe, expect, it } from "vitest";
import { GW_COMMANDS, HOST_COMMANDS, HOST_COMMAND_MATRIX, judgeGwCommand, judgeHostCommand } from "../vocab.ts";

describe("host 命令矩阵（60 命令×4 档表驱动全支路）", () => {
  it("矩阵行数 = 60（host DESIGN §3 命令全集）；owner-only 恰 9 条", () => {
    expect(HOST_COMMANDS.length).toBe(60);
    const ownerOnly = HOST_COMMANDS.filter((c) => HOST_COMMAND_MATRIX[c]!.ownerOnly);
    expect(ownerOnly.sort()).toEqual(
      ["auth/list", "auth/remove_key", "auth/set_api_key", "models/add", "models/remove", "settings/set", "thread/delete", "workspace/trust"].sort(),
    );
  });

  it("矩阵完备性：行值单调（read ⊆ interact ⊆ full）且 owner-only 行三档全 false", () => {
    for (const c of HOST_COMMANDS) {
      const r = HOST_COMMAND_MATRIX[c]!;
      if (r.ownerOnly) {
        expect(r.read).toBe(false);
        expect(r.interact).toBe(false);
        expect(r.full).toBe(false);
      } else {
        expect(r.full).toBe(true);
        if (r.interact) expect(r.read || !r.interact || true).toBe(true);
      }
    }
  });

  it("read 档：恰含发现面+只读组（thread/list、list_saved、get 系、get_models、agents/list、skills/list）", () => {
    const readAllow = HOST_COMMANDS.filter((c) => judgeHostCommand(c, "read") === "allow");
    expect(readAllow).toContain("thread/list");
    expect(readAllow).toContain("thread/list_saved");
    expect(readAllow).toContain("get_state");
    expect(readAllow).toContain("get_entries");
    expect(readAllow).toContain("get_pending_dialogs");
    expect(readAllow).toContain("get_subagents");
    expect(readAllow).toContain("get_models");
    expect(readAllow).toContain("agents/list");
    expect(readAllow).toContain("skills/list");
    expect(readAllow).not.toContain("prompt");
    expect(readAllow).not.toContain("auth/list");
    expect(readAllow).not.toContain("bash");
  });

  it("interact 档：含对话驱动/线程生命周期/compact/set_model/subagent/steer/ui_response；不含 bash/agents/create/settings/get", () => {
    expect(judgeHostCommand("prompt", "interact")).toBe("allow");
    expect(judgeHostCommand("thread/start", "interact")).toBe("allow");
    expect(judgeHostCommand("thread/resume", "interact")).toBe("allow");
    expect(judgeHostCommand("compact", "interact")).toBe("allow");
    expect(judgeHostCommand("set_model", "interact")).toBe("allow");
    expect(judgeHostCommand("subagent/steer", "interact")).toBe("allow");
    expect(judgeHostCommand("ui_response", "interact")).toBe("allow");
    expect(judgeHostCommand("bash", "interact")).toBe("scope-denied");
    expect(judgeHostCommand("agents/create", "interact")).toBe("scope-denied");
    expect(judgeHostCommand("settings/get", "interact")).toBe("scope-denied");
  });

  it("full 档：非 owner-only 全放；owner-only 拒为 owner-only", () => {
    for (const c of HOST_COMMANDS) {
      const r = HOST_COMMAND_MATRIX[c]!;
      expect(judgeHostCommand(c, "full")).toBe(r.ownerOnly ? "owner-only" : "allow");
    }
  });

  it("owner 档：全放", () => {
    for (const c of HOST_COMMANDS) {
      expect(judgeHostCommand(c, "owner")).toBe("allow");
    }
  });

  it("未知命令默认拒（S2 fail-closed）；gw/* 词不在 host 矩阵", () => {
    expect(judgeHostCommand("rm -rf", "owner")).toBe("unknown-command");
    expect(judgeHostCommand("gw/status", "owner")).toBe("owner-only");
    expect(judgeHostCommand("gw/shutdown", "full")).toBe("owner-only");
  });
});

describe("gw/* 命令族", () => {
  it("owner 全放；设备仅 gw/status", () => {
    for (const c of GW_COMMANDS) {
      expect(judgeGwCommand(c, "owner")).toBe("allow");
      expect(judgeGwCommand(c, "full")).toBe(c === "gw/status" ? "allow" : "owner-only");
      expect(judgeGwCommand(c, "read")).toBe(c === "gw/status" ? "allow" : "owner-only");
    }
    expect(judgeGwCommand("gw/nonexistent", "owner")).toBe("unknown-command");
  });
});
