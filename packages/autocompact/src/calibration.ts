// 尾估校准（docs/COMPACTION.md §1.2；参照系 accountant 校准段移植）：实测锚 /
// 前次纯预测的比值样本，截 9 FIFO、去最值离群后取中位；尾估乘校准因子。纯函数——
// 状态由调用方（gate 缓存）持有。

export interface Calibration {
  readonly samples: number[];
}

export function emptyCalibration(): Calibration {
  return { samples: [] };
}

/** 新样本入列：ratio ∈ (0, 10] 之外视为离群丢弃（单次 cache 计费波动不带入） */
export function pushCalibrationSample(calibration: Calibration, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 10) return;
  calibration.samples.push(ratio);
  if (calibration.samples.length > 9) calibration.samples.shift();
}

/** 中位数（去最值后取中位——离群剔除）；空样本 → 1（不校正） */
export function calibrationFactor(calibration: Calibration): number {
  const sorted = [...calibration.samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 1;
  const first = sorted[0];
  if (sorted.length === 1 && first !== undefined) return first;
  const trimmed = sorted.slice(1, sorted.length - 1);
  const pool = trimmed.length > 0 ? trimmed : sorted;
  const mid = Math.floor(pool.length / 2);
  const lo = pool[mid - 1];
  const hi = pool[mid];
  if (pool.length % 2 === 1) return hi ?? 1;
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : 1;
}
