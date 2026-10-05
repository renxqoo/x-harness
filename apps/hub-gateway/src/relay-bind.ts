import { networkInterfaces } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { startRelay } from "../../hub-relay/src/main.ts";
import type { GatewayConfig } from "./config.ts";

export const EMBEDDED_RELAY_PORT = 8787;

export interface EmbeddedRelay {
  mode: "embedded";
  relayUrl: string;
  relayKeyFingerprint: string;
  port: number;
  stop(): Promise<void>;
}

export interface ExternalRelay {
  mode: "external";
  relayUrl: string;
  relayKeyFingerprint: string;
  port: null;
  stop(): Promise<void>;
}

export type RelayBinding = EmbeddedRelay | ExternalRelay;

export interface GatewayDescriptor {
  relayUrl: string;
  installationId: string;
  gatewayKeyFingerprint: string;
  pairingId: string;
  pairingTicket: string;
}

export function embeddedRelayNeeded(config: GatewayConfig): boolean {
  return config.remoteEnabled && config.relayUrl.length === 0;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      out.push(net.address);
    }
  }
  return out;
}

export async function bindRelay(config: GatewayConfig, options: {
  singleInstance: boolean;
  log(message: string): void;
  gatewayOfCode?(code: string): GatewayDescriptor | null | Promise<GatewayDescriptor | null>;
}): Promise<RelayBinding> {
  if (!embeddedRelayNeeded(config)) {
    return {
      mode: "external",
      relayUrl: config.relayUrl,
      relayKeyFingerprint: config.relayKeyFingerprint,
      port: null,
      stop: () => Promise.resolve(),
    };
  }
  const tokenSecret = randomBytes(32).toString("hex");
  const relayArgs = {
    host: "0.0.0.0",
    tokenSecret,
    singleInstance: options.singleInstance,
    ...(options.gatewayOfCode !== undefined ? { gatewayOfCode: options.gatewayOfCode } : {}),
  };
  let relay: Awaited<ReturnType<typeof startRelay>>;
  try {
    relay = await startRelay({ ...relayArgs, port: EMBEDDED_RELAY_PORT });
  } catch {
    relay = await startRelay({ ...relayArgs, port: 0 });
  }
  const port = (relay.server.address() as { port: number }).port;
  const fingerprint = createHash("sha256").update(Buffer.from(relay.nodeSigningPub, "hex")).digest("hex");
  const lan = lanAddresses();
  const host = lan[0] ?? "127.0.0.1";
  options.log(`embedded relay listening on ws://${host}:${port} (lan candidates: ${lan.join(", ") || "loopback only"})`);
  return {
    mode: "embedded",
    relayUrl: `ws://${host}:${port}`,
    relayKeyFingerprint: fingerprint,
    port,
    stop: () => relay.close(),
  };
}
