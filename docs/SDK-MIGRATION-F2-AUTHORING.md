# F2 迁移文档：PLUGIN-AUTHORING.md 作者入口

> 状态：草稿。依赖 F1（kit 目录成形后总表才有实指）。

## 1. 规格与验收
五块（DESIGN §2.4）：概念地图；Where-new-behavior-goes 总表（**组装任意 agent → kit 目录 + 自有插件**居首）；工具插件快路径 + 陷阱表（D6 已消解为 softInject——表述同步）；prompt 投稿面（wellKnown/三分法/函数形）；testkit + journey 参照。验收：总表零死链、陷阱表条条有代码依据、对抗审查事实核对。

## 2. 回滚：纯文档 revert。

## 7. 实施记录（2026-09-20）

- **交付物**：docs/PLUGIN-AUTHORING.md——七块：Where-new-behavior-goes 总表（组装成品居首）/ 中间件原语（plugin-api 四 archetype + 洋葱纪律）/ 工具插件快路径 + 六条陷阱表 / 提示词投稿面（三分法/wellKnown/函数形/会话层）/ 概念地图（含 softInject 与宿主信任域）/ 能力插件模式（token 惯例 + 微调四式）/ testkit 装置 + 契约稳定性规矩（冻结面/pre-stable/最少面）。
- **验收核对**：总表 14 行机制全部实指（kit/plugin-api/createToolPlugin/section/adapter/plugin-manager 均为已交付实体）；陷阱表条条有代码依据（§2 各条对应 tool-core 实测）；零死链（引用文档均存在）。
- **门禁**：纯文档，四门不受影响。
