# REMOTE-ACCESS 设计基线（远程接入：手机远控本地 agent）

> 状态：已核销（B0–B6 落地；三路文档审查 70 条 + 代码审查 38 条全处置）
> 定稿 v3（处置映射 §12）
> 级别：大（新子系统、跨机器、安全/高可用/一致性三重语义）
> 文档族：[REMOTE-ACCESS-IMPLEMENTATION.md](REMOTE-ACCESS-IMPLEMENTATION.md)（施工图）｜
> [REMOTE-ACCESS-WIRE.md](REMOTE-ACCESS-WIRE.md)（字节级线格式 + 测试向量，随 B0 落）
> 上游：apps/host-hub/docs/DESIGN.md（宿主契约基线——本件是它的远程延伸层，不改其一行契约）
> 对标：codex remote control、ZCode 云 relay 远控、minimax-code IM channel。

## 0. 目标与形态

手机 App 在任意网络（含 CGNAT）操控 PC 上的 agent，与桌面 App 看到同一份执行结果。

```
手机 App ──出站 WSS──► hub-relay 集群 ◄──出站 WSS──┐  帧 E2E 加密，relay 只见路由头
                                                │
                                 hub-gateway 守护进程（PC 常驻，系统服务自启）
                                                │ stdio JSONL（host-hub 契约零变更）
                                           host-hub ──► worker×N ──► WAL（唯一真相）
                                                ▲
                 owner 通道：unix socket 0600（macOS/Linux）/ named pipe（Windows）
                                                │
                                      PC 桌面 App（owner 客户端）
```

**身份三钥模型（审查 H4/H3 处置）**：每个参与方都有**长期身份钥对**（Ed25519 签名 +
X25519 加密）：

| 主体 | 长期钥 | 暴露面 |
| --- | --- | --- |
| gateway | `<agentDir>/gateway-identity.json`（0600） | 公钥指纹进 QR/手输确认页，手机钉存；relay 侧注册绑定 installationId |
| relay | 运营者配置（deploy 时生成） | 公钥指纹由管理员 TOFU 核验，进 gateway 配置与 QR |
| 设备 | `<agentDir>/devices/<deviceId>/identity.json`（0600） | 配对时经认证通道注册 |

一切 ratchet 初始化/再初始化/换 DH 公钥的消息**必须携带本端长期钥签名**（验签失败
fail-closed）——杜绝「等 PC 离线 + 声明式登记 + 未认证 re-DH」的劫持链。

裁决：R1 执行宿主=PC（关机即不可达，presence 帧如实展示）；R2 relay 自建（出站双向
穿透 + E2E）；R3 gateway 独立守护进程（`--service-install` 生成定义 + CLI 管理面
`status|devices|pair|revoke|config|logs`）；R4 通道即角色（owner 本地全权 / 远程设备
scope）；R5 手机/桌面 UI 端侧实现，本仓交付协议包（含线格式规范+测试向量）+ 参考客户端；
R6 平台矩阵 macOS/Linux 完整，Windows relay/协议/CLI 交付（named pipe 路径申报未 CI
实测）。

## 1. 协议分层

```
L4 传输    WSS(TLS1.3)                    relay↔手机 / relay↔gateway
L3 路由    {v, from, to, payload}          relay 只读 to；无 seq（有序性归 WSS，防重放归 L2）
L2 可靠    streamId/seq/ACK/分片/cursor    应用层，不信任 WSS 之下任何东西
L1 E2E     X25519+Ed25519+双 ratchet       每设备对；AAD 绑定 L3 头
```

### 1.1 L3 路由信封（relay 可见）

```json
{ "v": 1, "from": "dev_x", "to": "gw_<installationId>", "payload": "<base64(E2E密文)>" }
```

- relay 按 `to` 查路由表；未知 → `error{code:"no-route"}`；`from` 必须等于该连接
  token 认证出的身份（含两类：device token / gateway token，**类间禁互用**），不符丢弃。
- 篡改由端点 AES-GCM tag 检出（AAD = `v|from|to`，防 relay 改写信封头）。

### 1.2 L2 可靠层信封（E2E 密文内）

```json
{ "kind": "command"|"response"|"event"|"ui_request"|"ui_response"|"ack"|"chunk"|"pairing"|"hello"|"bye"|"error",
  "streamId": "st_...", "seq": 1, "body": { ... } }
```

**seq 生命周期（审查 H5 处置）**：

