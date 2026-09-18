// probe 注入缝（docs/EXEC-ENV.md §4 装配期 fail-closed）：平台分派/缺席态/断言文案可行动。

import { describe, expect, it } from "vitest";
import { probeWrappers, assertProbes } from "../probe.ts";

describe("probeWrappers（注入 which）", () => {
  it("darwin：sandbox-exec 内建绝对路径兜底", () => {
    const r = probeWrappers({ platform: "darwin", which: () => null });
    expect(r.dialect).toBe("darwin");
    expect(r.wrapper).toBe("/usr/bin/sandbox-exec");
    expect(r.socat).toBeUndefined();
    expect(() => assertProbes(r, false)).not.toThrow();
  });

  it("linux：bwrap 在场 + socat 缺席且 allowlist → fail-closed 拒启（off 档放行）", () => {
    const r = probeWrappers({ platform: "linux", which: (c) => (c === "bwrap" ? "/usr/bin/bwrap" : null) });
    expect(r.wrapper).toBe("/usr/bin/bwrap");
    expect(r.socat).toBeUndefined();
    expect(() => assertProbes(r, false)).toThrow(/socat/);
    expect(() => assertProbes(r, true)).not.toThrow(); // off 档不需要桥
  });

  it("linux：bwrap 缺席 → 拒启文案含修复指引", () => {
    const r = probeWrappers({ platform: "linux", which: () => null });
    expect(r.wrapper).toBeUndefined();
    expect(() => assertProbes(r, true)).toThrow(/refusing to run unfenced/);
  });
});
