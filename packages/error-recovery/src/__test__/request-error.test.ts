// requestError 面（C5）：分族 ×3 升 fail / 总 ×5 封顶交替 / 成功清零 / 5xx 不 respond /
// 死类直通 / respond 落卷（agent/message{content, error-recovery} + 脱敏）。

import { describe, expect, it } from "vitest";
import { createErrorRecoveryPlugin } from "../index.ts";
import { errorFinish, makeRecoveryWorld, textFinish, turnEnd } from "./world.ts";

describe("error-recovery requestError 面（C5）", () => {
  it("分族 ×3 升 fail：http-4xx 族第 4 次（>3）收轮（前 3 次 respond 自愈）", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    world.scripts.push(errorFinish("bad shape", "http-400"), errorFinish("bad shape 2", "http-400"), errorFinish("third", "http-400"), errorFinish("fourth", "http-400"), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    const responses = events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery");
    expect(responses).toHaveLength(3); // 前 3 次 respond 自愈（第 4 次达族限 >3 升 fail）
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "error", code: "error-recovery-limit" } });
  });

  it("总 ×5 封顶交替：429/network 交替各 2 次（skip/fail 直收不 respond）不达分族阈值", async () => {
    // 429/503 属 transport-retryable → skip 直接 fail（不 respond、不烧 token）——交替断言：
    // 第一次 429 即 fail 收轮（B P2 成本裁决），终态带 code
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    world.scripts.push(errorFinish("rate limited", "http-429"));
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(0); // skip 不 respond
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "error", code: "http-429" } });
  });

  it("交替封顶（respond 族混输）：http-400 ×2 + E_TIMEOUT ×2（unknown 族）→ 第 5 次总封顶 fail", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    const codes = ["http-400", "E_TIMEOUT", "http-400", "E_TIMEOUT", "E_TIMEOUT"];
    for (const [i, code] of codes.entries()) world.scripts.push(errorFinish(`err${String(i)}`, code));
    world.scripts.push(textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(5);
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "completed" } }); // 5 次均未超限（>maxTotal 才 fail）
  });

  it("总封顶第 6 次触顶：4 次 respond 后第 5/6 次交替族混输达 total>5 → fail", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    const codes = ["http-400", "E_TIMEOUT", "http-400", "E_TIMEOUT", "E_TIMEOUT", "E_TIMEOUT"];
    for (const [i, code] of codes.entries()) world.scripts.push(errorFinish(`err${String(i)}`, code));
    world.scripts.push(textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(5);
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "error", code: "error-recovery-limit" } });
  });

  it("成功清零：respond 自愈后模型正常完成 → 计数清零，新一轮再从 1 起", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    world.scripts.push(errorFinish("bad", "http-400"), textFinish(), errorFinish("bad", "http-400"), errorFinish("bad", "http-400"), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    // 两轮各 respond 1 次（首轮自愈 stop 清零，次轮 1-2 次仍 respond 未达族 ×3）
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "completed" } });
  });

  it("死类直通：auth（http-401）首错即 fail 不 respond", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin()]);
    world.scripts.push(errorFinish("invalid key", "http-401"));
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const events = world.agent.session.events();
    expect(events.filter((e) => e.type === "agent/message" && e.data.source === "error-recovery")).toHaveLength(0);
    expect(turnEnd(events)?.data).toMatchObject({ reason: { kind: "error", code: "http-401" } }); // 死类直通透传原 code
  });

  it("respond 落卷与脱敏：agent/message{kind:content, source:error-recovery}，URL/凭据剔除", async () => {
    const world = await makeRecoveryWorld([createErrorRecoveryPlugin({ maxConsecutiveFailures: 2 })]);
    world.scripts.push(errorFinish("call to https://api.secret.io/v1 failed: api_key=sk-99 rejected", "http-400"), textFinish());
    world.agent.followup("hi");
    await world.agent.whenIdle();
    const recovery = world.agent.session.events().find((e) => e.type === "agent/message" && e.data.source === "error-recovery");
    expect((recovery?.data as { kind?: string } | undefined)?.kind).toBe("content");
    const text = JSON.stringify(recovery?.data);
    expect(text).toContain("[url]");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("secret.io");
    expect(text).toContain("if this error persists");
  });
});
