# REMOTE-ACCESS 线格式规范（WIRE）

> 上游：[REMOTE-ACCESS-DESIGN.md](REMOTE-ACCESS-DESIGN.md)。本文是字节级单一真相：
> Swift/Kotlin/TS 端侧栈按本文互操作实现；官方测试向量见 `packages/remote-protocol/src/__test__/`。
> 常量改动 = 换 protocol major。

## 1. 传输与帧

- 传输：WebSocket（RFC 6455）；生产 `wss://`（TLS 由 LB 终结），本地开发 `ws://` 仅 loopback。
- 帧上限 64 MiB（`ws-frame-reader.ts` FRAME_MAX_BYTES）；文本帧一帧一条 L3 信封。
- ping/pong：服务端每 10s ping；客户端**必须回 pong**（60s 无活性断连）。

## 2. L3 路由信封（relay 可见）

```json
{"v":1,"from":"dev_<deviceId>","to":"gw_<installationId>","payload":"<base64 密文>"}
```

- `from`/`to` 恒带 `dev_`/`gw_` 前缀；token subject 是裸 id。
- relay 错误信封：`{"v":1,"from":"relay","to":"caller","payload":"<base64({\"code\":\"no-route\"})>"}`。
- 篡改由端点 AEAD tag 检出（relay 不解密）。

## 3. L2 帧（E2E 密文内明文）

```json
{"kind":"command|response|event|ui_request|ui_response|ack|chunk|pairing|hello|bye|error","streamId":"...","seq":N,"body":{...}}
```

- `seq` per-stream 单调；接收方 `seq == last` 丢弃载荷补 ACK、`seq < last` 拒收、`seq > last+1` 入重排（1024 帧）。
- command body：`{command, id, args?}`；response body：`{id, command, success, data?, error?}`。
- event body：`{threadId, name, payload, agentName?, epoch?}`。
- chunk body：`{segmentId, segmentCount, totalBytes, data(base64)}`；明文帧 >4 MiB 切片，重组上限 128 MiB/1024 片。
- ack body：`{acks:[{streamId, upTo}]}`（32 帧或 250ms 合并）。

## 4. L1 加密

- 套件：`x25519-ed25519-aes256gcm-hkdf-sha256-v1`。
- 裸钥编码：hex（私钥 32B 种子；公钥 32B）。DER 封装仅实现细节（pkcs8 48B/SPKI 44B）。
- HKDF info 域（钉死）：
  - `xh-remote/pairing-channel/v1`、`xh-remote/ratchet-root/v1`、`xh-remote/message-key/v1`
  - `xh-remote/rekey-root/v1`、`xh-remote/sas/v1`、`xh-remote/relay-token/v1`、`xh-remote/pake/v1`
- nonce = `epoch(8B BE) | direction(1B) | index(8B BE)`（17B）；direction：发起侧（gateway）=0、应答侧（设备）=1。
- AAD = UTF-8 `"v1|" + from + "|" + to + "|" + epoch`（epoch 十进制）。
- 密文 = AES-256-GCM(plaintext, key, nonce, AAD) ‖ tag(16B)；payload = base64(密文)。
- ratchet 链（hex 字符串态）：
  - messageKey = HKDF(chainKey, salt=32×0x00, info=message-key, 32)
  - nextChain = HKDF(chainKey, salt=64×0x00, info=ratchet-root, 32)
  - 初始链：root = HKDF(shared, 32×0x00, ratchet-root, 32)；发起侧 send 链 = HKDF(root, 49×'I', message-key, 32)，recv 链 = HKDF(root, 50×'R', …)；应答侧镜像。
- 强制 rekey：2000 消息或 24h；index 批次预支落盘（64 帧批）——nonce 永不复用。

## 5. 配对

- QR：`{v:1, relayUrl, relayKeyFingerprint, gatewayKeyFingerprint, pairingId, gwEphemeralPub, pairingTicket}`。
- SAS = 6 位十进制 = `HMAC-SHA256(channelKey, "<transcript>|<gwFp>|<devFp>").readUInt32BE(0) % 10^6`，零填充。
- 手输码 8 位；PAKE：发起 `A = X25519(HKDF(secret‖code), G)`，应答 `B` 同构；shared = `HKDF(DH(blind, peerMsg) ‖ code, pake)`；confirm = `HMAC-SHA256(shared, transcript)`。

## 6. relay 认证（HTTP 面）

- `POST /api/enroll/challenge` → `{nodeId, nonce}`。
- `POST /api/enroll` `{installationId, gatewayKeyPub, sig, nonce}`——sig = Ed25519(gateway 私钥, `"enroll|<installationId>|<gatewayKeyPub>|<nodeId>|<nonce>"`)；键冲突 409。
- `POST /api/pairing-ticket`（gateway token）→ `{ticket}`；`POST /api/revoke`（gateway token）`{deviceId}`。
- token：HS256 JWT；claims `{kind: device|gateway|pairing, subject, installationId?, scope?, iat, exp, jti}`；TTL 15min（pairing 150s）。
- WSS 接入：`GET <path>?token=…` 或 `Authorization: Bearer`；`from` 必须等于认证身份（L3 地址重组比对）。

## 7. 测试向量

实现互校以仓内测试为准：`packages/remote-protocol/src/__test__/`（crypto.test.ts 的 RFC 向量、ratchet.test.ts 的 N 帧互发、pairing.test.ts 的 SAS/PAKE、ws 帧矩阵）；e2e 旅程 `packages/remote-client/src/__test__/e2e.test.ts`。
- `POST /api/device-token/refresh` {deviceId, nonce, sig}——设备长期钥签名挑战应答（TOFU 钉存钥验签；15min TTL 的可持续续期路径，M12）。
