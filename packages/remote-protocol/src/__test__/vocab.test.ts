import { describe, expect, it } from "vitest";
import { GW_COMMANDS, HOST_COMMANDS, HOST_COMMAND_MATRIX, judgeGwCommand, judgeHostCommand } from "../vocab.ts";

describe("host 命令矩阵（82 命令×4 档表驱动全支路）", () => {
  it("矩阵行数 = 82（host COMMAND_NAMES 全集）；owner-only 恰 9 条", () => {
    expect(HOST_COMMANDS.length).toBe(82);
    const ownerOnly = HOST_COMMANDS.filter((c) => HOST_COMMAND_MATRIX[c]!.ownerOnly);
    expect(ownerOnly.sort()).toEqual(
      ["auth/list", "auth/remove_key", "auth/set_api_key", "models/add", "models/remove", "plugins/trusted_source/confirm", "settings/set", "thread/delete", "workspace/trust"].sort(),
    );
  });

  it("矩阵完备性：行值单调（read ⊆ interact ⊆ full）且 owner-only 行三档全 false", () => {
    for (const c of HOST_COMMANDS) {
      const r = HOST_COMMAND_MATRIX[c]!;
      if (r.ownerOnly) {
        expect([c, r.read, r.interact, r.full]).toEqual([c, false, false, false]);
        continue;
      }
      expect([c, r.full]).toEqual([c, true]);
      expect([c, r.read && !r.interact]).toEqual([c, false]);
      expect([c, r.interact && !r.full]).toEqual([c, false]);
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

  it("症状「get_token_analytics 从设备发被判 unknown-command」：用量查询面全部四档放行", () => {
    for (const tier of ["read", "interact", "full", "owner"] as const) {
      expect([tier, judgeHostCommand("get_token_analytics", tier)]).toEqual([tier, "allow"]);
    }
  });

  it("工作流面：list 归只读，submit/stop 归 interact", () => {
    expect(judgeHostCommand("workflow/list", "read")).toBe("allow");
    expect(judgeHostCommand("workflow/submit", "interact")).toBe("allow");
    expect(judgeHostCommand("workflow/stop", "interact")).toBe("allow");
    expect(judgeHostCommand("workflow/submit", "read")).toBe("scope-denied");
  });

  it("权限规则面：list_rules 只读，grant/remove_rule 归 interact（与 permission/set_mode 同档）", () => {
    expect(judgeHostCommand("permission/list_rules", "read")).toBe("allow");
    expect(judgeHostCommand("permission/grant", "interact")).toBe("allow");
    expect(judgeHostCommand("permission/remove_rule", "interact")).toBe("allow");
    expect(judgeHostCommand("permission/grant", "read")).toBe("scope-denied");
  });

  it("插件面：list/trusted_source list 只读，装卸与 hot 装归 full/interact，信任裁定只走 owner", () => {
    expect(judgeHostCommand("plugins/list", "read")).toBe("allow");
    expect(judgeHostCommand("plugins/trusted_source/list", "read")).toBe("allow");
    expect(judgeHostCommand("get_plugins", "read")).toBe("allow");
    expect(judgeHostCommand("plugins/install", "full")).toBe("allow");
    expect(judgeHostCommand("plugins/install", "interact")).toBe("scope-denied");
    expect(judgeHostCommand("plugins/hot_install", "interact")).toBe("allow");
    expect(judgeHostCommand("plugins/hot_uninstall", "interact")).toBe("allow");
    expect(judgeHostCommand("plugins/trusted_source/confirm", "full")).toBe("owner-only");
    expect(judgeHostCommand("plugins/trusted_source/confirm", "owner")).toBe("allow");
    expect(judgeHostCommand("plugins/trusted_source/reject", "full")).toBe("allow");
  });

  it("宿主运维面：thread/notify 只读，catalog/models reload 与 retire 阈值归 full", () => {
    expect(judgeHostCommand("thread/notify", "read")).toBe("allow");
    expect(judgeHostCommand("catalog/reload", "full")).toBe("allow");
    expect(judgeHostCommand("models/reload", "full")).toBe("allow");
    expect(judgeHostCommand("set_idle_retire_ms", "full")).toBe("allow");
    expect(judgeHostCommand("set_rss_retire_bytes", "full")).toBe("allow");
    expect(judgeHostCommand("catalog/reload", "read")).toBe("scope-denied");
    expect(judgeHostCommand("models/reload", "interact")).toBe("scope-denied");
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