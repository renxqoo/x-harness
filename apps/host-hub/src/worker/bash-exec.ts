export {
  BASH_OUTPUT_RETENTION_MS,
  cleanupBashOutputs,
  createBashExec,
  installDetachExitSweep,
  resolveShell,
  twoStageKillGroup,
} from "@x-harness/agent-sdk/src/commands/bash-exec.ts";
export type {
  BashRequest,
  BashOutcome,
  InflightBashFace,
  ShellResolution,
  BashExecDeps,
  BashExec,
} from "@x-harness/agent-sdk/src/commands/bash-exec.ts";
