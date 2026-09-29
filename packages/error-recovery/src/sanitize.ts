const URL_PATTERN = /https?:\/\/\S+/g;
const CREDENTIAL_PATTERN = /(?:api[_-]?key|token|bearer)\s*[:=]\s*\S+/gi;

export function sanitizeErrorMessage(message: string): string {
  return message.replace(CREDENTIAL_PATTERN, "[redacted]").replace(URL_PATTERN, "[url]");
}
