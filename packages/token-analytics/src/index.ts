// token-analytics：上下文/用量分析能力插件（docs/PLUGINS.md 契约 1）。
// default 导出 = 零参 Plugin 实例（plugin-manager validateModule 装载形状，
// options 走 contextWindow 三级兜底）；命名导出 = 工厂与 token（消费方依赖
// 本包取 token 对象身份——PLUGIN-AUTHORING §5 token 惯例）。
import { tokenAnalyticsPlugin } from "./token-analytics.ts";

export default tokenAnalyticsPlugin({});

export { tokenAnalyticsPlugin, tokenAnalyticsService } from "./token-analytics.ts";
export type { TokenBreakdown, TokenAnalyticsOptions, TokenAnalyticsService } from "./token-analytics.ts";
