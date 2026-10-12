import { createPairingServer, type PairingServer } from "./pairing-server.ts";
import { PAIRING_MAX_CONCURRENT } from "@x-harness/remote-protocol";
import type { GatewayIdentity } from "./identity.ts";
import type { GatewayConfig } from "./config.ts";
import type { AuditLog } from "./audit.ts";
import type { DeviceRegistry } from "./device-registry.ts";
import type { RelayLinkHandle } from "./relay-link.ts";

export interface PairingAssemblyDeps {
  identity: GatewayIdentity;
  config: GatewayConfig;
  audit: AuditLog;
  devices: DeviceRegistry;
  now(): number;
  relayLink(): RelayLinkHandle | null;
  cryptoSessions: { establish(spec: { deviceId: string; sharedSecret: Uint8Array; initiator: boolean }): unknown };
  onSessionEstablished(deviceId: string, ratchetSeed: Uint8Array): void;
  /** 6 位码上报（外部 relay 形态的发现面——码注册进 relay 的 /api/discover 查询表）。 */
  onManualCodeRegistered?(pairingId: string, manualCode: string | null, expiresAt: number, ticket?: string): void;
}

export function assemblePairingServer(deps: PairingAssemblyDeps): PairingServer {
  const { identity, config, audit, devices, now, onSessionEstablished } = deps;
  return createPairingServer({
    identity,
    relayUrl: config.relayUrl,
    relayKeyFingerprint: config.relayKeyFingerprint,
    audit,
    now,
    requestPairingTicket: async (pairingId) => (await deps.relayLink()?.requestPairingTicket(pairingId)) ?? "",
    onManualCodeRegistered: deps.onManualCodeRegistered,
    requestDeviceToken: async (deviceId, deviceLongTermPub) => (await deps.relayLink()?.requestDeviceToken(deviceId, deviceLongTermPub)) ?? null,
    onRegistered: async (device) => {
      devices.put({
        deviceId: device.deviceId,
        name: device.name,
        deviceType: device.deviceType,
        platform: device.platform,
        appVersion: device.appVersion,
        longTermPub: device.longTermPub,
        scope: device.scope,
        pairedAt: now(),
        lastSeenAt: now(),
        rekeyCounter: 0,
      });
    },
    onSessionEstablished,
    maxConcurrent: PAIRING_MAX_CONCURRENT,
  });
}
