// gw/* 命令族分派（DESIGN §3.2）——main.ts 拆分件（一动词一文件）；依赖经 GwDispatchDeps 注入。
import type { GatewayIdentity } from "./identity.ts";
import type { GatewayConfig } from "./config.ts";
import type { AuditLog } from "./audit.ts";
import type { DeviceRegistry } from "./device-registry.ts";
import type { ThreadsRegistry } from "./threads-registry.ts";
import type { HostAttach } from "./host-attach.ts";
import type { CryptoSessionPool } from "./session-crypto.ts";
import type { Fanout } from "./fanout.ts";
import type { RelayLinkHandle } from "./relay-link.ts";

export type GwResult = { ok: true; data: unknown } | { ok: false; reason: string };

export interface GwDispatchDeps {
  identity: GatewayIdentity;
  config: GatewayConfig;
  audit: AuditLog;
  devices: DeviceRegistry;
  threads: ThreadsRegistry;
  host: HostAttach;
  pairingServer: PairingServerLike;
  relayLink(): RelayLinkHandle | null;
  cryptoSessions: CryptoSessionPool;
  fanout: Fanout;
  deviceBuckets: Map<string, unknown>;
  deviceIngestChains: Map<string, Promise<void>>;
  devicePending: Map<string, unknown>;
  stopGateway(): void;
  logBuffer: { tail(): string[] };
}

export interface PairingServerLike {
  startQr(scope: "read" | "interact" | "full"): Promise<{ pairingId: string; qrPayload: string; ticket: string }>;
  startManual(scope: "read" | "interact" | "full"): Promise<{ pairingId: string; manualCode: string; ticket: string }>;
  cancel(pairingId: string): void;
}

export function makeGwDispatcher(deps: GwDispatchDeps): (command: string, args: Record<string, unknown>) => Promise<GwResult> {
  async function handleGwCommand(command: string, args: Record<string, unknown>): Promise<GwResult> {
    if (command === "gw/status") {
      return { ok: true, data: { installationId: deps.identity.installationId, remoteEnabled: deps.config.remoteEnabled, devices: deps.devices.list().length, threads: deps.threads.all().length, hostAlive: deps.host.alive() } };
    }
    if (command === "gw/devices/list") return { ok: true, data: deps.devices.list() };
    if (command === "gw/devices/rename" || command === "gw/devices/set_scope" || command === "gw/devices/revoke") {
      return handleGwDeviceCommand(command, args);
    }
    if (command === "gw/config/get") return { ok: true, data: deps.config };
    if (command === "gw/config/set") {
      // 热应用面：仅 remoteEnabled（其余键重启生效——如实返回）
      if (typeof args.remoteEnabled === "boolean") {
        deps.config.remoteEnabled = args.remoteEnabled;
        await deps.audit.record("config-changed", { remoteEnabled: args.remoteEnabled });
        return { ok: true, data: { ...deps.config, restartRequired: ["relayUrl", "relayKeyFingerprint", "hostBin"] } };
      }
      return { ok: false, reason: "restart required for this key" };
    }
    if (command === "gw/logs/tail") return { ok: true, data: { lines: deps.logBuffer.tail() } };
    if (command === "gw/shutdown") {
      setTimeout(() => {
        deps.stopGateway();
      }, 100);
      return { ok: true, data: { stopping: true } };
    }
    if (command === "gw/pairing/start" || command === "gw/pairing/cancel") {
      return handleGwPairing(command, args);
    }
    return { ok: false, reason: "unknown gw command" };
  }

  async function handleGwPairing(command: string, args: Record<string, unknown>): Promise<GwResult> {
    if (command === "gw/pairing/cancel") {
      const pairingId = args.pairingId;
      if (typeof pairingId !== "string") return { ok: false, reason: "pairingId required" };
      deps.pairingServer.cancel(pairingId);
      return { ok: true, data: { cancelled: true } };
    }
    const scope = args.scope === "interact" || args.scope === "full" ? args.scope : "read";
    const mode = args.mode === "manual" ? "manual" : "qr";
    const started = mode === "manual" ? await deps.pairingServer.startManual(scope) : await deps.pairingServer.startQr(scope);
    return { ok: true, data: { pairingId: started.pairingId, qrPayload: "qrPayload" in started ? started.qrPayload : undefined, manualCode: "manualCode" in started ? started.manualCode : undefined, ticket: started.ticket } };
  }

  async function handleGwDeviceCommand(command: string, args: Record<string, unknown>): Promise<GwResult> {
    const deviceId = args.deviceId;
    if (typeof deviceId !== "string") return { ok: false, reason: "deviceId required" };
    const entry = deps.devices.get(deviceId);
    if (entry === null) return { ok: false, reason: "no such device" };
    if (command === "gw/devices/rename") {
      if (typeof args.name === "string") entry.name = args.name;
      deps.devices.put(entry);
      return { ok: true, data: entry };
    }
    if (command === "gw/devices/set_scope") {
      const scope = args.scope;
      if (scope !== "read" && scope !== "interact" && scope !== "full") return { ok: false, reason: "scope must be read|interact|full" };
      entry.scope = scope;
      deps.devices.put(entry);
      await deps.audit.record("device-scope-changed", { deviceId, scope });
      return { ok: true, data: entry };
    }
    const hit = deps.devices.remove(deviceId);
    await deps.audit.record("device-revoked", { deviceId });
    return hit ? { ok: true, data: { deviceId } } : { ok: false, reason: "no such device" };
  }

  return handleGwCommand;
}
