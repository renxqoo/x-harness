# hub-relay 部署 runbook

中继是公网无状态服务（路由表在共享存储）。一 PC 一 gateway 经它路由；帧 E2E 加密（本服务只见元数据）。

## 单实例（最快起步）

```bash
RELAY_TOKEN_SECRET="$(openssl rand -hex 32)" \
bun apps/hub-relay/src/main.ts --port 443 --host 0.0.0.0 --single-instance
```

`--single-instance` 显式声明进程内路由表（多实例配置下缺共享存储会拒启——fail-fast）。

## 双实例 + LB（生产）

1. Redis（TLS + AUTH；路由表是安全边界——中毒 = 定向劫持面）。
2. 两个 relay 进程：

```bash
RELAY_TOKEN_SECRET="<同值>" \
bun apps/hub-relay/src/main.ts --port 8080 --host 0.0.0.0 \
  --redis-host <redis-host> --redis-port 6379 [--redis-password <pw>]
```

3. LB 终结 TLS（wss→ws 回源）；`GET /healthz` 健康检查；粘性不需要（连接级路由，设备重连任意节点可路由）。

## 密钥与轮换

- `RELAY_TOKEN_SECRET`：per-deployment HS256 签发/校验。轮换：新 secret 上线 → 旧 token 15min 内自然过期（gateway enroll 自动重取）；双实例必须同值。
- relay 长期身份钥（签名指纹，配对时被手机钉存）：与 TLS 证书无关——证书可 90 天轮换，签名钥轮换才需重配对。

## 端点

| 端点 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /healthz` | 无 | 存活/连接数 |
| `POST /api/enroll/challenge` | 无 | enroll 两步之一（nodeId+nonce） |
| `POST /api/enroll` | 签名 | gateway 注册（键冲突 409）→ gateway token |
| `POST /api/pairing-ticket` | gateway token | 配对准入票据（120s） |
| `POST /api/revoke` | gateway token | 按 deviceId 拉黑（即时广播） |
| WSS `/?token=` | token | 设备/gateway 数据面 |

## 运维要点

- 节点故障：客户端指数退避重连（1s→30s+jitter）落到健康节点；WAL 游标水化补齐（无会话丢失）。
- 撤销时效：撤销写入共享存储即时生效；共享存储故障期最坏 15min（token TTL）。
- 每连接帧速率 400/s 突发（超限断连）；单节点 10k 连接上限。
- 日志（stderr，`hub:` 无前缀——relay 独立进程）：enroll 冲突、撤销、单活顶替值得外送。
