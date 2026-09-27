# REMOTE-ACCESS 施工图

> 状态：已核销（B0–B6 落地；三路文档审查 70 条 + 代码审查 38 条全处置）
> 上游：[REMOTE-ACCESS-DESIGN.md](REMOTE-ACCESS-DESIGN.md)（契约与裁决单一真相）
> 定位：模块划分、批次划分、测试装置、验收清单。不重复设计，只引用节号。

## 0. 模块划分

```
packages/remote-protocol/              协议契约包（零 @x-harness/* 依赖）
  src/frames.ts          L2 kind 词表 + 各 kind body 形状
  src/envelope.ts        L3 路由信封编解码 + 校验
  src/reliable.ts        seq/ACK/重排/分片/重组/cursor/订阅基线（§1.2）
  src/crypto.ts          X25519/Ed25519/HKDF/AES-GCM + 双 ratchet（§1.3：index 批次
                         预支、skipped-key、强制 rekey、AAD、重发重加密）
  src/pake.ts            SPAKE2 风格 PAKE（手输码路径 §1.4）
  src/pairing.ts         QR/手输配对状态机 + SAS 转录（§1.4）
  src/vocab.ts           scope/owner-only 60×4 矩阵 + gw/* 命令族（§3.1/§3.2 表为源）
  src/limits.ts          常量单点（§3.5/§8）
  src/index.ts           导出面

packages/remote-protocol/fixtures/     线格式测试向量（REMOTE-ACCESS-WIRE.md 互校）

apps/hub-gateway/                      PC 守护进程
  src/main.ts             入口 + CLI（status/devices/pair/revoke/config/logs/
                          service-install/service-uninstall，R3）
  src/config.ts           gateway.json 装载/校验/热应用（§3.3；指纹缺失拒启）
  src/identity.ts        gateway 长期身份钥（§0 三钥）
  src/host-attach.ts      spawn host-hub、心跳监督（>10s 杀+拉起）、hello 版本校验（§4/§5）
  src/threads-registry.ts 持久线程注册表 threads.json（§1.2.2）
  src/owner-server.ts     unix socket 0600 owner 通道（明文 IPC + L2 信封，L1 关——
                          本机同用户即信任域边界 §0）
  src/device-registry.ts  设备注册表 + commands.jsonl 去重日志（§3.4/§1.2.1）
  src/pairing-server.ts   配对会话（TTL/单次/锁定/双向 SAS 录入/pairingTicket）
  src/relay-link.ts       出站 WSS、enroll 签名、token refresh、重连退避（§1.5）
  src/session-crypto.ts   per-device ratchet 会话 + 持久化组（状态/水位/去重同组原子写 §1.3）
  src/inbound.ts          管线：字节限流→解密→cmd 桶→scope→去重→路由（§8）
  src/fanout.ts           订阅管理 + 事件扇出 + coalesce + outbox（保留至 response/
                          ACK 水位）+ thread_superseded/presence 合成（§1.2.3/§4）
  src/audit.ts            审计事件族 + 轮转（§2.2）
  src/limits.ts           常量单点

apps/hub-relay/                        公网中继（零业务状态）
  src/main.ts             入口（--single-instance 显式单实例 §1.5）
  src/auth.ts             gateway/device token（HS256 类别隔离）、enroll 注册、
                          pairingTicket 签发、deviceId 拉黑、单活连接（§1.5）
  src/router.ts           归属表/连接表（共享存储硬依赖；RESP 客户端接口）
  src/store-memory.ts     进程内存储（仅 --single-instance）
  src/store-redis.ts      最小 RESP 客户端（GET/SET/DEL/PUBLISH/SUBSCRIBE）
  src/connections.ts      WSS 接入（from==token 身份、转发、no-route）
  src/push-adapter.ts     推送钩子接口 + no-op
  src/limits.ts           常量单点

packages/remote-client/                参考客户端（兼 e2e 驱动）
  src/connect.ts          统一入口：经 relay（E2E 全开）或 unix socket（owner 形态）
  src/ratchet-store.ts    客户端侧 ratchet/水位持久化
  src/outbox.ts           客户端命令 outbox（保留至 response；断线重发 §1.2）
  src/hydrate.ts          水化配方（get_entries+get_inflight+get_subagents+
                          get_pending_dialogs 幂等合并 §1.2.1）
  src/retry.ts            指数退避 + jitter
  src/main.ts             CLI 参考客户端（演示/e2e 双用途）

docs/REMOTE-ACCESS-WIRE.md             字节级线格式规范 + 测试向量说明（B0 随代码落）
apps/hub-relay/README.md               relay 部署 runbook（域名/LB/秘密轮换/双实例 compose）
```

