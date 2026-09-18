// 错误文本化（total）：AggregateError 展开保留全部内因；hostile toString 抛错兜底为占位符——
// 任何抛出值都必须能被文本化，供「永不 reject」的归一化路径使用。
export function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map((inner) => errorText(inner)).join("; ");
  if (error instanceof Error) {
    try {
      return error.message;
    } catch {
      return "<unprintable thrown value>";
    }
  }
  try {
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}
