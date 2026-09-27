// per-device 双 ratchet 会话（DESIGN §1.3）：RatchetPersist 的原子写实现 +
// 会话池（deviceId → RatchetSession）+ 强制 rekey 调度。持久化组（ratchet 状态与
// 防重放水位同组）在 B4 inbound 接入时扩为同组批量写。
import { mkdir, readFile } from "node:fs/promises";
import { atomicWrite } from "./identity.ts";
import {
  RatchetSession,
  deriveInitialChains,
  type RecvBoundary,
  type RatchetInit,
  type SendBoundary,
} from "@x-harness/remote-protocol";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateBoxKeyPair, x25519 } from "@x-harness/remote-protocol";

export interface DeviceCryptoSession {
  ratchet: RatchetSession;
  /** 会话建立时间（强制 rekey 24h 窗） */
  establishedAt: number;
}

interface PersistedState {
  send: SendBoundary;
  recv: RecvBoundary;
  establishedAt: number;
}

export interface CryptoSessionPool {
  establish(spec: { deviceId: string; sharedSecret: Uint8Array; initiator: boolean }): DeviceCryptoSession;
  get(deviceId: string): DeviceCryptoSession | null;
  restore(deviceId: string): Promise<DeviceCryptoSession | null>;
  drop(deviceId: string): void;
}

export function createCryptoSessionPool(devicesDir: string, now: () => number): CryptoSessionPool {
  const pool = new Map<string, DeviceCryptoSession>();

  const statePath = (deviceId: string): string => join(devicesDir, deviceId, "ratchet-state.json");

  async function persistGroup(deviceId: string, session: DeviceCryptoSession): Promise<void> {
    const state: PersistedState = { send: session.ratchet.snapshotSend(), recv: session.ratchet.snapshotRecv(), establishedAt: session.establishedAt };
    await mkdir(join(devicesDir, deviceId), { recursive: true });
    await atomicWrite(statePath(deviceId), JSON.stringify(state, null, 2));
  }

  return {
    establish({ deviceId, sharedSecret, initiator }) {
      const init: RatchetInit = deriveInitialChains(sharedSecret, initiator);
      // 读-改-写合流（send/recv 边界共用；磁盘状态是单一真相）
      const mergePersist = async (id: string, patch: { send?: SendBoundary; recv?: RecvBoundary }): Promise<void> => {
        const current = pool.get(id) ?? session;
        let persisted: PersistedState;
        try {
          persisted = JSON.parse(await readFile(statePath(id), "utf8")) as PersistedState;
        } catch {
          persisted = { send: current.ratchet.snapshotSend(), recv: current.ratchet.snapshotRecv(), establishedAt: current.establishedAt };
        }
        if (patch.send !== undefined) persisted.send = patch.send;
        if (patch.recv !== undefined) persisted.recv = patch.recv;
        persisted.establishedAt = current.establishedAt;
        await atomicWrite(statePath(id), JSON.stringify(persisted, null, 2));
      };
      const session: DeviceCryptoSession = {
        ratchet: new RatchetSession(
          {
            now,
            deviceId,
            direction: 0,
            persist: {
              persistSendBoundary: (id, send) => mergePersist(id, { send }),
              persistRecvBoundary: (id, recv) => mergePersist(id, { recv }),
            },
          },
          init,
        ),
        establishedAt: now(),
      };
      pool.set(deviceId, session);
      void persistGroup(deviceId, session);
      return session;
    },
    get: (deviceId) => pool.get(deviceId) ?? null,
    async restore(deviceId) {
      const existing = pool.get(deviceId);
      if (existing !== undefined) return existing;
      try {
        const state = JSON.parse(await readFile(statePath(deviceId), "utf8")) as PersistedState;
        const session: DeviceCryptoSession = {
          ratchet: RatchetSession.restore(
            { now, deviceId, direction: 0, persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} } },
            state.send,
            state.recv,
          ),
          establishedAt: state.establishedAt,
        };
        pool.set(deviceId, session);
        return session;
      } catch {
        return null;
      }
    },
    drop(deviceId) {
      pool.delete(deviceId);
    },
  };
}

/** 配对通道共享 → ratchet 种子（QR 路径：临时 DH；PAKE 路径：共享再混设备长期钥） */
export function seedFromPairing(spec: { channelShared: Uint8Array; deviceLongTermPub: string; gatewayEphemeralSecret: string; deviceEphemeralPub: string }): Uint8Array | null {
  const { channelShared, deviceLongTermPub } = spec;
  const dh = x25519(spec.gatewayEphemeralSecret, spec.deviceEphemeralPub);
  if (dh === null) return null;
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(channelShared), Buffer.from(deviceLongTermPub, "utf8"), Buffer.from(dh)]));
  // 混合根：SHA-256 一次（channelShared 已是 HKDF 产物；二次 HKDF 在 deriveInitialChains）
  return new Uint8Array(createHash("sha256").update(mixed).digest());
}

export { generateBoxKeyPair };
