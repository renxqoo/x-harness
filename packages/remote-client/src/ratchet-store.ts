// 客户端侧 ratchet codec：RemoteCodec 的双 ratchet 实现（配对产物种子）。
import {
  RatchetSession,
  aeadSeal,
  buildAad,
  buildNonce,
  deriveInitialChains,
  type Frame,
} from "@x-harness/remote-protocol";

export interface RatchetCodecDeps {
  deviceId: string;
  installationId: string;
  sharedSecret: Uint8Array;
}

export interface RatchetCodec {
  seal(frameJson: string): Promise<string | null>;
  open(payloadBase64: string): Promise<string | null>;
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
      return Buffer.from(ct).toString("base64");
    },
    open(payloadBase64) {
      // 串行化：并发 open 同读 recvIndex 会错位解密（tag 失败连锁）
      const run = openChain.then(async () => {
        const ct = new Uint8Array(Buffer.from(payloadBase64, "base64"));
        const epoch = ratchet.snapshotRecv().epoch;
        const index = recvIndex;
        const aad = buildAad(`gw_${deps.installationId}`, `dev_${deps.deviceId}`, epoch);
        // gateway 是配对发起侧（direction 0）——其发送帧 nonce 方向位为 0
        const outcome = await ratchet.open({ ciphertext: ct, nonce: buildNonce(epoch, 0, index), aad, index, epoch });
        if (!outcome.ok) return null;
        recvIndex = outcome.index + 1;
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