- per-stream 单调；接收方记 `lastDeliveredSeq`。
- `seq == lastDeliveredSeq`（重复帧，ACK 丢失后的合法重发）→ **丢弃载荷 + 补发 ACK**；
  `seq < lastDeliveredSeq`（真重放）→ 拒收计数；`seq > +1`（乱序）→ 重排缓冲
  （1024 帧/stream，per-device 聚合上限 §8；超限发 `error{code:"gap"}`）。
- **订阅基线由发送方宣告**：hello-ack 对每个活跃 stream 携带 `{streamId, baseSeq}`；
  新接入者/重启者直接采用（`lastDelivered = baseSeq`），无「等历史帧」死锁。
- **重发不改 seq**：重发 = 同一 (streamId, seq) 的幂等重放（接收方按上条去重补 ACK）。
  密文层可重新加密（新 ratchet index，见 §1.3）——L2 幂等性不依赖密文比特相同。
- **outbox 保留条件分两类**：command 流条目保留至 **response 到达**（不因帧 ACK 释放
  ——手机必须拿到 thread/start 的 threadId）；event 流条目保留至 ACK 水位（落后超
  1024 帧 → `cursor-too-old` → 引导 WAL 全量水化，活流不受损）。
- **ACK 合并**：每 32 帧或 250ms 合并一个 ack（携最高连续 seq）。

**分片**：明文帧 >4 MiB 切 `chunk`（segmentId/segmentCount）；重组上限 128 MiB/1024 片
（= host WORKER_LINE_LIMIT，覆盖 get_messages 100MiB 软上限满配）；per-device 全局
重组缓冲 ≤256 MiB。

**双序数空间（审查 M9 处置）**：L2 seq（传输去重序）与 WAL seq（会话事实序）是两个
空间。session 域 event 帧 body 内携带 WAL `seq`（host 事件原样）；**双端一致断言域 =
WAL seq**（`(fromSeq, toSeq]` 区间记账，实时域不补偿——既有裁决）。

### 1.2.1 命令路由与幂等（一致性 H1/H2/H3 处置）

- **保序流水线**：gateway 按提交序 FIFO 转发写命令（不逐条等响应）；水化读命令
  （get_entries/get_inflight/get_subagents/get_pending_dialogs）可并发。
- **id 重映射**：host 命令 id 由 **gateway 自铸**（`g<n>` 单调，且永不撞
  `@hub-internal:` 保留前缀）；维护 `(deviceId, commandId) → hostId` 双射；response
  按 hostId 反查认领回投。客户端 id 空间互相隔离，host 视角的恰一对账恒成立。
- **去重日志（write-ahead，崩溃安全）**：写命令在**写入 host stdin 之前**先 append
  落盘 `<agentDir>/devices/<deviceId>/commands.jsonl`（`{commandId, hostId, bodyHash,
  ts}`，fsync 后才转发）；response 到达后追加 `{commandId, response}` 记录。gateway
  重启时重放该日志重建去重表 + pending 映射 + response 缓存——**崩溃重启不产生双
  prompt**。日志环形上限 16384 条/设备（容量不变式：≥ max 在飞命令 65536/host 上限
  × 设备数份额 + 客户端 outbox 上限 1024——环形淘汰只发生在条目远老于任何可能重发
  窗口的情形；淘汰条目重发 → `error{code:"command-expired"}`）。
- **去重在 scope 之后**（审查 L20 处置）：scope 降级设备无法用旧 commandId 取回此前
  被允许命令的缓存响应；缓存命中不消耗限流桶。
- **host 死亡结算（M10 处置）**：gateway 杀 host / 优雅关闭时，对全部 pending 命令
  合成恰一 failure（`error:"host unavailable"`）并写入去重日志（对齐 host 自己的死亡
  对账机器）——手机 outbox 不悬挂。
- **弹窗恰一**：`ui_request` 按 scope 过滤广播（`interact` 及以上；read 设备不见命令
  原文）；先答先得，应答设备进审计。**ack ≠ settle**：ui_response 的 response 恒 ack，
  裁决结果以 `permission/decided` / `tool/result` 事件对账（host 语义如实继承）。
- **水化配方（H6 处置）**：`get_entries{since}` + `get_inflight` + `get_subagents` +
  `get_pending_dialogs` 并行拉取幂等合并；`ui_request` 补偿源 = outbox 回放（1024 帧
  内）+ 超限 `get_pending_dialogs`。

### 1.2.2 线程注册表与代际（一致性 H4 处置）

