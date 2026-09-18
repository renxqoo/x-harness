// wrapper 探测（docs/EXEC-ENV.md §4/§6 fail-closed 双保险之装配期）：按平台与网络档位探测
// seatbelt/bwrap/socat——缺席 apply throw（宿主起不来优于静默裸跑）。which/env 可注入（测试缝）。

export type Dialect = "darwin" | "linux";

export interface ProbeInternals {
  readonly platform?: NodeJS.Platform;
  readonly which?: (command: string) => string | null;
}

export interface ProbeResult {
  readonly dialect: Dialect;
  /** 围栏包裹二进制绝对路径（darwin=sandbox-exec 内建；linux=bwrap） */
  readonly wrapper: string | undefined;
  /** socat 绝对路径（仅 linux + allowlist 档需要；缺席即 fail-closed） */
  readonly socat: string | undefined;
}

export function probeWrappers(internals: ProbeInternals = {}): ProbeResult {
  const platform = internals.platform ?? process.platform;
  const which = internals.which ?? ((command) => Bun.which(command));
  if (platform === "darwin") {
    const wrapper = which("sandbox-exec") ?? "/usr/bin/sandbox-exec"; // darwin 系统内建——缺席仍给绝对路径（spawn 期再暴露）
    return { dialect: "darwin", wrapper, socat: undefined };
  }
  return { dialect: "linux", wrapper: which("bwrap") ?? undefined, socat: which("socat") ?? undefined };
}

/** 装配期断言：档位所需 wrapper 全在场，缺席给可行动失败（fail-closed 拒启） */
export function assertProbes(result: ProbeResult, networkOff: boolean): void {
  if (result.wrapper === undefined) {
    throw new Error(`sandbox-local: confinement wrapper not found for ${result.dialect} (install bubblewrap${result.dialect === "linux" ? "" : ""}) — refusing to run unfenced`);
  }
  if (result.dialect === "linux" && !networkOff && result.socat === undefined) {
    throw new Error("sandbox-local: network allowlist on linux requires socat (install socat) — refusing to run without the proxy bridge");
  }
}
