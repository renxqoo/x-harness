# Flake 清单（并行负载下间歇红，隔离复跑绿）

| 用例 | 症状 | 首次观测 | 处置 |
| --- | --- | --- | --- |
| apps/host-hub git-watch.test.ts「worktree 内建分支：refs 写落 commonDir → 事件」 | 5s 超时（真进程 git watcher 竞态窗口） | 2026-09-30 P0 双审期间 | 已知时序敏感；显式 timeout 挂 P2 测试批 |
| apps/host-hub git-watch.test.ts「同值抑制：A→B→A」 | 5s 超时 | 2026-10-01 | 同上 |
| packages/plugin-manager worker-slice.test.ts「完整链路 boot→ready→RPC」 | 5s 超时（真进程 RPC） | 2026-10-01 B 终审 | 同上 |
| packages/plugin-manager capabilities.test.ts「第三方件 worker 装载 caps RPC」 | 5s 超时 | 2026-10-01 | 同上 |
| apps/host-hub scenarios-resilience.test.ts「retire → parked → 直读」 | 14s 长用例并行压载偶红 | 2026-10-01 | 隔离绿 |
| packages/tool-grep grep.test.ts「12000 字节 CJK 行」 | 5s 超时 | 2026-10-01 | 隔离绿 |
| apps/host-hub smoke.test.ts「stdout 纯净」 | 30s 超时（coverage 高负载） | 2026-10-01 A 复核 | 隔离绿 |

口径：并行全量跑（>350 文件）下 5s 默认超时不足；「隔离复跑绿」即判定 flake
而非缺陷。显式 timeout 修复随 P2 测试批；新增 flake 按此表登记。
