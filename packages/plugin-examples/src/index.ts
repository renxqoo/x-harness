// plugin-examples：20 个真实场景参考插件（架构自洽验证集——每个插件就是一次表面走查）。
// 全部可用 @x-harness/plugin-api 纯函数 archetype 表达（个别直用 token 面以验证双入口）。

export { destructiveGuardPlugin } from "./destructive-guard.ts";
export { budgetGuardPlugin } from "./budget-guard.ts";
export { hallucinationFixerPlugin } from "./hallucination-fixer.ts";
export { loopBreakerPlugin } from "./loop-breaker.ts";
export { toolGuideDynamicPlugin } from "./tool-guide-dynamic.ts";
export { personaOverridePlugin } from "./persona-override.ts";
export { auditLogPlugin } from "./audit-log.ts";
export { jsonEnforcerPlugin } from "./json-enforcer.ts";
export { modelFallbackPlugin } from "./model-fallback.ts";
export { memoryLitePlugin } from "./memory-lite.ts";
export { rateLimiterPlugin } from "./rate-limiter.ts";
export { piiScrubberPlugin } from "./pii-scrubber.ts";
export { perSessionContextPlugin } from "./per-session-context.ts";
export { notificationPlugin, notificationService } from "./notification-service.ts";
export type { Notification, NotificationService } from "./notification-service.ts";
export { toolRegistryDecoratorPlugin } from "./tool-registry-decorator.ts";
export { dynamicToolPlugin } from "./dynamic-tool.ts";
export { midTurnSteerPlugin } from "./mid-turn-steer.ts";
export { scopedPersonaPlugin } from "./scoped-persona.ts";
export { sessionGuardPlugin } from "./session-guard.ts";
export { webFetchPlugin } from "./web-fetch.ts";
export type { Fetcher } from "./web-fetch.ts";
