import type { Limits } from "../contracts/types";

export const defaultLimits: Limits = Object.freeze({
  maxScopes: 1024, maxPluginsPerScope: 128, maxPlugins: 2048, maxEffects: 8192, maxServiceLeases: 8192, maxDefinitions: 2048,
  maxRegistrationsPerOwner: 1024, maxActiveTasks: 2048, maxActiveCalls: 4096,
  maxPendingEvents: 1024, maxEventBytes: 65536, maxEventDepth: 32,
  maxEventNodes: 10000, maxNextCallsPerFrame: 16, maxCallDepth: 64,
  maxDiagnostics: 256, maxPendingMutations: 128, callTimeoutMs: 30000,
  activationTimeoutMs: 10000, observerTimeoutMs: 5000, closeTimeoutMs: 30000,
});
