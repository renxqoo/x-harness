// @x-harness/sandbox：srt 围栏执行环境（docs/SANDBOX.md）——spawn 面内核围栏（读/写/网络）
// + fenceFacts 事实快照；权限裁决与交互全归 @x-harness/permission（用户裁决②）。

export type { Fence, FenceBase } from "./fence.ts";
export { fenceFor, DEFAULT_DENY_READ } from "./fence.ts";
export { commandOf, shellQuoteWord } from "./shell-quote.ts";
export { scrubEnv } from "./scrub-env.ts";
export { mergeAllowlists, sameDomainSet } from "./allowlist.ts";
export type { SrtFilesystem, SrtRuntime, SrtWrapRequest } from "./srt-runtime.ts";
export { realSrtRuntime, platformDepErrors } from "./srt-runtime.ts";
export type { SrtMember, SrtSessionHandle } from "./srt-session.ts";
export { srtSessionOf } from "./srt-session.ts";
export type { SandboxEnvDeps, SandboxEnvHandle } from "./env.ts";
export { createSandboxEnv } from "./env.ts";
export type { SandboxOptions } from "./plugin.ts";
export { createSandboxPlugin } from "./plugin.ts";
