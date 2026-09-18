// 错误文本化：AggregateError 展开保留全部内因（parallel 聚合错误的伴生工具）。
export function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map((inner) => errorText(inner)).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}
