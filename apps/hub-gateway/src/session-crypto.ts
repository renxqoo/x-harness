import { mkdir, readFile } from "node:fs/promises";
import { atomicWrite } from "./identity.ts";
import {
  RatchetSession,
  deriveInitialChains,
  type RatchetInit,
  type RecvBoundary,
  type RatchetPersist,
  type SendBoundary,
} from "@x-harness/remote-protocol";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { x25519 } from "@x-harness/remote-protocol";

export interface DeviceCryptoSession {
  ratchet: RatchetSession;
  establishedAt: number;
}

interface PersistedState {
  version: number;
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
  const writeTails = new Map<string, Promise<void>>();
  const versions = new Map<string, number>();

  function enqueuePersist(deviceId: string, patch: { send?: SendBoundary; recv?: RecvBoundary }): Promise<void> {
    const tail = (writeTails.get(deviceId) ?? Promise.resolve()).then(async () => {
      let persisted: PersistedState;
      try {
        persisted = JSON.parse(await readFile(statePath(deviceId), "utf8")) as PersistedState;
      } catch {
        const current = pool.get(deviceId);
        persisted = {
          version: 0,
          send: current ? current.ratchet.snapshotSend() : { rootKey: "", sendChainKey: "", nextIndex: 0, epoch: 1 },
          recv: current ? current.ratchet.snapshotRecv() : { recvChainKey: "", nextIndex: 0, lastRecvIndex: -1, epoch: 1 },
          establishedAt: current?.establishedAt ?? now(),
        };
      }
      persisted.version += 1;
      if (patch.send !== undefined) persisted.send = patch.send;
      if (patch.recv !== undefined) persisted.recv = patch.recv;
      const current = pool.get(deviceId);
      if (current !== undefined) persisted.establishedAt = current.establishedAt;
      await mkdir(join(devicesDir, deviceId), { recursive: true });
      await atomicWrite(statePath(deviceId), JSON.stringify(persisted, null, 2));
      versions.set(deviceId, persisted.version);
    });
    writeTails.set(deviceId, tail.catch(() => undefined));
    return tail;
  }

  function makePersist(): RatchetPersist {
    return {
      persistSendBoundary: (id, send) => enqueuePersist(id, { send }),
      persistRecvBoundary: (id, recv) => enqueuePersist(id, { recv }),
    };
  }

  return {
    establish({ deviceId, sharedSecret, initiator }) {
      const init: RatchetInit = deriveInitialChains(sharedSecret, initiator);
      const session: DeviceCryptoSession = {
        ratchet: new RatchetSession({ now, deviceId, direction: 0, persist: makePersist() }, init),
        establishedAt: now(),
      };
      pool.set(deviceId, session);
      void enqueuePersist(deviceId, {});
      return session;
    },
    get: (deviceId) => pool.get(deviceId) ?? null,
    async restore(deviceId) {
      const existing = pool.get(deviceId);
      if (existing !== undefined) return existing;
      try {
        const state = JSON.parse(await readFile(statePath(deviceId), "utf8")) as PersistedState;
        const session: DeviceCryptoSession = {
          ratchet: RatchetSession.restore({ now, deviceId, direction: 0, persist: makePersist() }, state.send, state.recv),
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
      writeTails.delete(deviceId);
      versions.delete(deviceId);
    },
  };
}

export function seedFromPairing(spec: { channelShared: Uint8Array; deviceLongTermPub: string; gatewayEphemeralSecret: string; deviceEphemeralPub: string }): Uint8Array | null {
  const dh = x25519(spec.gatewayEphemeralSecret, spec.deviceEphemeralPub);
  if (dh === null) return null;
  const mixed = new Uint8Array(Buffer.concat([Buffer.from(spec.channelShared), Buffer.from(spec.deviceLongTermPub, "utf8"), Buffer.from(dh)]));
  return new Uint8Array(createHash("sha256").update(mixed).digest());
}
