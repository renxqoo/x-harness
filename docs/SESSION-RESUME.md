# Session resume 支撑方案（收件箱词条 + header 覆盖 + 可验证续写）

> 状态：已核销（方案审 10 条处置 + DSH 测试对照承接落档于 SESSION.md §8；四门全绿）
> 级别：中（契约扩展 + 持久化行为扩展；涉及一致性语义）
> 上游：docs/AGENT-LOOP.md（纲领 §3 处置 P1/P2/P9/P10 落实于此）
> 一句话：为 agent-loop 提供崩溃存活的收件箱词条与 resume 的同 id 续写能力。格式无版本字段，身份判别靠闭合词表 fail-closed 校验。

## 1. 契约

### 1.1 新词条（第 14 条，log-only）：`agent/inbox/spliced`

```ts
export type InboxTarget = "next-turn" | "next-step";
export interface InboxEntry { readonly id: string; readonly content: readonly ContentBlock[] }
export type InboxSpliceData =
  | { readonly op: "insert"; readonly target: InboxTarget; readonly entries: readonly InboxEntry[] }
  | { readonly op: "claim"; readonly target: InboxTarget; readonly turn: number; readonly claimed: readonly string[] }
  | { readonly op: "clear"; readonly reason: string };
```

- **claim 按成员移除**（纲领 P9）：claim 携带被领条目 id 全集，fold 从双队列按 id 移除——不依赖队列位置语义。step0 一条 `claim{next-turn}` 的 claimed = 「next-turn 队首 + next-step 全部」的 ids；后续步 `claim{next-step}`。
- **fold 契约钉死**（审查处置 #7，agent-loop 承接实现）：fold 判重 = 按**当前队列在场**；claim 移除后同 id 再 insert **必须重新入队**（repair 回灌依赖此语义；`I(X)→C(X)→I(X)` 重放任意遍收敛为 X 在场）。本件写侧不拦同卷重复 id insert。
- 本件只负责词条 + 形状门：target 合法、entries 的 id 非空串且 content 过 ContentBlock 门、claim 的 turn 为 count、claimed 为非空串数组（可空数组）、clear 的 reason 非空串。entry id 铸造（`crypto.randomUUID()`）归 loop。

### 1.2 格式身份：无版本字段

- SessionHeader 不携带格式版本字段（本仓无历史档案，不预埋演进机制——用户裁决：不复制 DSH 的版本机制）。格式身份判别 = 闭合词表 + fail-closed 校验：追加式词表演进双向安全（旧运行时读新日志遇未知词条拒；新运行时读旧日志是子集恒可读）；语义级变更（改既有词条含义/信封/surface 机制）发生的当下再引入显式判别字段——字段缺失即变更前档案（SESSION.md §1.6）。

### 1.3 create 的 header 覆盖（resume 用）

```ts
create(options?: { id?; seed?; parent?; header?: SessionHeader })
```

- `header` 提供时：id 取 `header.id`（`options.id` 必须缺省或相等，否则 `invalid-header` 失败）；`parent` 忽略；header 原文深冻入账（createdAt/cwd/parentSession 保留归档值）；`isSafeSessionId(header.id)` 否则 `invalid-header:<reason>`。
- 推荐来源：`archive.read` 返回的原文对象。header 相等性比较（§1.4）用**键排序规范化 JSON**（审查处置 #4），不受键序/可选字段缺省影响。
- 既有 create（无 header）行为不变。

### 1.4 持久化可验证续写（两级打开 + 尾态修复 + 前缀裁剪）

`openSessionWriter` 升级（审查处置 #1/#2/#5/#8）：

**Level 1（现行路径）**：`events.jsonl` `'ax'` 打开成功 → 尝试 `header.json` `'wx'`：
- 成功 → 全新档案（不变）；
- `'wx'` EEXIST → 探测孤儿 header：读磁盘 header 与当前会话 header **规范化相等** → **续写**（k=0，我方刚建的空 events 即续写基底）；不等 → 撤销刚建空 events + dead（现行 `session-id-reused`）。

**Level 2（`'ax'` EEXIST）** → 续写校验：
1. **字节级尾态修复**：读 events.jsonl 全文；不以 `\n` 结尾 → 以 `'a'` 打开后 `truncate` 到最后一个 `\n` 之后（半行丢弃；完整无尾换行行被收编进 D 后由 pending 干净重写；修复中途再崩溃 → 下次 resume 重复收敛，不发散）。
2. 解析修复后的行 → 磁盘卷 D（此路径下中间行损坏 → dead）。
3. 磁盘 `header.json` 与当前会话 header **规范化相等**（不等 → dead）。
4. **前缀校验**（含相等）：`D.length ≤ C.length` 且逐事件**规范化深度相等**（C = `store.get(id).events()` 当时值；C 单调增长不破坏前缀）。
5. 全过 → 同一 fd 续写（追加模式），**返回前缀长度 k**。

**pending 裁剪**（审查处置 #2）：created 首灌 pending 初始化仍为构造期全量；首个排空段在 writer 就绪后将 `pending = pending.slice(k)`（k 闩在该 writer 上；D 段永不重写；await 期间新到事件只追加尾部，slice 按前缀长度截断不误删）。flush 中途失败重试按既有「写后移除」语义，只重放 k 之后的批次；writer.append 失败先**截断回滚到批前长度**再重抛（同进程重试无重复字节）。

**失败路径**：任一校验不过 → 按**来源分类的永久拒绝**（`permanent` 标记闩 dead，区别于可重试瞬时 I/O）：header 缺失 `archive-orphan-events` / header 不等 `session-id-reused` / 前缀不符 `archive-prefix-mismatch` / 中间损坏 `archive-corrupt`。

