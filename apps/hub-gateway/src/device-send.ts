import { aeadSeal, chunkFrame, encodeEnvelope, decodeEnvelope, type Frame } from "@x-harness/remote-protocol";
import type { DeviceCryptoSession } from "./session-crypto.ts";
import type { RelayLinkHandle } from "./relay-link.ts";

const OUTBOUND_PAYLOAD_MAX = 12 * 1024 * 1024;
export const DEVICE_PENDING_MAX = 256;

export interface DeviceSendDeps {
  installationId: string;
  cryptoSessions: { get(deviceId: string): DeviceCryptoSession | null; restore(deviceId: string): Promise<DeviceCryptoSession | null> };
  relayLink(): RelayLinkHandle | null;
  deviceOffline: Set<string>;
  devicePending: Map<string, Frame[]>;
  log(message: string): void;
}

interface SealedSendSpec {
  deviceId: string;
  link: RelayLinkHandle;
  ratchet: DeviceCryptoSession["ratchet"];
  frame: Frame;
}

async function sendSealed(spec: SealedSendSpec, deps: DeviceSendDeps): Promise<void> {
  const { deviceId, link, ratchet, frame } = spec;
  const outcome = await ratchet.seal({ plaintext: new TextEncoder().encode(JSON.stringify(frame)), aadFrom: `gw_${deps.installationId}`, aadTo: `dev_${deviceId}` });
  if (!outcome.ok) return;
  const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
  const ct = aeadSeal({ key, nonce: outcome.nonce, plaintext: new TextEncoder().encode(JSON.stringify(frame)), aad: outcome.aad });
  const payload = Buffer.from(ct).toString("base64");
  if (payload.length > OUTBOUND_PAYLOAD_MAX) {
    deps.log(`outbound segment exceeds cap (${payload.length}B) — dropped`);
    return;
  }
  const env = encodeEnvelope({ v: 1, from: `gw_${deps.installationId}`, to: `dev_${deviceId}`, payload, nonce: Buffer.from(outcome.nonce).toString("base64") });
  link.send(env);
}

export async function sendToDeviceInner(deviceId: string, frame: Frame, deps: DeviceSendDeps): Promise<void> {
  const session = deps.cryptoSessions.get(deviceId) ?? (await deps.cryptoSessions.restore(deviceId));
  const link = deps.relayLink();
  if (session === null) return;
  if (link === null || !link.connected() || deps.deviceOffline.has(deviceId)) {
    const queue = deps.devicePending.get(deviceId) ?? [];
    queue.push(frame);
    if (queue.length > DEVICE_PENDING_MAX) queue.splice(0, queue.length - DEVICE_PENDING_MAX);
    deps.devicePending.set(deviceId, queue);
    return;
  }
  const segs = chunkFrame(frame);
  if (segs === null) {
    await sendSealed({ deviceId, link, ratchet: session.ratchet, frame }, deps);
    return;
  }
  for (const seg of segs) {
    const segFrame: Frame = { kind: "chunk", streamId: seg.streamId, seq: seg.seq, body: { segmentId: seg.segmentId, segmentCount: seg.segmentCount, totalBytes: 0, data: seg.data } };
    await sendSealed({ deviceId, link, ratchet: session.ratchet, frame: segFrame }, deps);
  }
}

export function markDeviceOfflineFromRelayLine(line: string, to: string | undefined, deps: { deviceOffline: Set<string>; devices: { get(id: string): unknown }; log(message: string): void }): void {
  if (to === undefined || !to.startsWith("dev_")) return;
  const env = decodeEnvelope(line);
  if (env === null) return;
  let code = "";
  try {
    const payload = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as { code?: string };
    code = payload.code ?? "";
  } catch {
    return;
  }
  if (code !== "no-route") return;
  const deviceId = to.slice(4);
  if (deps.devices.get(deviceId) === null) return;
  if (!deps.deviceOffline.has(deviceId)) {
    deps.deviceOffline.add(deviceId);
    deps.log(`device ${deviceId} unreachable (no-route) — holding outbound frames until next inbound`);
  }
}
