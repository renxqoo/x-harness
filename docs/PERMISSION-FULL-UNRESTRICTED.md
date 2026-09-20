# full 档总括授权根治（授权事实三面铺开）方案

> 状态：已实施（2026-09-20 定稿前与收口前各双路对抗审查，处置记录见文末两节）
> 级别：中（跨 packages/permission + packages/sandbox-local + apps/cli；扩展 EXEC-ENV
> §5 裁决⑤「full=完全访问」的语义边界——**用户裁决（2026-09-20）：治本方向 = 启动期
> 总括授权翻译为授权事实，经既有授权管道铺开，执法层零改动**）
> 前置：docs/PERMISSION-MODE-FLAG.md 挂账项「full 档路径工具界外的许可/执法两层
> 语义」的本件根治。

## 缺陷本质（治本判据）

授权根（extraRoots）的产生条件被硬编码绑在「发生一次 ask 且用户批准」这个
**事件**上；但用户授权意志有两个合法来源——运行时逐次批准（ask→allow）与
启动期总括授权（`--permission full` 这个动作本身）。现状只认前者，full 档跳过
ask 即无授权根。断裂同时存在于两个面：

- **工具面**：write/read/grep 界外 permission allow 但 PathGate 拒
  （PATH_ESCAPES_ROOT）——auto 档经审批可以界外写、full 档反而不可达；
- **bash 围栏面**：full 档 bash 裁决层放行，但围栏 writable 不含界外路径，
  seatbelt/bwrap 内核拒写（EPERM）——裁决 allow 与执行失败同样断裂。

**治本 = 让来源 2 也产生授权事实**：GrantsRegistry 增加总括授权形态，permission
plugin 在 mode=full 装配期确立；总括授权对外表现为授权根 `"/"`（全盘根），经
既有 extraRootsOf 管道流入三个执法面——**执法层（PathGate / seatbelt / bwrap）
零改动**，授权根列表语义天然支持全盘根（`withinRootLexicalOf("/")` 对一切绝对
路径恒真；resolve("/") 无双形）。

## 契约

- `GrantsRegistry`：
  - 新增 `setUnrestricted(): void`（**仅装配期调用**——运行期置位会即时改变一切
    在飞会话的授权面，接口注释钉死此约束）与 `isUnrestricted(session): boolean`
    查询面；
  - `extraRootsOf(session)` 语义分叉（总括贡献与逐目录授权是两件事）：
    - 总括态 ∧ 该会话**无** rootOverride → 深等于 `["/"]`（吸收语义——全盘根
      覆盖一切旧根，不并集）；
    - 总括态 ∧ 该会话**有** rootOverride（worktree 隔离）→ **逐目录授权原语义
      不变**（`[...bucket.extraRoots]`，不追加 `"/"`）——隔离压过总括只作用于
      总括贡献，不得吞掉 worktree 子写自身路径所依赖的 ask→批准→读回链；
    - 非总括态 → 原语义不变（回归零变化）；
  - `isUnrestricted(session)`：总括态 ∧ 无 rootOverride → true；有 rootOverride
    → false（文件面与网络面例外同向）；
  - `seal()` 后 `isUnrestricted()` 恒 false——拆卸即收回总括（fail-closed 同向：
    拆卸序中 permission 先拆而代理池未关的窗口内，新 CONNECT 不被总括短路放行）；
  - evict 不清总括旗标（进程级事实非会话级——会话终结后 `extraRootsOf` 对该
    会话重查仍 `["/"]`）；既有逐目录授权、域名桶、rules 语义不变。
- `createPermissionPlugin`：apply 时 mode 解析后为 `"full"` → `grants.setUnrestricted()`。
  单一确立入口。
- 会话代理（proxy/server.ts `handleConnect`）：`grants.isUnrestricted(session)` →
  CONNECT 直接放行——短路位序在**域名桶查询之前**（总括压过逐域负缓存），
  不经 broker ask、不写桶（放行后 `domainVerdict` 仍 undefined）；非 CONNECT
  方法的 405 检查仍在短路之前。
