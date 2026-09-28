# hub-gateway

PC 守护进程：host-hub 的唯一客户端 + 手机等远程设备的中继网关。设计见
[docs/REMOTE-ACCESS-DESIGN.md](../../docs/REMOTE-ACCESS-DESIGN.md)；线格式见
[docs/REMOTE-ACCESS-WIRE.md](../../docs/REMOTE-ACCESS-WIRE.md)。

## 形态

```
手机 App ──WSS──► hub-relay ◄──WSS── hub-gateway ──stdio──► host-hub ──► worker×N
桌面 App ──unix socket（owner 全权）──► hub-gateway
```

## 启动

```bash
# 本地形态（remoteEnabled:false——零配置，owner 通道即可用）
bun apps/hub-gateway/src/main.ts --agent-dir ~/.x-harness/hub

# 远程形态（gateway.json 见 DESIGN §3.3；指纹缺失拒启）
bun apps/hub-gateway/src/main.ts --agent-dir ~/.x-harness/hub
```

`<agentDir>/gateway.json`：

```json
{ "remoteEnabled": true, "relayUrl": "wss://relay.example.com", "relayKeyFingerprint": "sha256:…" }
```

## owner 通道（桌面 App 对接）

- socket：`<agentDir>/gateway.sock`（0600；pid 旁置 `gateway.pid`——连接失败 + pid 死 = 清残留后提示启动）。
- 协议：JSONL（L2 帧，明文——本机同用户即信任域）；`gw/status` 握手探测。
- 命令族：`gw/status|devices/list|devices/rename|devices/set_scope|devices/revoke|pairing/start|pairing/cancel|config/get|config/set|logs/tail|shutdown` + host 60 命令直通（owner 全权，词表外拒）。

## 设备配对

1. 桌面 App 发 `gw/pairing/start {scope}` → gateway 生成配对会话（120s 单次）+ pairingTicket（经 relay）→ 返回 QR 内容 / 8 位手输码。
2. 手机扫码（或输码走 PAKE）→ 双方显示 6 位 SAS。
3. owner 在桌面 App **键入**手机侧 SAS → gateway 比对放行 → 设备注册（缺省 `read`；升级 scope 需 owner 二次操作）。

## 安全要点（详见 DESIGN §2）

- 帧恒 E2E 加密（双 ratchet；relay 只见元数据）；撤销按 deviceId 拉黑。
- 审计（`<agentDir>/audit/`，按天轮转）：配对/撤销/scope 变更/命令发放/ui_request 应答者——可回答「谁批准了那条危险命令」。
- scope 矩阵 60 命令×4 档表驱动（`packages/remote-protocol/src/vocab.ts`）；未知命令默认拒。
