// 跨包锚点词汇表（内核所有——唯一合法的跨包锚点名来源，ELEVATION-DESIGN §2.1.1）。
// 内核只治理**名字**不持有内容：base/core 槽位的正文由上层宿主注册（apps/cli
// base-prompt.ts——业务内容归上层，dsh 同构：内核 SECTION_ORDERS 槽位 + persona 上层）。

/** 预留锚点名：工具守则段（tool-core 投稿）与追加段的缺省锚 */
export const wellKnown = { baseCore: "base/core" } as const;