依赖方向：remote-client → remote-protocol；hub-gateway/hub-relay → remote-protocol。
**不改 host-hub / 内核包任何一行**。

## 1. 批次划分（每批四门全绿后提交）

| 批 | 内容 | 测试重心 |
| --- | --- | --- |
| B0 | remote-protocol 全量 + REMOTE-ACCESS-WIRE.md + 测试向量 | DESIGN §7 契约级+边界全量 |
| B1 | hub-relay（auth/router/store×2/connections）+ fake RESP server + runbook | token 体系、enroll 冲突、单活、撤销传播、no-route |
| B2 | gateway 骨架：main/CLI/config/identity/host-attach/threads-registry/owner-server + fanout 骨架（**L2/L3 信封走 B0 定型面，L1 对 owner 关**——一致性 M14） | owner 旅程、host 监督、启动窗口推迟、threads resume |
| B3 | gateway 设备面：device-registry + commands.jsonl + pairing-server + session-crypto + audit | 配对两路径、去重崩溃安全、ratchet 恢复、审计断言 |
| B4 | gateway 完整管线：relay-link + inbound + fanout 完整（coalesce/outbox/superseded/presence） | 越权矩阵、重放拒收、字节限流、双端一致 |
| B5 | remote-client + e2e 全旅程 | §7 旅程全量（含双 relay、弱网注入、cursor-too-old、满配图） |
| B6 | 收口：README、覆盖率补齐、验收清单核销、假绿抽查 | 验收 |

依赖序：B0 是地基；B2 明确「L1 关、L2/L3 在」防返工；audit 提前到 B3（S2'' 约束）；
B4 才接 relay（B1 独立可测）。

## 2. 测试装置

- remote-protocol `__test__/`：表驱动（帧矩阵/分片矩阵/scope 60×4/ratchet N 帧）+
  线向量互校 + fake crypto clock。
- hub-gateway `__test__/`：spawn 真 host（HUB_WORKER_PROVIDER=script 剧本 LLM，复用
  host-hub 装置思路）+ 进程内 fake relay。
- hub-relay `__test__/`：in-repo fake RESP server + WebSocket 客户端模拟双实例。
- e2e（remote-client `__test__/` + packages/e2e 挂旅程）：三进程拓扑（relay + gateway
  +host + 双客户端）全链，断言 WAL seq 域双端一致与水化收敛；弱网注入（乱序/重复/
  延迟/cursor-too-old）；延迟计时锚（P95 ≤2s CI 宽放）。

## 3. 验收清单

- [ ] DESIGN §7 测试口径全绿（契约级/边界/旅程）
- [ ] 安全基线 §2 每条测试锚存在且绿
- [ ] 双端一致旅程断言（WAL seq 域）绿
- [x] host-hub 契约零变更（本分支 9 个提交只新增 remote 四件与文档；diff 里 autocompact/compaction 等 12 文件为 main 在途他人提交 2cf523b/cc4c72e，非本分支改动）
- [ ] 四门全绿 + 覆盖率 ≥90/85 只升不降
- [ ] 对抗审查（文档轮已清零）+ 代码轮问题清零
- [ ] 假绿抽查：无 skip/无断言删改/无阈值调低
- [ ] 文档状态推进：草稿→定稿→已实施→已核销
- [ ] REMOTE-ACCESS-WIRE.md 与 fixtures 互校绿
- [ ] relay runbook 完备（compose + 秘密轮换步骤）
