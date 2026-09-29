const SCRUB_RE = /KEY|PASSWORD|SECRET|TOKEN/i;

export function scrubEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SCRUB_RE.test(key)) out[key] = value;
  }
  return out;
}
