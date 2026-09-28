// ask 目标描述（AskPayload.summary 唯一构造点——确认条主文案）：从工具入参取目标标识，
// 统一优先序 path → paths → command → pattern（路径类工具=文件路径；read 批量=逐条列出；
// bash=命令；grep 无路径=检索式）；垃圾入参/全缺席返回 undefined（调用方省略字段，不发空壳）。

const TARGET_KEYS = ["path", "paths", "command", "pattern"] as const;

export function summaryOf(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    const strings = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    if (strings !== undefined && strings.length > 0) {
      // read 批量形态：逐条列出（上限 8 与 schema 一致；确认条里用户要能看清每一个目标）。
      // 垃圾条目跳过（与 decide.ts pathsOf 的防御口径一致——schema 层已拒，这里双保险不炸）。
      return strings.join(", ");
    }
  }
  return undefined;
}
