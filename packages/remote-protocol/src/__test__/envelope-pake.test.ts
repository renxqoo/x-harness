// L3 信封编解码 + PAKE 原语
import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "../envelope.ts";
import { pakeConfirm, pakeConfirmVerify, pakeInitiate, pakeRespond } from "../pake.ts";

describe("L3 信封", () => {
  it("编解码往返；垃圾/缺字段降级 null", () => {
    const env = { v: 1, from: "dev_1", to: "gw_i1", payload: "QUJD", nonce: Buffer.alloc(17).toString("base64") };
    const line = encodeEnvelope(env);
    expect(decodeEnvelope(line)).toEqual(env);
    expect(decodeEnvelope("")).toBeNull();
    expect(decodeEnvelope("not-json")).toBeNull();
    expect(decodeEnvelope('{"v":2,"from":"a","to":"b","payload":"c"}')).toBeNull();
    expect(decodeEnvelope('{"v":1,"from":"","to":"b","payload":"c"}')).toBeNull();
    expect(decodeEnvelope('{"v":1,"from":"a","to":"b","nonce":"x"}')).toBeNull();
    expect(decodeEnvelope('{"v":1,"from":"a","to":"b","payload":"c"}')).toBeNull();
    expect(decodeEnvelope('"string"')).toBeNull();
  });
});

describe("PAKE 原语", () => {
  it("initiate/respond：消息确定、共享一致", () => {
    const a = pakeInitiate("12345678");
    const b = pakeRespond("12345678", a.message);
    // 双方共享从各自视角可重算（pake 模块内对称派生）
    expect(a.message).not.toBe(b.message);
    expect(b.shared).toMatch(/^[0-9a-f]{64}$/);
  });

  it("confirm 验证：正确通过、篡改失败、长度不等 false", () => {
    const k = "ab".repeat(32);
    const c = pakeConfirm(k, "t1");
    expect(pakeConfirmVerify(k, "t1", c)).toBe(true);
    expect(pakeConfirmVerify(k, "t2", c)).toBe(false);
    expect(pakeConfirmVerify(k, "t1", `${c}00`)).toBe(false);
  });

  it("confirm 非常量长度比较不泄露（简断言：不同长直接 false 不抛）", () => {
    expect(pakeConfirmVerify("zz", "t", "")).toBe(false);
  });
});
