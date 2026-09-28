// 配对服务器（DESIGN §1.4）：配对会话（TTL 120s/单次/5 次锁定 5min）、QR 与手输码
// 两路径、双向 SAS 录入（owner 键入手机 SAS）、pairingTicket 申请（经 relay）。
import { computeSas, gatewayEstablishChannel, gatewayPakeRespond, generateManualCode, mixRatchetRoot, newDeviceEphemeral, newPairingId, signPairingTranscript, type GatewayLongTerm } from "@x-harness/remote-protocol";
import type { GatewayIdentity } from "./identity.ts";
import { PAIRING_LOCKOUT_MS, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, SAS_DIGITS } from "@x-harness/remote-protocol";
import type { AuditLog } from "./audit.ts";

export interface PairingSession {
  pairingId: string;
  mode: "qr" | "manual";
  gwEphemeral: { secret: string; pub: string };
  manualCode: string | null;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  failedAttempts: number;
  lockedUntil: number;
  /** 握手中间态 */
  channelKey: Uint8Array | null;
  transcriptKey: string | null;
  deviceEphPub: string | null;
  sas: string | null;
}

export interface PairingServerOptions {
  identity: GatewayIdentity;
  relayUrl: string;
  /** relay 签名钥指纹（QR 携带——E3：占位符会被手机钉存成假指纹） */
  relayKeyFingerprint: string;
  audit: AuditLog;
  now(): number;
  /** pairingTicket 申请（经 relay HTTP；测试注入 fake） */
  requestPairingTicket(pairingId: string): Promise<string>;
  /** 注册完成回调（登记设备 + 发 relay token——B3 由 relay-link 提供） */
  onRegistered(device: { deviceId: string; name: string; deviceType: string; platform: string; appVersion: string; longTermPub: string; scope: "read" | "interact" | "full" }): Promise<void>;
  maxConcurrent: number;
}

export interface PairingServer {
  startQr(scope: "read" | "interact" | "full"): Promise<{ pairingId: string; qrPayload: string; ticket: string }>;
  startManual(scope: "read" | "interact" | "full"): Promise<{ pairingId: string; manualCode: string; ticket: string }>;
  /** 手机 request（QR 路径） */
  handleDeviceRequest(spec: { pairingId: string; deviceEphemeralPub: string; deviceInfo: { name: string; deviceType: string; platform: string; appVersion: string } }): Promise<{ ok: true; sas: string; gatewaySignature: string } | { ok: false; reason: string }>;
  /** 手机 PAKE 发起（手输路径） */
  handlePakeInitiate(spec: { pairingId: string; messageA: string; deviceInfo: { name: string; deviceType: string; platform: string; appVersion: string } }): Promise<{ ok: true; messageB: string; confirm: string } | { ok: false; reason: string }>;
  /** owner 键入 SAS（双向录入）→ 注册设备 */
  confirmWithSas(spec: { pairingId: string; ownerTypedSas: string; deviceLongTermPub: string; deviceBoxPub?: string }): Promise<{ ok: true; deviceId: string; ratchetSeed: Uint8Array } | { ok: false; reason: string }>;
  cancel(pairingId: string): void;
  sessionOf(pairingId: string): PairingSession | null;
  /** 设备配对帧（relay pairing 面：QR request / PAKE 发起 / 设备长期钥呈递） */
  handlePairingFrame(spec: { pairingId: string; message: { p: string; [key: string]: unknown } }): Promise<{ ok: true; reply: { p: string; [key: string]: unknown } } | { ok: false; reason: string }>;
}

/** 帧载荷里的设备信息规整（缺省降级——垃圾输入不崩） */
function coerceDeviceInfo(raw: unknown): { name: string; deviceType: string; platform: string; appVersion: string } {
  if (typeof raw !== "object" || raw === null) {
    return { name: "device", deviceType: "phone", platform: "unknown", appVersion: "1" };
  }
  const rec = raw as Record<string, unknown>;
  const pick = (key: string, fallback: string): string => (typeof rec[key] === "string" ? (rec[key] as string) : fallback);
  return { name: pick("name", "device"), deviceType: pick("deviceType", "phone"), platform: pick("platform", "unknown"), appVersion: pick("appVersion", "1") };
}

