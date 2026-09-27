// 双 ratchet（DESIGN §1.3）。密码学硬约束（违反 = 缺陷）：
// - messageKey 按消息从 chainKey 确定性派生（KDF 链）；消费即弃（内存不留旧 chainKey）；
// - nonce index 在 epoch 内单调；发送批开始前预支落盘 {chainKey, nextIndex}，崩溃后
//   从 nextIndex 恢复——已用 nonce 永不复现（最多浪费批尾未用 index）；
// - 重发 = 重新加密（新 index）；幂等去重归 L2 seq，与密文比特无关；
// - skipped-key 缓存有界（丢帧补收窗口）；index 回退 → regression（硬失败）；
// - 强制 rekey：消息数/时间阈值触发 DH 棘轮推进（发送方向自发新 ratchet key）。
// 本文件是纯逻辑：持久化经 RatchetPersist 接口注入（gateway/客户端各自实现原子写）。
import { aeadOpen, aeadSeal, buildAad, buildNonce, hkdf, HKDF_INFO } from "./crypto.ts";
import { RATCHET_BATCH_FRAMES, RATCHET_SKIPPED_KEY_MAX, TAG_FAILURE_REKEY_THRESHOLD } from "./limits.ts";

/** 持久化组（§1.3：ratchet 状态与防重放水位同组原子写） */
export interface RatchetPersist {
  /** 发送批边界落盘：{chainKey, nextIndex}——成功 resolve 后才可发批内帧 */
  persistSendBoundary(deviceId: string, state: SendBoundary): Promise<void>;
  /** 接收边界落盘：{chainKey, nextIndex, lastRecvIndex} */
  persistRecvBoundary(deviceId: string, state: RecvBoundary): Promise<void>;
}

export interface SendBoundary {
  rootKey: string;
  sendChainKey: string;
  /** 下一帧的发送 index（预支后 = 批首 + 批大小） */
  nextIndex: number;
  epoch: number;
  /** 落盘时链所处的 index（批首）；restore 需把链推进 (nextIndex - baseIndex) 次 */
  baseIndex?: number;
}

export interface RecvBoundary {
  recvChainKey: string;
  nextIndex: number;
  lastRecvIndex: number;
  epoch: number;
}

export interface RatchetInit {
  /** 本端发送链起始（配对/rekey 时从 DH 共享派生） */
  rootKey: string;
  sendChainKey: string;
  recvChainKey: string;
  epoch: number;
}

interface SkippedKey {
  epoch: number;
  direction: 0 | 1;
  index: number;
  key: string;
}

export type SealOutcome =
  | { ok: true; nonce: Uint8Array; aad: Uint8Array; keyUsed: string; index: number; epoch: number; boundaryPersisted: boolean }
  | { ok: false; reason: "persist-failed" };

export type OpenOutcome =
  | { ok: true; plaintext: Uint8Array; index: number; epoch: number; duplicate: boolean }
  | { ok: false; reason: "tag-failed" | "regression" | "skipped-overflow" };

export interface RatchetDeps {
  now(): number;
  persist: RatchetPersist;
  deviceId: string;
  /** 本端方向：0=配对发起侧（gateway 视角恒 0；设备恒 1） */
  direction: 0 | 1;
}

/** KDF 链推进：chainKey_i+1 = HKDF(chainKey_i, zero, "message-key")；messageKey = HKDF(chainKey_i, zero, ...) 分离域 */
function advanceChain(chainKeyHex: string): { messageKey: string; nextChain: string } {
  const ck = new Uint8Array(Buffer.from(chainKeyHex, "hex"));
  const messageKey = toHexStr(hkdf({ ikm: ck, salt: ZERO32, info: HKDF_INFO.messageKey, length: 32 }));
  const nextChain = toHexStr(hkdf({ ikm: ck, salt: new Uint8Array(64), info: HKDF_INFO.ratchetRoot, length: 32 }));
  return { messageKey, nextChain: nextChain };
}

const ZERO32 = new Uint8Array(32);

