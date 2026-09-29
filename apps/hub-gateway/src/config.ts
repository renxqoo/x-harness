import { homedir } from "node:os";
import { join } from "node:path";

export interface GatewayConfig {
  relayUrl: string;
  relayKeyFingerprint: string;
  remoteEnabled: boolean;
  ownerSocketPath: string | null;
  hostBin: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  maxDevices: number;
}

export interface GatewayPaths {
  agentDir: string;
  installationIdFile: string;
  gatewayIdentityFile: string;
  devicesDir: string;
  registryFile: string;
  threadsFile: string;
  auditDir: string;
  configFile: string;
  ownerSocket: string;
  gatewayPidFile: string;
}

export function derivePaths(agentDir: string, config: GatewayConfig): GatewayPaths {
  return {
    agentDir,
    installationIdFile: join(agentDir, "installation-id"),
    gatewayIdentityFile: join(agentDir, "gateway-identity.json"),
    devicesDir: join(agentDir, "devices"),
    registryFile: join(agentDir, "devices", "registry.json"),
    threadsFile: join(agentDir, "threads.json"),
    auditDir: join(agentDir, "audit"),
    configFile: join(agentDir, "gateway.json"),
    ownerSocket: config.ownerSocketPath ?? join(agentDir, "gateway.sock"),
    gatewayPidFile: join(agentDir, "gateway.pid"),
  };
}

export function defaultAgentDir(): string {
  return process.env["HUB_AGENT_DIR"] ?? join(homedir(), ".x-harness", "hub");
}

export function loadConfig(rawJson: string | null): { ok: true; config: GatewayConfig } | { ok: false; reason: string } {
  if (rawJson === null) {
    return { ok: true, config: emptyConfig() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: "gateway.json unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "gateway.json must be an object" };
  const config = coerceConfig(parsed as Partial<GatewayConfig>);
  if (config.remoteEnabled) {
    const remoteReason = validateRemote(config);
    if (remoteReason !== null) return { ok: false, reason: remoteReason };
  }
  return { ok: true, config };
}

function coerceConfig(raw: Partial<GatewayConfig>): GatewayConfig {
  return {
    relayUrl: typeof raw.relayUrl === "string" ? raw.relayUrl : "",
    relayKeyFingerprint: typeof raw.relayKeyFingerprint === "string" ? raw.relayKeyFingerprint : "",
    remoteEnabled: raw.remoteEnabled === true,
    ownerSocketPath: typeof raw.ownerSocketPath === "string" ? raw.ownerSocketPath : null,
    hostBin: typeof raw.hostBin === "string" ? raw.hostBin : null,
    logLevel: raw.logLevel === "debug" || raw.logLevel === "warn" || raw.logLevel === "error" ? raw.logLevel : "info",
    maxDevices: typeof raw.maxDevices === "number" && raw.maxDevices > 0 ? Math.floor(raw.maxDevices) : 16,
  };
}

function validateRemote(config: GatewayConfig): string | null {
  if (config.relayUrl.length === 0) return "relayUrl required when remoteEnabled";
  if (config.relayUrl.startsWith("wss://")) {
    if (config.relayKeyFingerprint.length === 0) return "relayKeyFingerprint required when remoteEnabled";
    return null;
  }
  if (config.relayUrl.startsWith("ws://")) {
    let host = "";
    try {
      host = new URL(config.relayUrl.replace(/^ws/, "http")).hostname;
    } catch {
      return "relayUrl unparseable";
    }
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return "ws:// only allowed for loopback (production must be wss://)";
    return null;
  }
  return "relayUrl must be wss:// (or ws:// loopback for local dev)";
}

function emptyConfig(): GatewayConfig {
  return {
    relayUrl: "",
    relayKeyFingerprint: "",
    remoteEnabled: false,
    ownerSocketPath: null,
    hostBin: null,
    logLevel: "info",
    maxDevices: 16,
  };
}