- **持久线程注册表** `<agentDir>/threads.json`（0600 原子写）：
  `{threadId, sessionPath, epoch, createdAt, lastSeenAt}`；thread/start/resume/register
  的 response 到达时登记；stop/delete/retire 移除。gateway 重启后按注册表逐线程
  `thread/resume`（有界重试）——「按注册表恢复」有实体。
- **epoch 触发集（可判定）**：仅 `fork/clone`（旧 threadId 流作废——gateway 合成
  `thread_superseded` 事件帧 + epoch++，双端游标终结）与 `thread/delete`。stop→resume
  **不 bump**（WAL seq 跨重启连续，host sessionId 永不复用——mintSessionId 词法）。
- **leafSeq 回退检测**：水化请求 `since > 当前 WAL leafSeq`（撕裂写截断恢复后的真实
  场景）→ gateway 强制 snapshot 模式（全量 get_entries）——静默空窗不可能。
- **fork/clone 响应路由**：响应按 id 认领只回发起者；非发起端经 `thread_superseded`
  合成帧知晓流终结，清理本地游标。

### 1.2.3 订阅与转发白名单

- hello 携带 `subs:[{threadId, since, logEpoch}]`；未订阅 thread 的事件不下发。
  thread 域命令（发过/显式订阅）即建立订阅；全局读命令响应只回发起者。
- 转发帧集（封闭）：session 域 `event`（订阅域）、`ui_request`（scope 过滤广播）、
  `thread_died`/`thread_parked`（订阅域）、`settled`（认领者）、gateway 合成域
  `gateway/presence`（relay 链路通断广播——手机如实感知 PC 在线，审查 L17）、
  `thread_superseded`（§1.2.2）。host `heartbeat` 不转发（活性归 WSS ping + presence）。

## 1.3 L1 E2E 加密（安全 H2/M3/M9 + 一致性 M8 处置）

- **配对产物**：设备长期钥对（配对通道内交换、互验签名）→ 双 ratchet 初始化（首次
  DH 消息带长期钥签名，验签 fail-closed）。
- **ratchet 细则**：
  - 对称棘轮按消息推进：messageKey_i = HKDF(chainKey_i)；nonce = `epoch(8B)‖dir(1B)‖
    index(8B)`，index 为 epoch 内单调消息号——**nonce 唯一性由 index 单调保证**。
  - **index 批次预支落盘**：发送批（64 帧或 200ms）开始前，先把
    `{chainKey, nextIndex: batchStart+64}` 原子落盘（临时文件+rename，0600）再发批内
    帧；崩溃重启从 nextIndex 续（≤64 个 index 浪费，**永不复用**）。接收方 index
    记录同策略；**index 回退 → 硬失败**：丢弃 + `error{code:"ratchet-regression"}` +
    触发 re-key。
  - **重发重加密**：outbox 存明文；重发用当前 index 重新加密（同 L2 seq 幂等去重）。
  - **skipped-key 缓存**上限 1024（丢帧补收窗口），超限触发 re-key。
  - **强制 DH rekey**：每设备会话每 2000 消息或 24h 强制一次 DH 推进（事件流单向，
    不等对端）——ratchet 态失窃的暴露窗有界（S4 措辞：失窃 = 未来失守至下一次
    rekey，如实申报）。
- **re-key 握手**：双方互发 `{ephemeralPub, nonce, rekeyCounter, sig}`；sig = 长期
  Ed25519 对 `{本端 ephemeralPub, 对端长期pub, rekeyCounter}` 签名；新根钥 =
  HKDF(新 DH ‖ 旧根钥)；epoch++、index 清零。rekeyCounter 持久化防重放。链指纹失步
  （备份恢复）同样走 re-key，无需用户重扫码。
- **AAD** = `v|from|to`（L3 头）+ epoch——跨代密文注入 tag 必败。
- **防重放态同文件持久化（安全 H5 处置）**：per-stream `lastDeliveredSeq`、去重日志
  水位与 ratchet 状态**同一持久化组**（设备目录下原子批量写）——网关重启后旧密文
  重放被 seq 水位拦住（`seq < lastDelivered` 拒收）。回归用例：重启后重放历史密文
  断言拒收。
- **HKDF 域分离**：salt/info 按 `{pairing|ratchet-root|msg|rekey|sas|relay-token|pake}`
  域分离（线格式文档钉死常量）。
- **E2E fail-closed**：密钥/配置缺失或校验失败 → 拒服务不降级；tag 失败连续 >32 →
  触发 re-key 探测，仍失败 → 会话关闭 + 审计。

## 1.4 配对协议（安全 H1/M2/M5/M8 处置）

**QR 路径**（带外钉死网关身份）：

