export interface RepetitionHit {
  readonly unit: string;
  readonly count: number;
  readonly span: number;
}

export const MAX_UNIT = 64;
export const LONG_UNIT_MIN_REPEATS = 26;
export const LONG_UNIT_MIN = 6;
export const SHORT_UNIT_SPAN = 100;
export const TAIL_WINDOW = MAX_UNIT * LONG_UNIT_MIN_REPEATS;

function isQualifiedUnit(unit: string): boolean {
  let hasAlnum = false;
  for (const char of unit) {
    if (/[a-zA-Z0-9]/u.test(char)) {
      hasAlnum = true;
    } else if (!/\s/u.test(char) && !/[\p{P}\p{S}]/u.test(char)) {
      return true;
    }
  }
  return hasAlnum && !/^[0-9]+$/u.test(unit);
}

function hasSmallerPeriod(unit: string, k: number): boolean {
  for (let d = 2; d * d <= k; d += 1) {
    if (k % d !== 0) continue;
    if (unit.slice(0, d).repeat(k / d) === unit) return true;
    const d2 = k / d;
    if (d2 !== d && unit.slice(0, d2).repeat(d) === unit) return true;
  }
  return false;
}

export class RepetitionDetector {
  private readonly parts: string[] = [];
  private length = 0;
  private cached: RepetitionHit | undefined;

  push(delta: string): void {
    if (delta === "") return;
    this.parts.push(delta);
    this.length += delta.length;
    this.trim();
    this.scan();
  }

  hit(): RepetitionHit | undefined {
    return this.cached;
  }

  private trim(): void {
    while (this.length > TAIL_WINDOW && this.parts.length > 1) {
      const first = this.parts.shift();
      this.length -= first?.length ?? 0;
    }
    const single = this.parts[0];
    if (this.parts.length === 1 && single !== undefined && single.length > TAIL_WINDOW) {
      this.parts[0] = single.slice(single.length - TAIL_WINDOW);
      this.length = this.parts[0].length;
    }
  }

  private scan(): void {
    if (this.cached !== undefined) return;
    const text = this.parts.join("");
    const length = text.length;
    for (let k = 2; k <= MAX_UNIT && k * 2 <= length; k += 1) {
      const unit = text.slice(length - k);
      if (!isQualifiedUnit(unit)) continue;
      if (hasSmallerPeriod(unit, k)) continue;
      let count = 1;
      while (length - (count + 1) * k >= 0 && text.slice(length - (count + 1) * k, length - count * k) === unit) {
        count += 1;
      }
      if (this.triggers(k, count)) {
        this.cached = { unit, count, span: count * k };
        return;
      }
    }
  }

  private triggers(k: number, count: number): boolean {
    if (k >= LONG_UNIT_MIN) return count >= LONG_UNIT_MIN_REPEATS;
    return count * k >= SHORT_UNIT_SPAN;
  }
}