- **三个执法面自动一致**（零改动验证）：
  - 工具面：tool-plugin `extraRootsOf` → PathGate.admit 授权根含 `"/"` →
    read/write/grep 界外可达；
  - 围栏面：fenceFor writable 合成并上 extraRoots（含 `"/"`）→ seatbelt
    `(allow file-write* (subpath "/"))` / bwrap `--bind / /`（argv 序：writable
    bind 循环在 `--ro-bind / /` 之后、denyRead/protectedPaths 的 tmpfs 遮挂在
    writable bind 之后——遮挂压顶成立）；
  - 网络面：代理层短路（如上）。
- **硬底线（如实区分面）**：
  - permission 裁决层 deny 规则仍压过 full：Write 工具面 `**/.git/**` 写拒、
    Read/Grep 的 DEFAULT_DENY_READ（`~/.ssh/**`、`**/.env` 等）、提权/密码类硬拒；
  - 围栏层：linux tmpfs 遮挂（denyRead + protectedPaths）跨文件系统，rename 无
    法绕过（EXDEV）；darwin 的 deny-read regex 拒读仍在，**但 subpath "/" 全盘
    写放行使 rename/硬链绕过拒读表成为现实路径（`mv ~/.ssh/id_rsa /tmp/x` 后
    可读）——darwin 内核无法表达「拒写特定路径」（seatbelt deny-write 带过滤
    器必杀全写，EXEC-ENV §13 先例），此为 full 档「完全访问」的显式已知边界**，
    落档 EXEC-ENV §5；
  - bash 面：full 档 bash 写 `.git` 在 darwin 围栏不拦（protectedPaths 仅 linux
    消费，§13 既有口径）；工具面 Write 规则不参与 bash argv 匹配——两平台分叉
    为既有语义，本件不扩不收。
- **子代理传导（共享世界事实）**：delegation 子代理经 `deps.loop.create` 建在
  宿主同一世界——同一 permission plugin 闭包与同一 GrantsRegistry 实例。full
  档对世界内一切会话（含 delegation 子、匿名 `_anon`）生效是**共享装配的既成
  事实**（裁决层 mode 本就如此），本件后授权面同向传导。子代理独立档位语义
  （如「宿主 full 但子代理限 auto」）需要 per-session mode，独立件立项。

## 问题域

处理：

- GrantsRegistry 总括形态 + plugin 装配期确立 + 代理短路（含位序与拆卸收回）；
- 三面行为锚（工具面真写出、围栏剖面形态与真跑、网络放行）；
- 既有行为快照测试翻转（full 界外 PATH_ESCAPES_ROOT → 真写出）；
- EXEC-ENV §5 / CLI.md / PERMISSION-MODE-FLAG.md / grants.ts 头注释 /
  adjudicate.ts 注释同变。

不处理（归属落档）：

| 事项 | 归属 |
| --- | --- |
| 子代理独立档位 | 共享世界传导是既成事实（见契约节）；per-session mode 独立件立项 |
| darwin 拒读表 rename 绕过 | 内核不可表达（§13 先例）——显式已知边界落档 + 现状行为锚（读拒仍在、写放行） |
| linux bwrap `--bind / /` 真跑验证 | 开发环境 darwin；单测锁 argv 相对序 + 落档验证归属（linux CI 真跑腿归流水线环境） |
| plan 档对称面 | 无断裂（write/bash 裁决层全拒，read 界外走既有 ask→grant 链） |
| fenceFacts / adjudicate 改动 | full/plan 裁决短路在界内判定之前；auto 档无总括——零影响零改动 |
| **rg（ripgrep）在 seatbelt deny default 剖面下 SIGABRT** | **存量缺陷登记（实现期发现，与本件无关）**：最小剖面 `(deny default)(allow process-fork)(allow process-exec*)(allow file-read*)` 下 rg 即崩（`failed to allocate a guard page`——Rust 多线程运行时×seatbelt 兼容），auto/full 同崩；grep 经围栏装配的形态全仓零覆盖（e2e toolbox 走 localEnv）。本件 grep 腿只锚授权面（audit allow + 非 PATH_ESCAPES_ROOT）；根治归 seatbelt 剖面独立件（需裁决剖面补何许可动词） |