```
owner 发起（桌面 App / gateway CLI）
  → gateway 创建配对会话 {pairingId, gwEphemeralPub, pairingTicket, expiresAt=+120s}
  → QR = {v, relayUrl, relayKeyFingerprint, gatewayKeyFingerprint, pairingId,
          gwEphemeralPub, pairingTicket}
  → 手机扫码 → 经 relay 出示 pairingTicket（配对准入，见下）→ pairing/request
  → X25519(手机eph, 网关eph) → 配对通道密钥（HKDF）
  → 网关签 {配对转录}（长期钥）→ 手机验签 + 钉存 gatewayKeyFingerprint
  → 长期钥交换 + scope 确认 → ratchet 初始化（签名）→ 设备注册 + relay token 发放
```

**手输码路径（PAKE，非 SAS 兜底）**：

```
owner 发起 → gateway 生成 8 位码（120s、单次）
手机输 {relayUrl, 码} → SPAKE2 风格 PAKE（X25519+Edwards 点运算，码为口令）
  → 在线猜测唯一攻击面：5 次失败锁定 5min（锁定键 = pairingId+relay 接入侧）
  → PAKE 建立安全通道后：下发 relayKeyFingerprint + gatewayKeyFingerprint 并钉存
  → 后续同 QR 路径（长期钥交换 + ratchet 初始化）
```

- **手输路径的 SAS 不作为防线**（攻击者终结双腿时可离线研磨转录 SAS——设计如实
  声明）；防线 = PAKE（码不进明文转录，猜测必须在线）+ 锁定。SAS 数字仍显示，但
  仅作 UX 确认。
- **双向 SAS 录入（QR 路径防橡皮图章）**：owner confirm 需**键入**手机侧显示的 SAS
  6 位（gateway 比对相等才放行）——拍照抢注的攻击者无法让 owner 侧数字对上。
- SAS = 6 位 HMAC(通道密钥, 转录含双方长期钥指纹+scope+relayUrl+协议版本)。
- **pairingTicket**：配对会话创建时 gateway 请 relay 签发的短时（120s）配对准入凭据
  （绑定 pairingId）；未持 ticket 的连接被 relay 挡在配对面之外——任意网络攻击者
  无法灌注配对流量/试探 pairingId（安全 M8）。
- 限速键 = pairingId + relay 侧 IP（远程路径网关看不到真实 IP——安全 M5）。

## 1.5 relay 认证与路由（安全 H3/M4/M15 + 一致性 H7/M15 处置）

- **gateway enroll**：gateway 携带 `{installationId, gatewayKeyPub, sig}`（长期钥对
  enrollment 转录签名）向 relay 注册；relay 记录 `installationId → gatewayKeyPub`
  （首次 TOFU；**已存在且钥匙不同 → 拒绝注册 + 告警帧**——劫持 fail-closed）。
- **token 体系**：relay 运营者持 per-deployment HS256 秘密（env/secret file 供给，
  轮换带 epoch）；gateway token 与 device token 类别字段隔离禁互用；token 绑定
  deviceId/installationId + scope。
- **单活连接**：relay 对同 deviceId 新连接顶替旧连接（被盗 token 并发接入 = 顶掉
  真机，可检测）；撤销按 **deviceId**（拉黑键 = deviceId，refresh 时校验注册表状态
  ——刷新不可绕过撤销）。
- **路由表 = 安全边界**：多实例部署共享存储（自研最小 RESP 客户端 + in-repo fake
  server）硬依赖，`--single-instance` 显式单实例模式才允许进程内存储（多实例配置下
  拒用内存存储启动——fail-fast）；Redis 链路要求 TLS + AUTH（runbook 钉死，中毒 =
  定向劫持面，如实申报）。
- **转发拓扑**：deviceId→installationId 归属表 + installationId→nodeId 连接表均在共享
  存储；跨节点转发经 pub/sub 频道（`route:<installationId>`）。
- **relay 指纹**：relay 长期 Ed25519 签名钥指纹（非 TLS 证书——证书可轮换）；gateway
  配置钉存，**缺失拒启**（fail-closed，安全 M7）；手机侧随 QR/PAKE 通道下发钉存。

### 1.6 版本语义

L3 `v` = major（当前 1）。配对记录钉 `{major, minor}`；hello 双向交换
`{protoMajor, protoMinor, caps}`。minor 差异兼容：未知 `kind` 忽略+计数、未知 body
键忽略；major 不符拒连（需重配对）。caps 封闭词表：`chunk`、`coalesce`、
`snapshot-hydrate`。

