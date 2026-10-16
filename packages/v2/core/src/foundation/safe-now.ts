import type { Kernel } from "./types";

export function safeNow(kernel: Kernel): number {
  try {
    const now = kernel.scheduler.now();
    if (Number.isFinite(now)) return now;
  } catch { }
  return 0;
}
