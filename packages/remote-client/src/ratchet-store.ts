// 客户端侧 ratchet codec：RemoteCodec 的双 ratchet 实现（配对产物种子）。
import {
  parseNonce,
  RatchetSession,
  aeadSeal,
  buildAad,
  deriveInitialChains,
  type Frame,
} from "@x-harness/remote-protocol";

export interface RatchetCodecDeps {
  deviceId: string;
  installationId: string;
  sharedSecret: Uint8Array;
}

export interface RatchetCodec {
  /** 返回 {payload, nonce}（L3 信封两字段） */
  seal(frameJson: string): Promise<{ payload: string; nonce: string } | null>;
  open(payloadBase64: string, nonceBase64: string): Promise<string | null>;
  ratchet: RatchetSession;
}

/** 客户端方向 codec：seal direction=1（设备→网关）；open 串行化（接收游标顺序推进） */
export function createRatchetCodec(deps: RatchetCodecDeps): RatchetCodec {
  const ratchet = new RatchetSession(
    {
      now: Date.now,
      deviceId: deps.deviceId,
      direction: 1,
      persist: { persistSendBoundary: async () => {}, persistRecvBoundary: async () => {} },
    },
    deriveInitialChains(deps.sharedSecret, false),
  );
  let recvIndex = 0;
  let openChain: Promise<void> = Promise.resolve();
  return {
    async seal(frameJson) {
      const outcome = await ratchet.seal({ plaintext: new TextEncoder().encode(frameJson), aadFrom: `dev_${deps.deviceId}`, aadTo: `gw_${deps.installationId}` });
      if (!outcome.ok) return null;
      const key = new Uint8Array(Buffer.from(outcome.keyUsed, "hex"));
      const ct = aeadSeal({ key, nonce: outcome.nonce, plaintext: new TextEncoder().encode(frameJson), aad: outcome.aad });
      return { payload: Buffer.from(ct).toString("base64"), nonce: Buffer.from(outcome.nonce).toString("base64") };
    },
    open(payloadBase64, nonceBase64) {
      // 串行化 + nonce 反解 index/epoch（WIRE §4 布局——密文自带序，乱序/重发三态由 ratchet 裁决）
      const run = openChain.then(async () => {
        const ct = new Uint8Array(Buffer.from(payloadBase64, "base64"));
        const nonceBytes = new Uint8Array(Buffer.from(nonceBase64, "base64"));
        const parsed = parseNonce(nonceBytes);
        if (parsed === null) return null;
        const aad = buildAad(`gw_${deps.installationId}`, `dev_${deps.deviceId}`, parsed.epoch);
        const outcome = await ratchet.open({ ciphertext: ct, nonce: nonceBytes, aad, index: parsed.index, epoch: parsed.epoch });
        if (!outcome.ok) return null;
        recvIndex = Math.max(recvIndex, outcome.index + 1);
        return Buffer.from(outcome.plaintext).toString("utf8");
      });
      openChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    ratchet,
  };
}

export type { Frame };