## 2. 安全基线

主条款 S1–S5，细化 10 行；测试锚全列 §7。

| # | 条款 | 细化 |
| --- | --- | --- |
| S1 | 防重放 | 重复帧补 ACK、真重放拒收；**水位随 ratchet 同文件持久化**（重启无窗口）；AAD 绑 epoch 防跨代注入 |
| S1' | 降级防护 | major 钉配对记录；TLS1.3；relay/gateway 指纹 TOFU 后钉存；E2E fail-closed |
| S1'' | 身份绑定 | 解密成功+注册表在册 = 帧身份；relay 连接身份 = token（类别隔离）；`from`≠认证身份 → 丢弃 |
| S2 | scope fail-closed | 未知命令默认拒；60×4 矩阵表驱动；owner-only 恒本地 |
| S2' | 配对防爆破 | TTL 120s 单次；5 次锁 5min；限速键 pairingId+relay 侧 IP；pairingTicket 准入 |
| S2'' | 审计 | §2.2 事件族 append-only + 轮转 |
| S3 | 资源防线 | **字节级预解密限流**（每设备 2MiB/s 突发 8MiB）→ 解密 → cmd 桶（10/s 突发 20）→ scope → 去重；L3 帧 16MiB；重排/重组/流数 per-device 聚合上限 |
| S3' | 撤销时效 | 按 deviceId 拉黑（refresh 校验注册表）；撤销即写共享存储（多实例即时）；15min = 共享存储故障时最坏界 |
| S4 | 前向保密 | 双 ratchet + index 批次预支 + 强制 rekey（2000 帧/24h）；态失窃暴露窗有界（至下次 rekey，如实申报） |
| S5 | 残余申报 | §2.1 |

### 2.1 残余风险如实申报

1. **本地同用户恶意软件**：可连 owner 通道**铸出存续性远程设备**（清除恶意进程后
   通道仍在——超出「读会话偷 key」级别，如实申报）。缓解：owner 通道发起的配对
   **缺省 scope=read**，升 interact/full 需桌面 App 二次显式操作；新设备配对在 owner
   下次连接强提示；全程审计。无法根治（同用户即同权限），检测面齐备。
2. **远程盲批 confirm**：提示注入残余。缓解：permission-v2 分级免问 + 弹窗完整展示
   命令原文 + `ui_request-settled` 审计应答者。最终裁判是用户。
3. **元数据泄露**：relay 见时间/频率/大小。接受。
4. **指纹 TOFU**：relay/gateway 指纹首次靠人工核验；配对后钉存无窗口。
5. **installationId 抢注**：未知 id 的 enroll 声明可占位（DoS/元数据面）；首键注册
   TOFU + 冲突告警后，劫持 fail-closed。
6. **ratchet 态失窃**：未来失守至下一次强制 rekey（≤2000 帧/24h 窗）。
7. **Redis 中毒**：定向路由劫持面（路由表完整性 = 安全边界）；TLS+AUTH 缓解。
8. **Windows named pipe 未 CI 实测**（R6）。

### 2.2 审计事件族（`<agentDir>/audit/`，append-only，按天轮转 64MiB×30 天）

`gateway-started/stopped`、`host-restarted`、`pairing-created/confirmed/failed`、
`device-revoked`、`device-scope-changed`、`command-issued{deviceId,command,ok}`、
`ui_request-settled{requestId,threadId,deviceId,decision}`、`owner-only-denied`、
`scope-denied`、`config-changed`、`rekey-performed`、`ratchet-regression`、
`replay-rejected`、`enroll-conflict`。审计必须能回答「昨晚谁批准了那条危险命令」。

## 3. 命令面与设备模型

### 3.1 host 命令 × scope 矩阵（60 命令全量；表 = 单一真相，测试从表生成）