function toHexStr(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export class RatchetSession {
  private sendChainKey: string;
  private recvChainKey: string;
  private rootKey: string;
  private sendNextIndex = 0;
  private recvNextIndex = 0;
  private lastRecvIndex = -1;
  private epoch: number;
  private batchPersistedThrough = -1;
  private skipped: SkippedKey[] = [];
  private tagFailures = 0;
  private messagesSinceDh = 0;

  constructor(
    private readonly deps: RatchetDeps,
    init: RatchetInit,
  ) {
    this.rootKey = init.rootKey;
    this.sendChainKey = init.sendChainKey;
    this.recvChainKey = init.recvChainKey;
    this.epoch = init.epoch;
  }

  snapshotSend(): SendBoundary {
    return { rootKey: this.rootKey, sendChainKey: this.sendChainKey, nextIndex: this.sendNextIndex, epoch: this.epoch };
  }

  snapshotRecv(): RecvBoundary {
    return { recvChainKey: this.recvChainKey, nextIndex: this.recvNextIndex, lastRecvIndex: this.lastRecvIndex, epoch: this.epoch };
  }

  chainFingerprint(): string {
    return `${this.epoch}:${this.sendChainKey.slice(0, 16)}:${this.recvChainKey.slice(0, 16)}`;
  }

  /** 恢复（崩溃后）：从持久化边界重建——落盘语义是「批首」（链与 index 同位，续发不重叠不回退） */
  static restore(deps: RatchetDeps, send: SendBoundary, recv: RecvBoundary): RatchetSession {
    const s = new RatchetSession(deps, {
      rootKey: send.rootKey,
      sendChainKey: send.sendChainKey,
      recvChainKey: recv.recvChainKey,
      epoch: send.epoch,
    });
    s.sendNextIndex = send.nextIndex;
    s.batchPersistedThrough = send.nextIndex;
    // 链对位：落盘链在 baseIndex，推进 (nextIndex - baseIndex) 次到续发位置
    const base = send.baseIndex ?? send.nextIndex;
    for (let i = base; i < send.nextIndex; i++) {
      s.sendChainKey = advanceChain(s.sendChainKey).nextChain;
    }
    s.recvNextIndex = recv.nextIndex;
    s.lastRecvIndex = recv.lastRecvIndex;
    s.recvChainKey = recv.recvChainKey;
    if (recv.epoch !== send.epoch) {
      // 持久化组撕裂（同组原子写被破坏）——fail-closed
      throw new Error("ratchet: persisted epoch mismatch");
    }
    return s;
  }

  /**
   * 加密一帧。批边界先行落盘：批首帧触发 persistSendBoundary（预支 64 index），
   * 落盘成功才放行。密钥按 index 确定性重派生——重发场景用 reEncryptAt。
   */
  async seal(spec: { plaintext: Uint8Array; aadFrom: string; aadTo: string }): Promise<SealOutcome> {
    // 批首落盘：{chainKey=批首链, baseIndex=批首, nextIndex=批首+64（预支）}。
    // 崩溃恢复从 nextIndex 续发（≤64 index 浪费）并按 baseIndex 差值推进链——nonce 与链
    // 双不复用/错位（A1 处置：杜绝 GCM nonce 复用）。
    if (this.sendNextIndex >= this.batchPersistedThrough) {
      const boundary = this.snapshotSend();
      boundary.baseIndex = this.sendNextIndex;
      boundary.nextIndex = this.sendNextIndex + RATCHET_BATCH_FRAMES;
      try {
        await this.deps.persist.persistSendBoundary(this.deps.deviceId, boundary);
      } catch {
        return { ok: false, reason: "persist-failed" };
      }
      this.batchPersistedThrough = boundary.nextIndex;
      return this.sealWithinBatch({ aadFrom: spec.aadFrom, aadTo: spec.aadTo, boundaryPersisted: true });
    }
    return this.sealWithinBatch({ aadFrom: spec.aadFrom, aadTo: spec.aadTo, boundaryPersisted: false });
  }

  private sealWithinBatch(spec: { aadFrom: string; aadTo: string; boundaryPersisted: boolean }): SealOutcome {
    const { aadFrom, aadTo, boundaryPersisted } = spec;
    const index = this.sendNextIndex;
    // 批内密钥链按 index 逐帧推进（确定性：从批首 chainKey 推 index 次）
    const { messageKey, nextChain } = advanceChain(this.sendChainKey);
    this.sendChainKey = nextChain;
    this.sendNextIndex = index + 1;
    this.messagesSinceDh++;
    const nonce = buildNonce(this.epoch, this.deps.direction, index);
    const aad = buildAad(aadFrom, aadTo, this.epoch);
    return { ok: true, nonce, aad, keyUsed: messageKey, index, epoch: this.epoch, boundaryPersisted };
  }

  /** 密文构造（调用于 seal 之后，用返回的 key/nonce 组装） */
  static sealBytes(spec: { keyHex: string; nonce: Uint8Array; plaintext: Uint8Array; aad: Uint8Array }): Uint8Array {
    return aeadSeal({ key: new Uint8Array(Buffer.from(spec.keyHex, "hex")), nonce: spec.nonce, plaintext: spec.plaintext, aad: spec.aad });
  }

  /**
   * 解密一帧。乱序（index > recvNextIndex）先跳过的链钥派生入 skipped 缓存；
   * index < lastRecvIndex 且不在 skipped → regression（index 回退硬失败）。
   */
  async open(spec: { ciphertext: Uint8Array; nonce: Uint8Array; aad: Uint8Array; index: number; epoch: number }): Promise<OpenOutcome> {
    const { ciphertext, nonce, aad, index, epoch } = spec;
    if (epoch !== this.epoch) {
      // 跨代密文（旧 epoch 注入）——本会话不再解；交上层决定（rekey 已发生则丢弃）
      return { ok: false, reason: "tag-failed" };
    }
    // 已收过（重复帧）——dup 快路径
    if (index <= this.lastRecvIndex && !this.skipped.some((k) => k.index === index && k.epoch === epoch)) {
      return { ok: false, reason: "regression" };
    }
    const skippedHit = this.skipped.find((k) => k.index === index && k.epoch === epoch);
    if (skippedHit) {
      const pt = aeadOpen({ key: new Uint8Array(Buffer.from(skippedHit.key, "hex")), nonce, ciphertext, aad });
      if (!pt) return { ok: false, reason: "tag-failed" };
      this.skipped = this.skipped.filter((k) => k !== skippedHit);
      return { ok: true, plaintext: pt, index, epoch, duplicate: false };
    }
    if (index === this.recvNextIndex) {
      return this.openInOrder(spec);
    }
    // 乱序：预派生 [recvNextIndex, index) 的链钥入 skipped
    const gap = index - this.recvNextIndex;
    if (gap > RATCHET_SKIPPED_KEY_MAX) {
      return { ok: false, reason: "skipped-overflow" };
    }
    let chain = this.recvChainKey;
    const derived: SkippedKey[] = [];
    for (let i = this.recvNextIndex; i < index; i++) {
      const { messageKey, nextChain } = advanceChain(chain);
      derived.push({ epoch, direction: this.deps.direction === 0 ? 1 : 0, index: i, key: messageKey });
      chain = nextChain;
    }
    const { messageKey: hitKey, nextChain: hitChain } = advanceChain(chain);
    const pt = aeadOpen({ key: new Uint8Array(Buffer.from(hitKey, "hex")), nonce, ciphertext, aad });
    if (!pt) {
      this.tagFailures++;
      return { ok: false, reason: "tag-failed" };
    }
    this.skipped.push(...derived);
    this.recvChainKey = hitChain;
    this.lastRecvIndex = index;
    this.recvNextIndex = index + 1;
    if (derived.length > 0) {
      await this.deps.persist.persistRecvBoundary(this.deps.deviceId, this.snapshotRecv());
    }
    return { ok: true, plaintext: pt, index, epoch, duplicate: false };
  }

  private async openInOrder(spec: { ciphertext: Uint8Array; nonce: Uint8Array; aad: Uint8Array; index: number; epoch: number }): Promise<OpenOutcome> {
    const { ciphertext, nonce, aad, index, epoch } = spec;
    const { messageKey, nextChain } = advanceChain(this.recvChainKey);
    const pt = aeadOpen({ key: new Uint8Array(Buffer.from(messageKey, "hex")), nonce, ciphertext, aad });
    if (!pt) {
      this.tagFailures++;
      return { ok: false, reason: "tag-failed" };
    }
    this.recvChainKey = nextChain;
    this.lastRecvIndex = index;
    this.recvNextIndex = index + 1;
    const boundaryDue = this.recvNextIndex % RATCHET_BATCH_FRAMES === 0;
    if (boundaryDue) {
      try {
        await this.deps.persist.persistRecvBoundary(this.deps.deviceId, this.snapshotRecv());
      } catch {
        // 接收边界落盘失败：保守拒收本帧（防重启后 index 回退）——fail-closed
        return { ok: false, reason: "tag-failed" };
      }
    }
    return { ok: true, plaintext: pt, index, epoch, duplicate: false };
  }

  /** tag 连续失败达到阈值 → 上层触发 rekey 探测（§1.3） */
  shouldProbeRekey(): boolean {
    return this.tagFailures >= TAG_FAILURE_REKEY_THRESHOLD;
  }

  resetTagFailures(): void {
    this.tagFailures = 0;
  }

  messagesSinceDhCount(): number {
    return this.messagesSinceDh;
  }

  /** rekey 后重建会话（外部握手完成，新链注入） */
  rekeyTo(init: RatchetInit): void {
    this.rootKey = init.rootKey;
    this.sendChainKey = init.sendChainKey;
    this.recvChainKey = init.recvChainKey;
    this.epoch = init.epoch;
    this.sendNextIndex = 0;
    this.recvNextIndex = 0;
    this.lastRecvIndex = -1;
    this.batchPersistedThrough = -1;
    this.skipped = [];
    this.tagFailures = 0;
    this.messagesSinceDh = 0;
  }

  /** DH 推进（对称棘轮之外的安全棘轮）：新共享秘密混合根钥重铸双链（双端对称：initiator 侧 send 链 = 对端 recv 链） */
  applyDhStep(sharedSecret: Uint8Array, initiator: boolean): void {
    const mixed = new Uint8Array(Buffer.concat([Buffer.from(this.rootKey, "hex"), Buffer.from(sharedSecret)]));
    this.rootKey = toHexStr(hkdf({ ikm: mixed, salt: ZERO32, info: HKDF_INFO.rekeyRoot, length: 32 }));
    const chains = deriveChainPair(new Uint8Array(Buffer.from(this.rootKey, "hex")), initiator);
    this.sendChainKey = chains.send;
    this.recvChainKey = chains.recv;
    this.epoch++;
    this.sendNextIndex = 0;
    this.recvNextIndex = 0;
    this.lastRecvIndex = -1;
    this.batchPersistedThrough = -1;
    this.skipped = [];
    this.messagesSinceDh = 0;
  }
}

/** 根钥 → 双链（发起侧/应答侧镜像分配；线格式钉死） */
function deriveChainPair(rootKey: Uint8Array, initiator: boolean): { send: string; recv: string } {
  const sendInfo = initiator ? new Uint8Array(49) : new Uint8Array(50);
  const recvInfo = initiator ? new Uint8Array(50) : new Uint8Array(49);
  sendInfo.fill(initiator ? 0x49 : 0x52);
  recvInfo.fill(initiator ? 0x52 : 0x49);
  return {
    send: toHexStr(hkdf({ ikm: rootKey, salt: sendInfo, info: HKDF_INFO.messageKey, length: 32 })),
    recv: toHexStr(hkdf({ ikm: rootKey, salt: recvInfo, info: HKDF_INFO.messageKey, length: 32 })),
  };
}

/** 从配对 DH 共享秘密派生初始链（两端对称：发起侧 dir=0 收发链互换） */
export function deriveInitialChains(sharedSecret: Uint8Array, initiator: boolean): RatchetInit {
  const root = toHexStr(hkdf({ ikm: sharedSecret, salt: ZERO32, info: HKDF_INFO.ratchetRoot, length: 32 }));
  const chains = deriveChainPair(new Uint8Array(Buffer.from(root, "hex")), initiator);
  return { rootKey: root, sendChainKey: chains.send, recvChainKey: chains.recv, epoch: 1 };
}

/** rekey 握手共享 → 新链（混旧根钥，§1.3） */
export function deriveRekeyChains(sharedSecret: Uint8Array, oldRootKey: string, initiator: boolean): RatchetInit {
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(oldRootKey, "hex"), Buffer.from(sharedSecret)]));
  const root = toHexStr(hkdf({ ikm: mixed, salt: ZERO32, info: HKDF_INFO.rekeyRoot, length: 32 }));
  return deriveInitialChains(new Uint8Array(Buffer.from(root, "hex")), initiator);
}
