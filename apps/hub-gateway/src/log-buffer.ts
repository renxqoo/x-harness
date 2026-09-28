// 日志环形缓冲（gw/logs/tail 数据源）：500 行上限丢最旧。
export interface LogBuffer {
  push(line: string): void;
  tail(): string[];
}

export function createLogBuffer(capacity = 500): LogBuffer {
  const lines: string[] = [];
  return {
    push(line) {
      lines.push(line);
      if (lines.length > capacity) lines.splice(0, lines.length - capacity);
    },
    tail() {
      return [...lines];
    },
  };
}
