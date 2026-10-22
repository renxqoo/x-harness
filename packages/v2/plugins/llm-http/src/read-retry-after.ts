export function readRetryAfter(headers: Headers, now: number): number | undefined {
  const seconds = headers.get("retry-after");

  if (seconds !== null) {
    const value = Number(seconds.trim());

    if (seconds.trim() && Number.isFinite(value))
      return value >= 0 ? Math.min(86400000, Math.ceil(value * 1000)) : undefined;

    const date = Date.parse(seconds);

    if (Number.isFinite(date) && Number.isFinite(now))
      return Math.min(86400000, Math.max(0, date - now));

    return undefined;
  }

  const milliseconds = headers.get("retry-after-ms");

  if (milliseconds === null || !milliseconds.trim()) return undefined;

  const value = Number(milliseconds);
  return Number.isFinite(value) && value >= 0 ? Math.min(86400000, Math.ceil(value)) : undefined;
}
