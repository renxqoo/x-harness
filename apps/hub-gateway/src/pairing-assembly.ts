// 配对服务装配（main.ts 拆分件）：relay ticket/token 面与设备注册落账的依赖注入。
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
}

export function assemblePairingServer(deps: PairingAssemblyDeps): PairingServer {
  const { identity, config, audit, devices, now } = deps;
  return createPairingServer({
    identity,
    relayUrl: config.relayUrl,
    relayKeyFingerprint: config.relayKeyFingerprint,
    audit,
    now,
    requestPairingTicket: async (pairingId) => (await deps.relayLink()?.requestPairingTicket(pairingId)) ?? "",
    requestDeviceToken: async (deviceId) => (await deps.relayLink()?.requestDeviceToken(deviceId)) ?? null,
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
    maxConcurrent: PAIRING_MAX_CONCURRENT,
  });
}
