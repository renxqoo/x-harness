// 复读检测器（纯函数面，docs/LLM-REPETITION-GUARD.md §1）：流式尾部游程检测——模型侧
// 首 token 采样循环产生的「同一小单元原地连抄」（实测症状：`DocsDocsDocsDocs`、
// `注意`×16、`Doc`×2000 烧穿 token），与 replay-guard 的「上游断流从头重发」是两类故障，
// 互不覆盖。按通道分域（text / thinking 各自实例——通道边界处 text 复述 thinking 结论
// 是合法形态，不产生跨域假阳性）；跨 delta 帧增量比对（重复单元可能被帧边界切开）。
//
// 两档规则（阈值依据 docs/LLM-REPETITION-GUARD.md §2——宁可漏不误判）：
//  - 主闸：单元真周期 k∈[6,64] 且含字母/CJK，连续 >25 次（跨度 ≥156）
//  - 保险丝：k∈[2,5] 同上资格，复读总跨度 ≥100（只防 token 烧穿，不管文案观感）
// 排除面：纯标点/空白单元（markdown 分隔线 `---`、宽表 `|---|---|`）、纯数字单元
//  （编号/补零填充的合法重复）。真周期判定：单元内部存在更小重复子串（倍数别名）时
//  跳过——否则 `注意`×34 会被 k=6 的别名单元 `注意注意注意` 绕过保险丝跨度阈值。
// 状态恒 ≤ 尾窗 MAX_UNIT×26=1664 字符（主闸最长单元 ×26 的完整游程必须落在窗内）——
// 零全文缓冲；每 delta 一次 O(窗长) 比对，pass-through 不扣帧不延迟，UI 流无感。

/** 触发证据（审计与日志共用） */
export interface RepetitionHit {
  /** 命中的重复单元（原文） */
  readonly unit: string;
  /** 已观察到的连续重复次数 */
  readonly count: number;
  /** 复读总跨度（unit.length × count，字符数） */
  readonly span: number;
}

/** 主闸：单元长度上限（无上限则尾窗比对退化为 O(n·k)；超长整段循环结构性放弃——
 *  由 provider 截断与流空闲看门狗兜底） */
export const MAX_UNIT = 64;
/** 主闸：长单元（k≥6）触发次数（>25）——长单元原地连抄 26 次在专业正文构造不出合法用例 */
export const LONG_UNIT_MIN_REPEATS = 26;
/** 主闸单元长度下限（k<6 归保险丝档） */
export const LONG_UNIT_MIN = 6;
/** 保险丝：短单元（k∈[2,5]）触发跨度（×20~×50 次）——只止损 token 烧穿 */
export const SHORT_UNIT_SPAN = 100;
/** 尾窗长度：主闸最长单元（64）× 触发次数（26）——窗短于此则长单元游程被截不可判 */
export const TAIL_WINDOW = MAX_UNIT * LONG_UNIT_MIN_REPEATS;

/** 单元资格：须含字母或 CJK——纯标点/空白（分隔线、表格行）与纯数字（编号/补零）排除 */
function isQualifiedUnit(unit: string): boolean {
  let hasAlnum = false;
  for (const char of unit) {
    if (/[a-zA-Z0-9]/u.test(char)) {
      hasAlnum = true;
    } else if (!/\s/u.test(char) && !/[\p{P}\p{S}]/u.test(char)) {
      return true; // CJK 等文字字符——直接合格
    }
  }
  return hasAlnum && !/^[0-9]+$/u.test(unit);
}

/** 真周期判定：单元由更短子串整除重复构成（如 `注意注意注意`=真周期 2）时非真周期——
 *  倍数别名跳过，交由更小的 k 裁决（同一段游程在真周期档位的跨度相同，阈值不变形） */
function hasSmallerPeriod(unit: string, k: number): boolean {
  for (let d = 2; d * d <= k; d += 1) {
    if (k % d !== 0) continue;
    if (unit.slice(0, d).repeat(k / d) === unit) return true;
    const d2 = k / d;
    if (d2 !== d && unit.slice(0, d2).repeat(d) === unit) return true;
  }
  return false;
}

/**
 * 单通道复读检测器：push 增量喂入该通道的 delta 拼接，hit 读最近一次命中（未命中
 * undefined；命中后进入饱和态——同一 attempt 内不重复报，消费端截流即抛弃本实例）。
 * 状态随实例生灭（插件每流新建）——不跨 attempt / step / turn 携带，跨消息的句式复用
 * 不产生假阳性。
 */
export class RepetitionDetector {
  private readonly parts: string[] = []; // 尾窗分片（join 摊平成本摊到 push）
  private length = 0;
  private cached: RepetitionHit | undefined;

  /** 喂入一个 delta（空串跳过——replay-guard HOLD 期零宽保活帧） */
  push(delta: string): void {
    if (delta === "") return;
    this.parts.push(delta);
    this.length += delta.length;
    this.trim();
    this.scan();
  }

  /** 最近一次命中；未命中 undefined */
  hit(): RepetitionHit | undefined {
    return this.cached;
  }

  /** 尾窗裁剪：保留最近 TAIL_WINDOW 字符（检测域只需尾部——窗内必含主闸完整游程） */
  private trim(): void {
    while (this.length > TAIL_WINDOW && this.parts.length > 1) {
      const first = this.parts.shift();
      this.length -= first?.length ?? 0;
    }
    const single = this.parts[0];
    if (this.parts.length === 1 && single !== undefined && single.length > TAIL_WINDOW) {
      this.parts[0] = single.slice(single.length - TAIL_WINDOW); // 巨型单 delta 原地截尾
      this.length = this.parts[0].length;
    }
  }

  /** 尾窗游程扫描：候选周期 k 从小到大——真周期单元的最短周期先被枚举（`ABAB` 的
   *  单元是 AB 不是 ABAB——最短周期才是采样循环的真单元）；倍数别名由真周期判定排除 */
  private scan(): void {
    if (this.cached !== undefined) return; // 饱和：同 attempt 不重复报
    const text = this.parts.join("");
    const length = text.length;
    for (let k = 2; k <= MAX_UNIT && k * 2 <= length; k += 1) {
      const unit = text.slice(length - k);
      if (!isQualifiedUnit(unit)) continue;
      if (hasSmallerPeriod(unit, k)) continue;
      let count = 1;
      while (length - (count + 1) * k >= 0 && text.slice(length - (count + 1) * k, length - count * k) === unit) {
        count += 1;
      }
      if (this.triggers(k, count)) {
        this.cached = { unit, count, span: count * k };
        return;
      }
    }
  }

  /** 两档触发判定（纯函数语义，测试直测路径）：主闸 k≥6 计数制；保险丝 k<6 跨度制 */
  private triggers(k: number, count: number): boolean {
    if (k >= LONG_UNIT_MIN) return count >= LONG_UNIT_MIN_REPEATS;
    return count * k >= SHORT_UNIT_SPAN;
  }
}