**语义合并声明**：「同 id 重生」只有两形态——带归档 header = 续写（resume），带新 header = dead。「全新重开同 id」概念消失；**截断式恢复不支持**（seed 必须含全量 D，否则前缀校验必拒；要截断请 fork）。

**并发边界**（审查处置 #3）：可验证 ≠ 独占。**跨进程并发续写同一档案会交错腐蚀（seq 重复 → 整卷拒读）——单进程单写者部署是硬性前提**，由宿主装配保证；SESSION.md 同步稿与纲领 §2.6 口径同步为「重用不可验证不续写；可验证不等于独占，跨进程并发续写会腐蚀」。

## 2. 问题域

**处理**：inbox 词条与形状门；create header 覆盖；writer 两级打开 + 尾态修复 + 前缀裁剪。

**不处理**：

| 项 | 归属 |
| --- | --- |
| 收件箱 fold 投影（含在场判重实现） | agent-loop（AGENT-LOOP-DRIVER.md） |
| claim↔user/message 崩溃窗口的 repair 回灌 | agent-loop repair |
| insert 的业务语义（steer/followup 时序） | agent-loop |
| 跨进程写者互斥（锁文件/flock） | 不做——单进程部署硬性前提（§1.4） |
| v0/更早档案迁移 | 不存在，永不做 |

## 3. 并发/一致性预算

- 续写校验 O(磁盘卷)（仅 EEXIST 路径，一次性，与首灌同链串行）；事件与 header 的相等性均用键排序规范化 JSON 比较（不依赖构造键序）。
- 尾态修复一次 truncate；k 闩定后 D 段零重写。
- 既有预算不变（append O(1)、flush 一次 fsync、per-id 串行链、写后移除重试）。

## 4. 拆分

```
packages/core/session/src/types.ts        # Inbox 类型 + CreateSessionOptions.header
packages/core/session/src/gates.ts        # 第 14 词条形状门
packages/core/session/src/store.ts        # create header 覆盖分支
packages/session-persistence-jsonl/src/equal.ts    # 规范化深度相等（键排序 stringify）
packages/session-persistence-jsonl/src/writer.ts   # 两级打开 + 尾态修复 + 返回前缀长度 k
packages/session-persistence-jsonl/src/plugin.ts   # ensureWriter 传当前日志；首灌 pending.slice(k) 裁剪
docs/SESSION.md                      # 同步现行契约（词表 14 条、header 覆盖、续写语义与并发边界）
```

依赖方向不变。

## 5. 实施顺序

1. session 包（types/gates/store + 单测）；2. persistence 包（equal/writer/plugin + 单测）；3. 既有测试迁移与六类新用例（见 §7）；四门；收口一提交。

## 6. 审查处置记录

#1 残尾融合 → §1.4 Level-2 步 1 尾态修复；#2 首灌双写 → §1.4 pending 裁剪 + k 闩；#3 跨进程腐蚀 → §1.4 并发边界 + §2 不处理；#4 header 比较 → 规范化相等（§1.3/§1.4）；#5 孤儿 header → §1.4 Level-1 探测；#6 无格式版本字段（用户裁决：无历史版本不预埋机制，闭合词表 fail-closed 即身份判别）→ §1.2；#7 fold 判重 → §1.1 钉死；#8 dead 闩 → §1.4 重抛 EEXIST；#9 dispose→read 竞态 → §7 前置条件；#10 措辞/截断声明 → §1.4。

## 7. 测试口径

- **契约级**：14 词条封闭；inbox 门表驱动（三 op 合法 / target 非法 / id 空串 / content 坏块 / turn 负数 / claimed 含空串 / reason 空串）。
- **header 覆盖**：原文入账（createdAt/cwd 保留）；id 冲突/非法 id → invalid-header；无 header 行为回归。
- **续写主链**：写→flush→dispose→**已排空前置**（dispose 前 flush，审查 #9）→新 store 同 id `create({header: 归档 header, seed: 归档卷+repair closers})`（构造器补 end-seed）→ 续写打开 → flush → 重启读 = 全量无重复；**二次续写幂等链**（再 resume 同 id，第二次前缀 = 第一次续写后全量）；**续写后 flush 中途失败重试不重写 D 段**（断言磁盘卷前缀字节不变）。
- **续写拒配**：seed 篡改（前缀不符）→ dead + 旧档不变 + **第二次 flush 仍报 session-id-reused**（dead 闩）；新 header 同 id → dead；孤儿 header（header 在 events 缺）+ header 相等 → 续写 k=0；孤儿 header 不等 → dead。
- **残尾续写**（审查 #1，两态）：半行 → 截断丢弃 + 续写后读全量；完整行缺尾换行 → 收编 + pending 干净重写 + 读全量。
- **回归**：既有 319 用例全量回归；发现 bug 逐条带症状用例。

## 8. 验收清单

- [x] §1.1–§1.4 逐条（含 fold 契约、无版本字段、两级打开、尾态修复、pending 裁剪、并发边界）
- [x] §7 表驱动与续写矩阵逐条（含残尾两态、孤儿 header、二次续写幂等链、dead 闩稳定）
- [x] 四门全绿：358 用例全过；总覆盖率 行 93.36 / 语句 91.71 / 函数 94.36 / 分支 95.21（阈值 90/90/90/85）
- [x] 本件方案审（10 条）全处置；DSH 测试对照承接完成（SESSION.md §8）
