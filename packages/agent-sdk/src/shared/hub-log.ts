export function hubLog(message: string): void {
  process.stderr.write(`hub: ${message}\n`);
}

export function workerLog(threadId: string, message: string): void {
  process.stderr.write(`hub:worker:${threadId}: ${message}\n`);
}
