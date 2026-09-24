// ask 目标描述（AskPayload.summary 唯一构造点——确认条主文案）：从工具入参取目标标识，
// 统一优先序 path → command → pattern（路径类工具=文件路径；bash=命令；grep 无路径=检索式）；
// 垃圾入参/全缺席返回 undefined（调用方省略字段，不发空壳）。

const TARGET_KEYS = ["path", "command", "pattern"] as const;

export function summaryOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
