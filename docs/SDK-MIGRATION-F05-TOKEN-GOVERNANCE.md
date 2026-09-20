# F05-TOKEN-GOVERNANCE 迁移文档

> 状态：草稿。契约草案见 SDK-DESIGN §6/§7；行为规格 = 现有 1730 测试 + e2e 零改写（纯加法波）。
> 交付/测试矩阵/回滚/验收：实施前按 DESIGN 对应小节定稿（本行为占位骨架，对抗审查后补全）。

## 7. 实施记录（2026-09-20）

- **交付物**：install.ts onToken 同名异体 fail-closed throw（"token identity is object-based — share via the defining package"——错误文案即治理规矩）；bridge 路径 `get ?? mint` 幂等无碰撞面（核证不加守卫）。
- **门禁数字**：typecheck ✓ lint ✓ test **146 文件/1735 用例**（+1 碰撞用例：异体拒/同体重装不误伤）。
- **实施期发现（F05-1）**：onToken 只在 provide/on 注册时捕获——模块级 defineService 不进词表（无消费面即无碰撞面，语义自洽）；测试插件须 provide 才触发。
