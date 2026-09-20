// autocompact 件 barrel（coverage 豁免惯例）。

export { createAutoCompactPlugin } from "./plugin.ts";
export type { AutoCompactOptions } from "./plugin.ts";
export {
  autocompactBreaker,
  autocompactCheckpoint,
  autocompactDiagnostic,
  autocompactL1Cleared,
  autocompactL2Escalated,
  autocompactLinesDegraded,
  autocompactParallelApproach,
} from "./tokens.ts";
export type { CheckpointAction } from "./tokens.ts";
export { computeLines, assertLinesDomain, refitLines, budgetOverflowPredicted, l1PreGateWorth, SUMMARIZER_RESERVE_CAP } from "./lines.ts";
export type { LineInput, Lines } from "./lines.ts";
export {
  emptyLedger,
  parseLedgerPatch,
  mergeLedger,
  serializeLedger,
  serializeLedgerForPrompt,
  ledgerTokens,
  trimLedger,
  ledgerReady,
} from "./ledger.ts";
export type { Ledger } from "./ledger.ts";
export { emptyCalibration, pushCalibrationSample, calibrationFactor } from "./calibration.ts";
export type { Calibration } from "./calibration.ts";
export { measureOccupancy, trailingMaxParallel, pruneAbsorbedGains, pushGain } from "./measure.ts";
export type { L1GainEntry, L1Gains, Measured } from "./measure.ts";
export { computeClearPlan, gainTokensOf, landClearPlan, lastTurnStartIndex, PLACEHOLDER_PREFIX } from "./scavenger.ts";
export type { ClearPlan, ClearPlanEntry, ScavengerConfig } from "./scavenger.ts";
export {
  CP_SYSTEM_PROMPT,
  CP_UPDATE_PROMPT,
  checkpointMaxChars,
  boxSegment,
  filesTextOf,
  maybeStartCheckpoint,
  cancelJob,
  joinInflight,
  foldCheckpointEvents,
  emptyCheckpointState,
  firstUncoveredIndex,
} from "./checkpoint.ts";
export type { CheckpointConfig, CheckpointJob, CheckpointState, CheckpointDeps } from "./checkpoint.ts";
export { escalateL2, ledgerReadyForL2, alignDownToTurnStart } from "./escalator.ts";
export type { L2Result } from "./escalator.ts";
export { runStepGate } from "./gate.ts";
export type { GateConfig, GateDeps } from "./gate.ts";
export { maybeIdleClear } from "./idle.ts";
export { makeSessionState, recoverSessionState } from "./session-state.ts";
export type { SessionState, GateCache } from "./session-state.ts";