| host 命令组 | read | interact | full | owner-only |
| --- | --- | --- | --- | --- |
| thread/start、resume、register、stop、retire、set_keepalive | ✗ | ✓ | ✓ | — |
| thread/delete | ✗ | ✗ | ✗ | ✓ |
| thread/list、thread/list_saved | ✓ | ✓ | ✓ | — |
| prompt、steer、follow_up、abort、clear_queue、queue/drop、queue/send_now、compact | ✗ | ✓ | ✓ | — |
| get_state、get_inflight、get_messages、get_entries、get_tree、get_session_stats、get_commands、get_fork_messages | ✓ | ✓ | ✓ | — |
| set_session_name | ✗ | ✓ | ✓ | — |
| get_subagents、get_pending_dialogs | ✓ | ✓ | ✓ | — |
| fork、clone | ✗ | ✓ | ✓ | — |
| get_models、set_model、set_model_override | get_models ✓ / 其余 ✗ | ✓ | ✓ | — |
| models/add、models/remove | ✗ | ✗ | ✗ | ✓ |
| auth/list、auth/set_api_key、auth/remove_key | ✗ | ✗ | ✗ | ✓（auth/list 含凭据姿态元数据，刻意不向远程披露） |
| bash、abort_bash | ✗ | ✗ | ✓ | — |
| ui_response | ✗ | ✓ | ✓ | — |
| agents/list | ✓ | ✓ | ✓ | — |
| agents/create、agents/remove | ✗ | ✗ | ✓ | — |
| subagent/steer | ✗ | ✓ | ✓ | — |
| skills/list | ✓ | ✓ | ✓ | — |
| skills/set_enabled、remove、inspect、install | ✗ | ✗ | ✓ | — |
| settings/get | ✗ | ✗ | ✓ | — |
| settings/set | ✗ | ✗ | ✗ | ✓ |
| set_thinking_level、get_thinking_level、permission/set_mode、permission/get_mode | get ✓ / set ✗ | ✓ | ✓ | — |
| get_host_info、set_idle_retire_ms、set_rss_retire_bytes | ✗ | ✗ | ✓ | — |
| workspace/trust | ✗ | ✗ | ✗ | ✓ |

### 3.2 gateway 本地命令族 `gw/*`（gateway 路由，不到 host）

`gw/status`（relay 态/版本/在线设备/计数器）、`gw/devices/list`、`gw/devices/rename`、
`gw/devices/set_scope`、`gw/devices/revoke`、`gw/pairing/start`、`gw/pairing/cancel`、
`gw/config/get`、`gw/config/set`、`gw/logs/tail`、`gw/shutdown`——恒 owner-only；
设备侧仅 `gw/status` 精简版（自身连接）。scope 变更/revoke 即时生效（设备在线则
发 `bye{reason}` 断流）。

### 3.3 gateway 配置 `<agentDir>/gateway.json`（0600）

`{relayUrl, relayKeyFingerprint, remoteEnabled, ownerSocketPath, hostBin, logLevel,
maxDevices}`（null = 缺省派生：socket `<agentDir>/gateway.sock`；hostBin 解析序显式
配置→仓库 dist→PATH）。`remoteEnabled:false` = relay 不拨出、配对拒绝、远程帧拒收。
**relayKeyFingerprint 缺失且 remoteEnabled:true → 拒启（fail-closed）**。配置变更走
`gw/config/set` → 审计 → 热应用。

### 3.4 设备模型与发现

- installationId：`<agentDir>/installation-id`（0600 UUID）。
- 注册表 `<agentDir>/devices/registry.json`（0600 原子写）：`{deviceId, name,
  deviceType, platform, appVersion, longTermPub, scope, pairedAt, lastSeenAt,
  rekeyCounter}`。**deviceId 由 gateway 铸造**（设备不自声明——防撞库）。
- owner 通道发现：well-known socket 路径 + 旁置 `gateway.pid`；桌面 App connect 失败
  + pid 死 → 清残留 socket → 提示启动（`gw/status` 握手探测）。
- 恢复旅程：手机丢失 → owner revoke；PC 重装/agentDir 丢失 → 全设备重配对（唯一
  路径，明示）；ratchet 失步 → re-key 握手（无需重扫码）。

### 3.5 尺寸预算（逐层）

| 层 | 上限 |
| --- | --- |
| 明文 L2 帧 | 4 MiB（超出走 chunk） |
| L3 线上帧 | 16 MiB（对齐 host CLIENT_LINE_LIMIT 量级） |
| 重组 | 128 MiB/1024 片（覆盖 get_messages 100MiB 满配） |
| per-device 重组聚合 | 256 MiB |
| prompt images | host 12MiB b64 → 密文+base64 ~16.3MiB → 5 片送达（chunk 化解决） |

## 4. 高可用

- **gateway**：OS KeepAlive；重启 → host stdin EOF 优雅停（WAL 落盘）→ 按 threads.json
  逐线程 resume（启动窗口内对已注册线程的命令**推迟排队**（≤1024，30s 死线后
  failure）——不撞 `Unknown threadId`，一致性 M11）→ 客户端水化。
- **host 监督**：host 心跳 >10s 停 → gateway 杀 + 拉起（`host-restarted` 审计）；
  拉起期间 pending 命令合成 failure（§1.2.1）。