export function createPairingServer(options: PairingServerOptions): PairingServer {
  const sessions = new Map<string, PairingSession>();

  const gwLongTerm: GatewayLongTerm = { signingSecret: options.identity.signingSecret, signingPub: options.identity.signingPub };

  function sweep(): void {
    const nowMs = options.now();
    // 过期即删（TTL 是唯一有效性判据——E2：未消费的过期会话不得滞留）
    for (const [id, session] of sessions) {
      if (session.expiresAt < nowMs) sessions.delete(id);
    }
  }

  async function openSession(mode: "qr" | "manual", scope: "read" | "interact" | "full"): Promise<{ session: PairingSession; ticket: string } | { ok: false; reason: string }> {
    sweep();
    const live = [...sessions.values()].filter((s) => s.expiresAt > options.now()).length;
    if (live >= options.maxConcurrent) return { ok: false, reason: "too many concurrent pairing sessions" };
    const nowMs = options.now();
    if (mode === "qr" && options.relayKeyFingerprint.length === 0) {
      return { ok: false, reason: "relayKeyFingerprint required for QR pairing" };
    }
    const pairingId = newPairingId();
    const gwEphemeral = newDeviceEphemeral();
    const session: PairingSession = {
      pairingId,
      mode,
      gwEphemeral,
      manualCode: mode === "manual" ? generateManualCode() : null,
      createdAt: nowMs,
      expiresAt: nowMs + PAIRING_TTL_MS,
      consumed: false,
      failedAttempts: 0,
      lockedUntil: 0,
      channelKey: null,
      transcriptKey: null,
      deviceEphPub: null,
      sas: null,
    };
    sessions.set(pairingId, session);
    void options.audit.record("pairing-created", { pairingId, mode, scope });
    const ticket = await options.requestPairingTicket(pairingId);
    if (ticket.length === 0) {
      sessions.delete(pairingId);
      return { ok: false, reason: "pairing ticket unavailable (relay enroll pending?)" };
    }
    return { session, ticket };
  }

  return {
    async startQr(scope) {
      const opened = await openSession("qr", scope);
      if ("ok" in opened && opened.ok === false) throw new Error(opened.reason);
      const { session, ticket } = opened as { session: PairingSession; ticket: string };
      const qrPayload = JSON.stringify({
        v: 1,
        relayUrl: options.relayUrl,
        relayKeyFingerprint: options.relayKeyFingerprint,
        gatewayKeyFingerprint: options.identity.signingPub,
        pairingId: session.pairingId,
        gwEphemeralPub: session.gwEphemeral.pub,
        pairingTicket: ticket,
      });
      return { pairingId: session.pairingId, qrPayload, ticket };
    },
    async startManual(scope) {
      const opened = await openSession("manual", scope);
      if ("ok" in opened && opened.ok === false) throw new Error(opened.reason);
      const { session, ticket } = opened as { session: PairingSession; ticket: string };
      return { pairingId: session.pairingId, manualCode: session.manualCode!, ticket };
    },
    handleDeviceRequest(spec) {
      const session = sessions.get(spec.pairingId);
      if (session === undefined) return Promise.resolve({ ok: false as const, reason: "no such pairing" });
      const nowMs = options.now();
      if (nowMs > session.expiresAt) return Promise.resolve({ ok: false as const, reason: "pairing expired" });
      if (session.consumed) return Promise.resolve({ ok: false as const, reason: "pairing already used" });
      if (session.mode !== "qr") return Promise.resolve({ ok: false as const, reason: "qr pairing required" });
      const channel = gatewayEstablishChannel({
        gwLongTerm,
        pairingId: session.pairingId,
        gwEphemeralSecret: session.gwEphemeral.secret,
        gwEphemeralPub: session.gwEphemeral.pub,
        deviceEphemeralPub: spec.deviceEphemeralPub,
        relayUrl: options.relayUrl,
        scope: "read", // owner 通道发起配对缺省 read（§2.1#1 缓解）
      });
      if (channel === null) return Promise.resolve({ ok: false as const, reason: "channel establishment failed" });
      session.channelKey = channel.channelKey;
      session.deviceEphPub = spec.deviceEphemeralPub;
      const sas = computeSas({ channelKey: channel.channelKey, transcript: channel.transcript, gatewayFingerprint: options.identity.signingPub, deviceFingerprint: spec.deviceInfo.name });
      session.sas = sas;
      const signature = signPairingTranscript(gwLongTerm, channel.transcript);
      return Promise.resolve({ ok: true as const, sas, gatewaySignature: signature });
    },
    handlePakeInitiate(spec) {
      const session = sessions.get(spec.pairingId);
      if (session === undefined) return Promise.resolve({ ok: false as const, reason: "no such pairing" });
      const nowMs = options.now();
      if (nowMs > session.expiresAt) return Promise.resolve({ ok: false as const, reason: "pairing expired" });
      if (session.consumed) return Promise.resolve({ ok: false as const, reason: "pairing already used" });
      if (session.mode !== "manual" || session.manualCode === null) return Promise.resolve({ ok: false as const, reason: "manual pairing required" });
      if (nowMs < session.lockedUntil) return Promise.resolve({ ok: false as const, reason: "locked" });
      session.failedAttempts += 1;
      if (session.failedAttempts >= PAIRING_MAX_ATTEMPTS) {
        session.lockedUntil = nowMs + PAIRING_LOCKOUT_MS;
        void options.audit.record("pairing-failed", { pairingId: session.pairingId, reason: "pake-attempts" });
        return Promise.resolve({ ok: false as const, reason: "locked" });
      }
      const resp = gatewayPakeRespond(session.manualCode, spec.messageA, session.pairingId);
      session.channelKey = new Uint8Array(Buffer.from(resp.channel.shared, "hex"));
      session.deviceEphPub = spec.deviceInfo.name; // PAKE 路径无设备临时钥——用 name 占位（转录域）
      session.sas = computeSas({ channelKey: session.channelKey, transcript: { pairingId: session.pairingId, gwEph: session.gwEphemeral.pub, devEph: spec.messageA, relayUrl: options.relayUrl, scope: "read" }, gatewayFingerprint: options.identity.signingPub, deviceFingerprint: spec.deviceInfo.name });
      return Promise.resolve({ ok: true as const, messageB: resp.message, confirm: resp.channel.confirm });
    },
    confirmWithSas(spec) {
      const session = sessions.get(spec.pairingId);
      if (session === undefined) return Promise.resolve({ ok: false as const, reason: "no such pairing" });
      const nowMs = options.now();
      if (nowMs < session.lockedUntil) return Promise.resolve({ ok: false as const, reason: "locked" });
      if (nowMs > session.expiresAt) return Promise.resolve({ ok: false as const, reason: "pairing expired" });
      if (session.consumed) return Promise.resolve({ ok: false as const, reason: "pairing already used" });
      if (session.sas === null || session.channelKey === null) return Promise.resolve({ ok: false as const, reason: "pairing not established" });
      if (spec.ownerTypedSas !== session.sas) {
        session.failedAttempts += 1;
        if (session.failedAttempts >= PAIRING_MAX_ATTEMPTS) {
          session.lockedUntil = nowMs + PAIRING_LOCKOUT_MS;
          void options.audit.record("pairing-failed", { pairingId: session.pairingId, reason: "locked" });
        }
        return Promise.resolve({ ok: false as const, reason: "sas mismatch" });
      }
      session.consumed = true;
      const deviceId = `d_${session.pairingId.slice(3)}`;
      const ratchetSeed = mixRatchetRoot(session.channelKey, spec.deviceLongTermPub);
      void options.onRegistered({
        deviceId,
        name: session.deviceEphPub ?? "device",
        deviceType: "phone",
        platform: "unknown",
        appVersion: "1",
        longTermPub: spec.deviceLongTermPub,
        scope: "read",
      });
      void options.audit.record("pairing-confirmed", { pairingId: session.pairingId, deviceId });
      return Promise.resolve({ ok: true as const, deviceId, ratchetSeed });
    },
    cancel(pairingId) {
      const session = sessions.get(pairingId);
      if (session !== undefined) {
        session.consumed = true;
        sessions.delete(pairingId);
      }
    },
    sessionOf: (pairingId) => sessions.get(pairingId) ?? null,
    async handlePairingFrame(spec) {
      const session = sessions.get(spec.pairingId);
      if (session === undefined) return { ok: false, reason: "no such pairing" };
      const nowMs = options.now();
      if (nowMs > session.expiresAt || session.consumed) return { ok: false, reason: "pairing expired" };
      return pairingFrameInner(this, session, spec);
    },
  };
}


