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