- **relay**：多实例共享存储硬依赖（§1.5）；节点故障 → 客户端指数退避重连
  （1s→30s 封顶 + jitter）→ 健康节点 → 水化收敛。部署：LB 终结 TLS、`/healthz`、
  runbook（apps/hub-relay/README.md：域名/LB/秘密生成轮换/双实例 compose）。
- **推送钩子**：adapter 接口 + no-op（一期）；FCM/APNs 另行立项。
- **心跳**：gateway↔relay 与客户端↔relay WSS ping 10s/pong 60s；gateway↔host 继承
  1Hz + 死线监督。
- **流量整形 coalesce**：delta 类帧（assistant-stream/llm-chunk/tool-stream/
  bash_execution_update）在 ACK 积压 >64 帧或落后 >500ms 时按 stream 合并增量
  （`coalesced:true`，delta 可连接语义无损）；非 delta 帧（turn/end、settled、
  tool/result、WAL 投影）永不合并丢。活流与历史重放缓冲分离。
- **延迟预算**：gateway 扇出开销（worker 事件→设备线上帧）P50 ≤150ms / P95 ≤400ms
  （同机）；e2e 端到端计时锚 P95 ≤2s（CI 宽放）。

## 5. 与 host-hub 的关系（边界）

gateway 是 host-hub 客户端，host 协议零变更；继承全部既有能力（60 命令、恰一响应/
settled/thread_died、心跳/复活/收编、WAL 恢复、permission-v2、ui_request 恰一
settle）。host-attach 按 §3.3 解析序定位二进制并校验 hello protocolVersion（不符
fail-fast 明示）。

## 6. 不处理（归属）

