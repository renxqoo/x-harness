// 响应错误通道结构化（T40 §2.1）：错误族码表按消费行为定族——消费方按 code 判别
// （重锚自愈/受理降级重试/能力指引/文案分派），message 保留自然语言细节不折平。
// 单一真相在本文件；app contracts 镜像 + 握手对拍（get_host_info.errorCodes）双向防漂移。
// 未知 code 的消费方兜底：原文透传（code+message 不丢），不得静默折叠。

export const HUB_ERROR_CODES = [
  // 线程寻址与生命周期
  "unknown_thread", // 线程表真缺失/逐出（消费方：按会话文件重锚自愈——与 thread_superseded 严格区分）
  "thread_superseded", // fork 重键/单会话守卫对在飞旧 id 的结算（自愈禁触发，防复活换轨前状态）
  "thread_not_live",
  "session_unreadable", // 会话文件不可读（消费方：resume/register 的删行语义，不与 io_failed 混族）
  "already_open",
  "thread_limit", // 容量：线程数/在飞命令/bash 并发/响应过大
  // 受理与输入
  "streaming_window", // 受理窗口（pendingSends ∨ streaming）——降级重试信号
  "invalid_input",
  "unknown_command",
  // 能力
  "capability_thinking",
  "capability_images",
  "capability_plugin", // 线程在场而外部插件缺席（禁用/装载失败——docs/PLUGINS.md 契约 5）
  "images_too_many",
  "model_unavailable",
  // 会话状态
  "cursor_stale",
  "state_conflict",
  "name_conflict",
  "trust_required",
  "path_forbidden",
  // 基础设施与兜底
  "io_failed",
  "internal", // catch-all 兜底族（原始错误文本保留在 message）
  "bash_denied",
  "protocol", // parse failure/shutting down/invalid id/worker died 等协议级
  "compact_rejected", // compaction 命令词表（packages/compaction 内层穿透）
  "plugin_install_failed", // 插件热装失败（装载器 Result err——message 带引擎 reason）
  "plugin_uninstall_failed", // 插件热卸失败（依赖未清/引擎 err）
] as const;

export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

/** wire 形状（ResponseFrame.error） */
export interface HubErrorShape {
  code: HubErrorCode;
  message: string;
}

/** 发射点铸造（respond({ error: hubError("unknown_thread", "Unknown threadId") })） */
export function hubError(code: HubErrorCode, message: string): HubErrorShape {
  return { code, message };
}

/** 中继/解码侧形状守卫（垃圾输入 false，不抛） */
export function isHubErrorShape(value: unknown): value is HubErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && HUB_ERROR_CODES.includes(record["code"] as HubErrorCode) && typeof record["message"] === "string";
}

/** 内层穿透：可分类的内部异常（装配/压缩/持久化等深处抛出，外层 catch 站点提取
 *  code——开放词表的 packages 层不必知道 respond 形状）。携带判别数据是 Error
 *  子类的标准用途，此处允许 class。 */
export class CodedError extends Error {
  readonly code: HubErrorCode;

  constructor(code: HubErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** catch 站点统一提取：CodedError 用其 code；其余落 fallback（默认 internal，原文保留） */
export function errorOfCause(cause: unknown, fallback: HubErrorCode = "internal"): HubErrorShape {
  if (cause instanceof CodedError) return { code: cause.code, message: cause.message };
  return { code: fallback, message: cause instanceof Error ? cause.message : String(cause) };
}
