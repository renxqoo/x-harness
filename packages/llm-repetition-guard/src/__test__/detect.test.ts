// 复读检测器纯函数面（docs/LLM-REPETITION-GUARD.md §2）：两档触发、排除面（纯标点/
// 纯数字）、真周期判定（倍数别名收归最短周期）、通道分域互不串扰、跨 delta 帧切开的
// 重复单元仍命中、尾窗裁剪不丢游程、attempt 结束（新实例）状态归零。
// 症状命名：模型行内复读致文案前缀重复/烧穿 token（session 20260924T182924 实测形态）。

import { describe, expect, it } from "vitest";
import { RepetitionDetector, SHORT_UNIT_SPAN } from "../index.ts";

const push = (detector: RepetitionDetector, text: string): void => {
  detector.push(text);
};

describe("RepetitionDetector 两档触发", () => {
  it("症状：Doc×2000 烧穿 token（seq454 实测形态）——保险丝档在跨度 ≥100 截断报命中", () => {
    const detector = new RepetitionDetector();
    push(detector, "Doc".repeat(2000));
    const hit = detector.hit();
    expect(hit).toBeDefined();
    expect(hit?.unit).toBe("Doc");
    expect(hit?.span).toBeGreaterThanOrEqual(SHORT_UNIT_SPAN);
  });

  it("k=6 单元 ×26 命中（主闸阈值位）：长单元原地连抄 >25 次", () => {
    const fuse = new RepetitionDetector();
    push(fuse, "剪刀石头布".repeat(34)); // k=3 保险丝：3×34=102 ≥100 触发
    expect(fuse.hit()).toBeDefined();
    const detector = new RepetitionDetector();
    push(detector, "研究研究到底".repeat(26)); // k=6 主闸：×26 达阈（>25）
    expect(detector.hit()?.unit).toBe("研究研究到底");
  });

  it("k∈[2,5] 短单元 ×6 不触发（宁可漏：My×5 / Clean×6 / Exit×5 实测形态全放行；新主闸阈 >25 下长单元低次同样放行）", () => {
    for (const unit of ["My", "Now", "Exit", "Docs", "Clean", "3043", "Tests"]) {
      const detector = new RepetitionDetector();
      push(detector, unit.repeat(6));
      expect(detector.hit(), `unit=${unit} ×6 不应触发`).toBeUndefined();
    }
  });

  it("短单元高次重复达保险丝跨度触发：注意×16（span 32）不触发、注意×50（span 100）触发", () => {
    const light = new RepetitionDetector();
    push(light, "注意".repeat(16)); // 实测落盘脏文案形态——span 32 < 100 放行（宁可漏）
    expect(light.hit()).toBeUndefined();
    const runaway = new RepetitionDetector();
    push(runaway, "注意".repeat(50));
    expect(runaway.hit()?.unit).toBe("注意");
  });

  it("症状：k=5 单元跨过保险丝阈（Clean×20=span 100）触发——观感污染与烧穿的交接带", () => {
    const detector = new RepetitionDetector();
    push(detector, "Clean".repeat(20));
    expect(detector.hit()?.unit).toBe("Clean");
  });
});

describe("排除面（不误判）", () => {
  it("纯标点单元不触发：markdown 分隔线与宽表分隔行", () => {
    const lines = new RepetitionDetector();
    push(lines, "-".repeat(40));
    expect(lines.hit()).toBeUndefined();
    const table = new RepetitionDetector();
    push(table, "|---|---|---|---|---|---|---|---|---|"); // 单元 |---| ×10
    expect(table.hit()).toBeUndefined();
    const equals = new RepetitionDetector();
    push(equals, "======".repeat(10));
    expect(equals.hit()).toBeUndefined();
  });

  it("纯数字单元不触发：编号/补零填充（3043×6 实测形态）", () => {
    const detector = new RepetitionDetector();
    push(detector, "3043".repeat(30));
    expect(detector.hit()).toBeUndefined();
  });

  it("含字母/CJK 的合法长文本不触发", () => {
    const detector = new RepetitionDetector();
    push(detector, "这是一段正常的中文说明文字，讨论权限裁决面的实现细节。".repeat(3));
    expect(detector.hit()).toBeUndefined();
  });

  it("最短周期取真单元：ABAB… 报 AB 不报 ABABAB", () => {
    const detector = new RepetitionDetector();
    push(detector, "研究研究".repeat(26)); // 真单元「研究」k=2
    expect(detector.hit()?.unit).toBe("研究");
  });

  it("超长重复以更短真周期裁决：字×384 的真周期是 2（保险丝 span 384 触发）——假长单元被别名判定收归", () => {
    const detector = new RepetitionDetector();
    push(detector, "字".repeat(384));
    const hit = detector.hit();
    expect(hit?.unit).toBe("字字"); // 真周期 2：hasSmallerPeriod 把 k=64 假单元收归
    expect(hit?.span).toBe(384);
  });

  it("真周期 >64 的整段循环结构性放弃：由 provider 截断与流空闲看门狗兜底", () => {
    const unit = "真周期超过六十四字符的长句子必须足够长才能验证结构性放弃行为，这里继续补足长度到七十字符以上的完整表述不留任何缝隙与歧义空间存在着";
    expect(unit.length).toBeGreaterThan(64); // 真周期 65——k>MAX_UNIT 档位缺席
    const detector = new RepetitionDetector();
    push(detector, unit.repeat(6)); // 窗内尾部的 ≤64 假单元都非真周期 → 不触发
    expect(detector.hit()).toBeUndefined();
  });
});

describe("流式边界", () => {
  it("跨 delta 帧切开的重复单元仍命中（帧边界不对齐单元边界）", () => {
    const detector = new RepetitionDetector();
    const repeated = "deploy".repeat(26); // k=6 主闸：×26 达阈
    for (const char of repeated) push(detector, char); // 单字符帧
    expect(detector.hit()?.unit).toBe("deploy");
  });

  it("空 delta 跳过（replay-guard HOLD 期零宽保活帧不参与游程）", () => {
    const detector = new RepetitionDetector();
    detector.push("");
    push(detector, "cleaner".repeat(26));
    detector.push("");
    expect(detector.hit()?.unit).toBe("cleaner");
  });

  it("尾窗裁剪不丢长游程：巨型单 delta 超窗后游程仍在窗内可判", () => {
    const detector = new RepetitionDetector();
    push(detector, "前置说明文字若干，不构成重复。".repeat(4));
    push(detector, "truncate".repeat(50)); // k=8 ×50——span 400，尾窗 1664 内完整可见
    expect(detector.hit()?.unit).toBe("truncate");
  });

  it("attempt 结束状态归零：新实例不携带上一 attempt 的游程（跨消息句式复用不误报）", () => {
    const first = new RepetitionDetector();
    push(first, "cleaner".repeat(26));
    expect(first.hit()).toBeDefined();
    const second = new RepetitionDetector();
    push(second, "cleaner 工具的输出如下");
    expect(second.hit()).toBeUndefined();
  });
});
