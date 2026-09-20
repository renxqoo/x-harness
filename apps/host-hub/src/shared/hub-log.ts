// stderr 排障面（DESIGN §9）：两级前缀 `hub:` / `hub:worker:<threadId>`——协议帧
// 走 stdout 接管，一切诊断走本通道（必记事件清单见 DESIGN §9）。
export function hubLog(message: string): void {
  process.stderr.write(`hub: ${message}\n`);
}

export function workerLog(threadId: string, message: string): void {
  process.stderr.write(`hub:worker:${threadId}: ${message}\n`);
}
