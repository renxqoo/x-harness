// 错误摘要脱敏（docs/WORK-ERROR-RECOVERY.md C5 respond 消息载体）：pi errorMessage 含
// fetch 端点信息（URL）与可能内联的凭据模式——respond 面落卷（模型可见、摘要保留）前剔除。

/** URL 与凭据模式两组简单正则：https?://\S+ → [url]；(api_key|token|bearer) 赋值形 → [redacted] */
const URL_PATTERN = /https?:\/\/\S+/g;
const CREDENTIAL_PATTERN = /(?:api[_-]?key|token|bearer)\s*[:=]\s*\S+/gi;

export function sanitizeErrorMessage(message: string): string {
  return message.replace(CREDENTIAL_PATTERN, "[redacted]").replace(URL_PATTERN, "[url]");
}
