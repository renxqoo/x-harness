# e2e 真实使用场景包方案（packages/e2e）

> 状态：已核销（对抗审查 8 项清零）
> 级别：中（新子包、真实文件系统 + 真实 sqlite 落盘）

## 形态定调（用户裁决）

e2e **不是测试文件**，是**真实使用场景**：一个真实宿主程序（`bun run e2e`，退出码判定，
挂 `bun run check`），安装对象是仓库内 `plugins/` 的**真实插件源码**（tsc/oxlint 全检查）。

场景就一个：**基于 sqlite 的增删改查 4 个插件**——验证运行期**动态注册、使用、销毁后无法使用**。

```
packages/e2e/
  package.json
  plugins/
    contracts.ts      # 契约：crud-db 服务 token（宿主提供 sqlite 执行面，插件消费）
    crud-create.ts    # 增  crud-read.ts    # 查
    crud-update.ts    # 改  crud-delete.ts  # 删
  src/
    world.ts          # 宿主装配：createContext + sqlite 执行面 + plugin-manager（process 模式）
    check.ts          # must() 断言糖
    main.ts           # 场景：注册 → 增删改查往返 → 逐个销毁（无法使用）→ 重装复活
```

## 场景口径（怎么算对）

1. **注册**：4 个插件逐一动态安装（平台不重启），登记名如实。
2. **使用**：增 → 查 → 改 → 查 → 删 → 查 全程经插件服务；宿主只提供 db 执行面。
3. **销毁**：卸「删」后其服务无法使用（token 注销或解析失效）且其余照常；
   全部卸载后 4 个服务都无法使用、登记清空。
4. **复活**：重新注册即恢复可用；sqlite 文件库数据存活（数据比插件活得久）。

## 裁决

- 判定 = 真实程序退出码，不走 vitest（用户裁决）；覆盖率分母不含 e2e
  （vitest 运行期不执行它，计数无意义——vitest.config 注明）。
- 插件 = 仓库真实源码文件，不做运行期字符串拼装（用户裁决）；共享 token 走契约模块
  （plugins/contracts.ts——裁决 10 的真实形态）。
- sqlite 连归宿主、插件只拿执行面（真实分层：连接生命周期 ≠ 插件生命周期）；
  文件库落 mkdtemp 隔离区，每次运行全新库。

## 实测记录（2026-09-18）

- e2e 开发过程揪出三处 plugin-manager 缺陷（本场景 process 模式不直接经过 worker 路径，
  修复背书 = plugin-manager 单测回归，非本场景）：**击杀收殓误删登记**（改按装载方身份删——
  `registry.removeIfOwned`；同名被拒不碰在运行老插件、apply 期击杀不抹 failed 留痕）、
  **process 模式 tokenTable 卸载不注销**（token 只增不减的泄漏与 worker/process 双轨语义）、
  worker boot 无谓 query bust——详见 [PLUGIN-MANAGER.md](./PLUGIN-MANAGER.md) 第三批记录。
- **Bun 1.4.2 平台缺陷**（同处记录）：terminate 热线程毒化进程级模块解析——worker 模式热击杀后
  「继续装载新插件」不可承诺；本场景用 process 模式不受影响；修复方向（挂账）：子进程隔离。
- **vitest v5 配置坑**：`coverage` 挂 `defineConfig` 顶层会被静默忽略（include/exclude/thresholds
  全失效，门禁从不判负）——已修为嵌在 `test` 下，thresholds 自本批真实强制；
  worker/ 目录（线程内执行，v8 进程内插桩不可达）显式排除出行数分母。

## 销毁语义边界（声明）

「销毁后无法使用」= **平台解析面失联**：token 随卸载注销（`serviceToken` 返回 undefined）、
登记清空、再次解析服务抛错。调用方在卸载**前**捕获的旧服务引用（闭包直持 impl）不受登记簿
管辖——这是 JS 引用语义的地基事实，插件作者不该依赖它做生命周期。

## 验收清单

- [x] 场景口径 1-4 逐条（`bun run e2e` 退出码 0，双跑稳定）
- [x] 门禁接线：tsconfig plugins glob / 覆盖率排除 e2e / 根 e2e 脚本进 check
- [x] 四门 + e2e 全绿 + 覆盖率数字如实报告
- [x] 对抗审查问题清零（8 项：1 高 4 中 3 低——全部修复或落档，见实测记录与 PLUGIN-MANAGER 第三批）