## 并发/一致性预算

不涉及新并发面——总括旗标装配期单写、运行期只读（接口注释钉死）；代理短路在
既有 handleConnect 单线程流内；无定时器、无 IO 新增。

## 拆分

| 位置 | 改动 |
| --- | --- |
| packages/permission/src/grants.ts | setUnrestricted/isUnrestricted(session) + extraRootsOf 分叉语义 + seal 收回 + 头注释（进程级总括例外的口径） |
| packages/permission/src/plugin.ts | apply 期 full → setUnrestricted() |
| packages/permission/src/bash/adjudicate.ts | 头注释「越根写由围栏内核承载」句同变（full 总括后围栏 writable 含 "/"，该句仅对 auto 档成立） |
| packages/sandbox-local/src/proxy/server.ts | handleConnect 总括短路（位序在桶查询前、405 检查后） |
| packages/tool-core/src/{tool-plugin,paths}.ts | guard 过滤处注释：`"/"` 是 guard 祖先不被 guard 过滤滤掉——总括例外必须在 grants 层（防未来重构打穿 worktree 隔离） |
| 测试 | 见「测试口径」 |
| docs/EXEC-ENV.md §5 | full 档语义扩展（三面 + 底线分面 + darwin rename 边界 + 子代理传导事实 + 会话授权集段的进程级例外口径） |
| docs/CLI.md §2.1/§2.6 | §2.1 full 行改「唯 deny 规则/提权硬拒（分面口径见 EXEC-ENV §5）」；§2.6 原挂账段改写 + 网络句（full 下代理短路零 ask） |
| docs/PERMISSION-MODE-FLAG.md | 挂账行改指向本件 + 纠正「bash 面不受影响」旧断言（同提交同变） |

依赖方向不变。

## 实施顺序

单批次（无过渡态）：grants → plugin → proxy → 注释 → 测试翻转与新增 → 文档 →
四门+e2e。

## 裁决

- **治本方向**（用户裁决 2026-09-20）：full 总括授权翻译为授权事实（`"/"` 授权
  根），经既有授权管道铺开三面，执法层零改动。
- **三面一起铺开**（用户裁决）：文件系统执法面 + 围栏面 + 网络面。
- **worktree 隔离压过总括，但只作用于总括贡献**（审查处置 H2）：override 会话
  不注入 `"/"`、代理不短路；其逐目录授权原语义保留。
- **seal 收回总括**（审查处置 M4）：拆卸窗口 fail-closed。
- **darwin rename 边界显式接受**（审查处置 H3）：内核不可表达，落档 + 行为锚。
- **吸收语义**：非 override 会话总括态 `extraRootsOf` 深等于 `["/"]`（非并集）。

## 测试口径

**装置面归属约束**：工具面（PathGate）授权根集不含 tmpdir——工具腿的界外路径
可选 tmpdir 下（auto/full 可区分）；围栏面 writable 恒含 tmpdir()——围栏/bash
行为腿的界外路径**必须非 tmpdir**（如 home 下 mkdtemp），否则 auto/full 不可区分。

- **grants 单测**（矩阵，全深等断言）：
  - 缺省 `isUnrestricted(任意)` false、`extraRootsOf` 原语义（回归）；
  - `setUnrestricted` 后：无 override 会话（含**未建桶**会话）`extraRootsOf` →
    `["/"]`；已有逐目录授权的会话 → `["/"]`（吸收，非并集）；
  - 同一 registry：override 会话与普通会话**共存分叉**——override 会话
    `extraRootsOf` 为原逐目录集（`addExtraRoot` 后读回非空——防吞授权）、
    `isUnrestricted` false；普通会话 `["/"]`、true；
  - `evict(session)` 后旗标保持、该会话 `extraRootsOf` 仍 `["/"]`；
  - `seal()` 后 `isUnrestricted` false（拆卸收回）。