| 项 | 归属 |
| --- | --- |
| 服务安装动作 UI | 桌面 App/ops；gateway `--service-install` 生成定义文件 |
| 云 runner / 工作区同步 | 不做（R1） |
| WebRTC P2P | 延迟优化预留 |
| 推送实装 | adapter 位 + no-op；另行立项 |
| 手机/桌面 App UI | 端侧（R5） |
| 多 PC 集中管理 | 不做（路由模型天然预留） |
| 文件传输/富媒体 | 不做（prompt images 已支持） |
| relay 跨区 | 一期单区 |
| 无头 PC 远程 owner 操作 | 一期 owner 恒本地（SSH 转发过渡）；远程提权（30s ticket 形态）挂账——协议已预留（gw/* + caps） |
| 设备密钥 OS keychain 加密落盘 | 挂账（一期 0600 文件 + 审计 + 缺省 read 缓解，§2.1#1 如实申报） |

## 7. 测试口径（验收级）

契约级：L2 kind 词表封闭、重复补 ACK/真重放拒收/乱序/gap 矩阵、分片重组矩阵（128MiB
满配）、ACK 合并、双 ratchet N 帧互发 + skipped-key、re-key、强制 rekey 阈值、SPAKE2
往返 + 错码失败、QR/手输配对全程（含 owner 键入 SAS）、scope 矩阵 60×4 表驱动、
线格式测试向量互校。

边界异常：重启后旧密文重放拒收（S1 持久化）、nonce 单调（崩溃重启后）、index 回退
硬失败、leafSeq 回退 snapshot、cursor-too-old 降级、pairingTicket 准入、配对过期/
锁定/单次、撤销后 refresh 拒 + 单活顶替、token 类别隔离、enroll 冲突告警、字节级
限流、16MiB 上限、去重日志崩溃安全（重启后 dedup 命中回缓存 response）、host 死亡
pending 合成 failure、启动窗口命令推迟。

旅程（e2e）：手机 prompt → 双端一致（WAL seq 域断言）→ 断线重连水化；手机 confirm →
双端弹窗 + 审计应答者；撤销后拒命令；gateway 重启 → threads.json resume → 水化 +
去重命中；host 死亡 → 拉起 + pending 结算；双 relay 实例 + fake RESP 路由/撤销传播；
relay 重启重连；弱网注入（乱序/重复/延迟）；cursor-too-old 活流降级；满配图片
prompt 经 chunk 送达；presence 广播。

## 8. 并发与性能预算

- 入站管线序：字节级预解密限流 → 解密 → cmd 桶 → scope → 去重 → 路由。
- 每设备：2MiB/s 字节桶（突发 8MiB）+ 10 cmd/s（突发 20）+ 重排 1024/stream +
  重放缓冲 1024/stream + 并发流 ≤64 + 重组聚合 ≤256MiB；gateway 全局重组 ≤512MiB。
- 定时器常驻 2（relay keepalive + sweep/重传/ratchet 批次/pairing TTL 合一 tick）；
  每 WSS 1 ping。
- gateway 常驻 <100MB（不含 host）；审计轮转 64MiB/天 × 30 天；加密 ≥10MB/s。

## 9. 日志与可观测性

stderr 两级前缀 `gw:` / `gw:relay:` / `gw:device:<id>:`；必记：relay 断连/重连、设备
连入/断开、配对全生命周期、撤销、rekey、ratchet regression、重放拒收、限流命中、
帧丢弃（tag/gap/超限）、cursor-too-old、host 重启、配置变更、enroll 冲突。计数器
（gw/status 读口）：framesIn/Out、replaysRejected、duplicatesAcked、tagFailures、
gaps、rateLimited（bytes/cmd）、cursorTooOld、rekeys、relayReconnects、
hostRestarts、commandsDeduped。

## 10. 对标吸收明细

信封 seq/ACK/分片/cursor（codex）；(fromSeq,toSeq]+logEpoch（ZCode）；身份宿主注入
（ZCode）；30s ticket（ZCode，无头提权挂账预留）；配对码+设备元数据表（codex）；
ACL 管线序 dedup→owner→scope（minimax）；fail-closed 冲突拒启（minimax：多实例拒
内存存储、enroll 冲突拒、E2E 不降级）；企业开关（codex：remoteEnabled）；端点指纹
固化（codex：签名钥指纹非证书）；unix socket 0600（codex/minimax）；分层字节预算
（ZCode wire-codec：§3.5）。

## 11. 用户裁决清单

U1 relay 自建+出站穿透+E2E+共享存储硬依赖；U2 宿主=PC（presence 如实）；U3 独立
守护进程+CLI；U3' 桌面 App 契约（发现+gw/*）；U4 通道即角色+60×4 矩阵；U5 双端一致
（单写者+去重日志崩溃安全+WAL 水化）；U6 安全基线 §2（三钥模型+PAKE+强制 rekey）；
U7 端侧 UI 外置+线格式规范与测试向量为第二契约；U8 无头 owner 挂账（SSH 过渡）；
U9 平台矩阵 R6。

## 12. 审查处置映射（70 条 → 节号）

- 安全 H1→§1.4（PAKE）；H2/H4→§0 三钥+§1.3 签名；H3→§1.5 enroll 签名+冲突告警；
  H5→§1.3 水位同文件持久化；M1→§2.1#1+缺省 read；M2→§1.4 双向 SAS 录入；M3→§1.3
  细则；M4→§1.5 token 体系+单活；M5→§1.4 限速键；M6→§8 管线序；M7→§3.3 缺失拒启；
  M8→§1.4 pairingTicket；M9→§1.3 强制 rekey+§2.1#6；L1→§3.4 gateway 铸造；L2→§1.3
  HKDF 域+线格式文档。
- 一致性 H1→§1.2 seq 生命周期；H2→§1.2.1 id 重映射；H3→§1.2.1 去重日志；
  H4→§1.2.2 线程注册表；H5→§1.2 订阅基线；H6→§1.2.1 水化配方；H7→§1.5 共享存储
  硬依赖；M8→§1.3 批次预支+原子写；M9→§1.2 双序数+§3.5 修正；M10→§1.2.1 host 死亡
  结算；M11→§4 启动窗口；M12→§1.2.1 ack≠settle+scope 过滤；M13→§3.1 矩阵；
  M14→IMPL §1 批次；M15→§1.5；L16→§1.1 删 L3 seq；L17→§1.2.3 presence；L18→§8
  定时器+§1.2.3 订阅；L19→删句；L20→§8 管线序。
- 产品 34 条：A1/A2/A10→§3.1；A3→§3.2；A4→§6 挂账；A5→§1.2.1；A6→§1.2 补 ACK；
  A7→§1.2.1 去重日志；A8→§3.5；A9→§1.2.3；B1→§1.5；B2→§1.5 deviceId 拉黑；
  B3→§3.3；B4→§3.4；B5→§1.6；B6→§1.5 签名钥指纹；B7→§3.4；B8→§4 runbook；
  B9→R3 CLI；B10→R6；B11→§2.1#5；C1→§2.2；C2→§9；C3→§2.2；D1→线格式文档；D2→§1.6；
  D3→§6 预留；E1→§1.3；E2→§4 coalesce+缓冲分离；E3→§4 延迟预算；E4→§1.1；
  F1→§7；F2→§5；G1→§2 行数措辞；G2→§6 措辞。