export { SAS_DIGITS };

/** 配对帧分派（p 消息判别）——handlePairingFrame 的实现体（复杂度拆分件） */
async function pairingFrameInner(
  server: PairingServer,
  session: PairingSession,
  spec: { pairingId: string; message: { p: string; [key: string]: unknown } },
): Promise<{ ok: true; reply: { p: string; [key: string]: unknown } } | { ok: false; reason: string }> {
      if (spec.message.p === "request") {
        const deviceEphemeralPub = typeof spec.message.ephemeralPub === "string" ? spec.message.ephemeralPub : "";
        if (deviceEphemeralPub.length === 0) return { ok: false, reason: "ephemeralPub required" };
        const deviceInfo = coerceDeviceInfo(spec.message.deviceInfo);
        const res = await server.handleDeviceRequest({ pairingId: spec.pairingId, deviceEphemeralPub, deviceInfo });
        if (!res.ok) return res;
        return { ok: true, reply: { p: "sas", sas: res.sas, gatewaySignature: res.gatewaySignature } };
      }
      if (spec.message.p === "pake-a") {
        const messageA = typeof spec.message.pakeA === "string" ? spec.message.pakeA : "";
        if (messageA.length === 0) return { ok: false, reason: "pakeA required" };
        const deviceInfo = coerceDeviceInfo(spec.message.deviceInfo);
        const res = await server.handlePakeInitiate({ pairingId: spec.pairingId, messageA, deviceInfo });
        if (!res.ok) return res;
        return { ok: true, reply: { p: "pake-b", pakeB: res.messageB, confirm: res.confirm } };
      }
      if (spec.message.p === "device-keys") {
        // 设备长期钥呈递（A6：SAS 确认后由 owner 发起 confirm——此帧暂存钥待 confirm 合并）
        const longTermPub = typeof spec.message.longTermPub === "string" ? spec.message.longTermPub : "";
        if (longTermPub.length === 0) return { ok: false, reason: "longTermPub required" };
        session.deviceEphPub = session.deviceEphPub ?? longTermPub;
        (session as PairingSession & { deviceLongTermPub?: string }).deviceLongTermPub = longTermPub;
        return { ok: true, reply: { p: "ack" } };
      }
      return { ok: false, reason: "unknown pairing message" };

}