- **plugin 单测**（bench）：mode=full 装配 → `grants.isUnrestricted(undefined)` true；
  auto/plan → false；full 档拒读表仍压过（`read ~/.ssh/id_rsa` 拒、`read .env`
  拒——症状名注明 full 档拒读表仍压过）。
- **proxy 单测**（既有装置）：总括态四断言——① 先 `recordDomain(S, d, "deny")`
  再总括 → CONNECT d 仍 200（负缓存被压过，钉短路位序）；② 放行后
  `domainVerdict(S, d) === undefined`（不记账）；③ askDomain 计数 0；④ 非
  CONNECT 方法仍 405；override 会话不短路（仍走 ask 链）；非总括态既有五条
  回归不动。
- **围栏剖面单测**（装置固定全链：`new GrantsRegistry() + setUnrestricted() →
  fenceFor(base, grants, session) → 剖面函数`，禁手搓 Fence）：
  - seatbelt：profile 含 `(deny default)` 首行、`(allow file-write* (subpath "/"))`、
    denyRead regex 行仍在、代理口 `(allow network-outbound (remote ip "localhost:…"))`
    行在、无 `allow network*` 泛放行；
  - bwrap：argv 含 `--bind / /` 且**相对序**锚——一切 `--ro-bind` 先于 writable
    bind、一切 `--tmpfs` 晚于最后一条 writable bind；
  - worktree 例外消费面锚：override + 总括 → `fenceFor` writable **不含** `"/"`
    且 override.dir 在场。
- **darwin 真跑行为锚**（extra-roots.test 装置扩展，非 tmpdir 界外路径）：
  - full 档 bash 重定向写界外 → 真写出（围栏面修复的行为证据 + SBPL subpath "/"
    真跑验证）；
  - full 档 denyRead 路径现状锚：读拒仍在 + 写放行（rename 边界的显式快照）。
- **apps/cli 装配旅程翻转**（permission-flag.test）：full 界外 write/read/grep →
  permission allow（mode:full）+ **真写出/真读到**（界外目录用 `mkdtemp` 每次
  新建并登记 afterEach 清理——防 FS_NOT_OBSERVED 二次运行 flake；read/grep 路径
  避开 `**/.env`、`~/.ssh/**` 等拒读 glob）；plan/auto 既有用例不动即绿；文件
  头注释同步去挂账叙事。
- **full 会话 resume 负向**：full 建档 → 无 flag 恢复 → auto（界外 write 回归
  ask→deny 审批链——auto 档带 broker 的真实管线中 ask 拒先于 PathGate，
  PATH_ESCAPES_ROOT 形态不可达）——总括不落会话档的行为锚。
- **e2e full 腿**（cli-journey）：真进程 `--permission full -p --mode json` +
  tool_use write 界外（cwd 外 mkdtemp，非 tmpdir 固定名）→ 三重断言：tool_result
  在场 + 不含 `"is_error":true` + content 含 write 成功输出；文件真写出；finally
  清理界外目录。

## 验收清单

- [ ] full 界外 write/read/grep 经工具面真可达（快照翻转 + 新增 + e2e 三重断言）
- [ ] full 档 bash 界外写真出（darwin 真跑锚——围栏面修复证据）
- [ ] 围栏剖面形态全链锚（seatbelt 逐行 / bwrap 相对序 / worktree 例外消费面）
- [ ] full 档网络：代理短路放行、负缓存被压过、不记账、不经 ask（单测四断言）
- [ ] deny 底线分面口径：工具面 deny 规则压过 full（.git 写拒/拒读表）既有+新增
      锚全绿；darwin rename 边界显式落档 + 现状锚
- [ ] worktree 隔离例外：override 会话总括不注入、逐目录授权保留、代理不短路
- [ ] seal 收回总括；evict 不清旗标（单测锚）
- [ ] auto/plan 行为零变化（全部既有用例不动即绿）
- [ ] full 会话 resume 不带 flag 回 auto（负向锚）
- [ ] EXEC-ENV §5 / CLI.md §2.1+§2.6 / PERMISSION-MODE-FLAG.md / grants+adjudicate
      注释同变（人工验收）
