// @x-harness/sandbox-local：本机沙箱——argv 改写围栏 + 会话代理域名白名单（docs/EXEC-ENV.md §4）。

export type { Fence, FenceBase, NetworkPolicy } from "./fence.ts";
export { fenceFor, denyReadPaths, DEFAULT_DENY_READ } from "./fence.ts";
export { seatbeltProfile, seatbeltArgv } from "./confine/seatbelt.ts";
export { bwrapArgv, PROXY_SOCKET_DIR, PROXY_LOOPBACK_PORT } from "./confine/bubblewrap.ts";
export type { Dialect, ProbeInternals, ProbeResult } from "./probe.ts";
export { probeWrappers, assertProbes } from "./probe.ts";
export type { ProxyHandle, ProxyDeps } from "./proxy/server.ts";
export { createSessionProxy } from "./proxy/server.ts";
export type { SandboxEnvDeps, SandboxEnvHandle, ProxyTarget } from "./env.ts";
export { createSandboxEnv, scrubEnv } from "./env.ts";
export type { SandboxOptions } from "./plugin.ts";
export { createSandboxPlugin } from "./plugin.ts";
