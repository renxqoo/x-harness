// rekey 契约（S4）：发起/应答/完成往返、签名验证、到期判定
import { describe, expect, it } from "vitest";
import { acceptRekey, finishRekey, rekeyDue, startRekey } from "../rekey.ts";
import { generateBoxKeyPair, generateSigningKeyPair } from "../crypto.ts";

describe("rekey 握手", () => {
  it("发起→应答→完成：双端新链一致（root 相同、收发链镜像）", () => {
    const initiator = generateSigningKeyPair();
    const responderEph = generateBoxKeyPair();
    const oldRoot = "ab".repeat(32);
    const started = startRekey({ initiatorSigningSecret: initiator.secret, initiatorSigningPub: initiator.pub, peerCurrentRatchetPub: "", rekeyCounter: 3 });
    const accepted = acceptRekey({ request: started.request, responderEphemeralSecret: responderEph.secret, responderEphemeralPub: responderEph.pub, initiatorSigningPub: initiator.pub, oldRootKey: oldRoot });
    expect("error" in accepted && accepted.error).toBeFalsy();
    if ("error" in accepted) return;
    const finished = finishRekey({ accept: accepted.reply, initiatorEphemeralSecret: started.ephemeralSecret, oldRootKey: oldRoot, rekeyCounter: 3 });
    expect("error" in finished && finished.error).toBeFalsy();
    if ("error" in finished) return;
    expect(finished.rootKey).toBe(accepted.init.rootKey);
    expect(finished.sendChainKey).toBe(accepted.init.recvChainKey);
    expect(finished.recvChainKey).toBe(accepted.init.sendChainKey);
  });

  it("签名拒绝：错钥验签失败 / counter 不匹配完成失败", () => {
    const initiator = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const responderEph = generateBoxKeyPair();
    const started = startRekey({ initiatorSigningSecret: initiator.secret, initiatorSigningPub: initiator.pub, peerCurrentRatchetPub: "", rekeyCounter: 1 });
    const bad = acceptRekey({ request: started.request, responderEphemeralSecret: responderEph.secret, responderEphemeralPub: responderEph.pub, initiatorSigningPub: other.pub, oldRootKey: "aa".repeat(32) });
    expect(bad).toMatchObject({ error: "signer mismatch" });
    const ok = acceptRekey({ request: started.request, responderEphemeralSecret: responderEph.secret, responderEphemeralPub: responderEph.pub, initiatorSigningPub: initiator.pub, oldRootKey: "aa".repeat(32) });
    if ("error" in ok) throw new Error("unreachable");
    const mismatch = finishRekey({ accept: ok.reply, initiatorEphemeralSecret: started.ephemeralSecret, oldRootKey: "aa".repeat(32), rekeyCounter: 9 });
    expect(mismatch).toMatchObject({ error: "counter mismatch" });
  });

  it("到期判定：2000 消息或 24h", () => {
    const now = Date.now();
    expect(rekeyDue(1999, now, now)).toBe(false);
    expect(rekeyDue(2000, now, now)).toBe(true);
    expect(rekeyDue(0, now - 24 * 60 * 60 * 1000, now)).toBe(true);
    expect(rekeyDue(0, now - 1000, now)).toBe(false);
  });
});
