import { aeadOpen, aeadSeal, buildAad, buildNonce, hkdf, HKDF_INFO } from "./crypto.ts";
import { RATCHET_BATCH_FRAMES, RATCHET_SKIPPED_KEY_MAX, TAG_FAILURE_REKEY_THRESHOLD } from "./limits.ts";

export interface RatchetPersist {
  persistSendBoundary(deviceId: string, state: SendBoundary): Promise<void>;
  persistRecvBoundary(deviceId: string, state: RecvBoundary): Promise<void>;
}

export interface SendBoundary {
  rootKey: string;
  sendChainKey: string;
  nextIndex: number;
  epoch: number;
  baseIndex?: number;
}

export interface RecvBoundary {
  recvChainKey: string;
  nextIndex: number;
  lastRecvIndex: number;
  epoch: number;
}

export interface RatchetInit {
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
  direction: 0 | 1;
}

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

  static restore(deps: RatchetDeps, send: SendBoundary, recv: RecvBoundary): RatchetSession {
    const s = new RatchetSession(deps, {
      rootKey: send.rootKey,
      sendChainKey: send.sendChainKey,
      recvChainKey: recv.recvChainKey,
      epoch: send.epoch,
    });
    s.sendNextIndex = send.nextIndex;
    s.batchPersistedThrough = send.nextIndex;
    const base = send.baseIndex ?? send.nextIndex;
    for (let i = base; i < send.nextIndex; i++) {
      s.sendChainKey = advanceChain(s.sendChainKey).nextChain;
    }
    s.recvNextIndex = recv.nextIndex;
    s.lastRecvIndex = recv.lastRecvIndex;
    s.recvChainKey = recv.recvChainKey;
    if (recv.epoch !== send.epoch) {
      throw new Error("ratchet: persisted epoch mismatch");
    }
    return s;
  }

  async seal(spec: { plaintext: Uint8Array; aadFrom: string; aadTo: string }): Promise<SealOutcome> {
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
    const { messageKey, nextChain } = advanceChain(this.sendChainKey);
    this.sendChainKey = nextChain;
    this.sendNextIndex = index + 1;
    this.messagesSinceDh++;
    const nonce = buildNonce(this.epoch, this.deps.direction, index);
    const aad = buildAad(aadFrom, aadTo, this.epoch);
    return { ok: true, nonce, aad, keyUsed: messageKey, index, epoch: this.epoch, boundaryPersisted };
  }

  static sealBytes(spec: { keyHex: string; nonce: Uint8Array; plaintext: Uint8Array; aad: Uint8Array }): Uint8Array {
    return aeadSeal({ key: new Uint8Array(Buffer.from(spec.keyHex, "hex")), nonce: spec.nonce, plaintext: spec.plaintext, aad: spec.aad });
  }

  async open(spec: { ciphertext: Uint8Array; nonce: Uint8Array; aad: Uint8Array; index: number; epoch: number }): Promise<OpenOutcome> {
    const { ciphertext, nonce, aad, index, epoch } = spec;
    if (epoch !== this.epoch) {
      return { ok: false, reason: "tag-failed" };
    }
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
        return { ok: false, reason: "tag-failed" };
      }
    }
    return { ok: true, plaintext: pt, index, epoch, duplicate: false };
  }

  shouldProbeRekey(): boolean {
    return this.tagFailures >= TAG_FAILURE_REKEY_THRESHOLD;
  }

  resetTagFailures(): void {
    this.tagFailures = 0;
  }

  messagesSinceDhCount(): number {
    return this.messagesSinceDh;
  }

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

export function deriveInitialChains(sharedSecret: Uint8Array, initiator: boolean): RatchetInit {
  const root = toHexStr(hkdf({ ikm: sharedSecret, salt: ZERO32, info: HKDF_INFO.ratchetRoot, length: 32 }));
  const chains = deriveChainPair(new Uint8Array(Buffer.from(root, "hex")), initiator);
  return { rootKey: root, sendChainKey: chains.send, recvChainKey: chains.recv, epoch: 1 };
}

export function deriveRekeyChains(sharedSecret: Uint8Array, oldRootKey: string, initiator: boolean): RatchetInit {
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(oldRootKey, "hex"), Buffer.from(sharedSecret)]));
  const root = toHexStr(hkdf({ ikm: mixed, salt: ZERO32, info: HKDF_INFO.rekeyRoot, length: 32 }));
  return deriveInitialChains(new Uint8Array(Buffer.from(root, "hex")), initiator);
}