- [ ] 四门 + e2e 全绿 + 覆盖率数字如实报告

## 审查处置（2026-09-20 定稿前双路审查）

- **H1 子代理传导失实**：核实——delegation 子建在同一世界（deps.loop.create），
  mode=full 裁决层现状已对子会话生效。改「不处理」表为「共享世界传导是既成
  事实」，契约节如实写明。
- **H2 override 返 [] 吞逐目录授权**：契约拆分「总括贡献 vs 逐目录授权」——
  override 会话保留原语义，仅不注入 `"/"`；测试矩阵补 addExtraRoot 读回锚。
- **H3 darwin rename 绕过拒读表**：核实属实（subpath "/" 全盘写 + deny-read 无
  拒写形态）。内核不可表达（§13 先例）——裁决为显式已知边界：落档 + 现状行为
  锚，不当场造不可表达的内核防线。
- **H4 worktree 子网络无界**：采纳 isUnrestricted(session)——override 会话代理
  不短路，与文件面例外同向。
- **M1 bash 围栏面断裂**：缺陷本质节补记（本件顺带修复）；MODE-FLAG 旧断言
  「bash 面不受影响」在文档同变中纠正。
- **M2/M3 bwrap/SBPL 真跑**：darwin 真跑行为锚补（M3）；linux bwrap 真跑归
  流水线环境，单测锁相对序 + 落档（M2）。
- **M4 代理短路位序与拆卸窗**：位序定在桶查询前（负缓存被压过，用例钉）；
  seal 收回总括（fail-closed），用例钉。
- **M5/M6/S1-S4/L1-L4**：grants 头注释与 EXEC-ENV 会话授权集段同变、测试矩阵
  十五项补强（read/grep 腿、FS_NOT_OBSERVED flake、evict 深等、proxy 四断言、
  bwrap 序、denyRead 写面现状锚、全链装置、full 拒读锚、worktree 消费面锚、
  resume 负向、e2e 三重断言、吸收深等、面归属约束）、注释与文档同变清单
  （CLI.md §2.1/§2.6、adjudicate、permission-flag 头注释）、L4 guard 过滤注释
  ——全部采纳。

## 审查处置（2026-09-20 代码收口前双路审查）

- **P1 evict×override 总括复活（安全缺口）**：核实属实——evict 删桶连 rootOverride
  一起删，分叉条件重成立 → worktree 会话终结瞬间授权面从受限集翻转为全盘根。
  处置：override 会话键进程级记忆（overriddenKeys，evict 不清），分叉条件改查该
  集合；补回归用例（用例名注明症状）。
- **bwrap 相对序锚错位（P2/测试面2 同源）**：indexOf("--bind") 命中的是 root 而非
  "/"——改为定位 `--bind / /` 参数对、断言其为最后一条 writable bind、一切 tmpfs
  晚于它；注释同步修正。
- **denyRead 现状锚双半边（P3/测试面1+3 同源）**：读腿断言 content 含
  `rule:~/.ssh/**`（拒因锚——防 FS 错误伪装规则拒）+ 改读具体文件路径；写腿补
  `denyReadExtra` 注入 home mkdtemp 的显式快照（读拒在、写放行——darwin rename
  边界的直接锚）。
- **proxy unrecorded 腿 DNS 依赖（P6/测试面4）**：注入假 connect（计数+抛错）消
  环境依赖，域名换 RFC 6761 保留 TLD——502 出口 + 计数 1 + 不记账三断言确定论。
- **plugin homeSsh 拒因锚（测试面5）**：补 content 断言（与 .env 腿对称）。
- **full 腿 clearScripted（P4）**：补——腿间解耦约定对齐。
- **fence.ts guard 过滤注释（P5）**：补（与 paths.ts admitSession 同句——方案
  拆分表点名的两处齐了）。
- **知悉项（审查者1）**：方案 resume 负向措辞「回归 PATH_ESCAPES_ROOT」不可达
  （auto 档 ask 拒先于 gate）——文档措辞已同步为「回归 ask→deny 审批链」。
