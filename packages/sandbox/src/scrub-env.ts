// 子进程 env 密钥清洗（docs/SANDBOX.md §0）：内核拦不住进程读自身 env——spawn 前按键名过滤。
// 只匹配键名（值不扫描）；大小写不敏感；命中 KEY|PASSWORD|SECRET|TOKEN 任一片段即剥除整条。

const SCRUB_RE = /KEY|PASSWORD|SECRET|TOKEN/i;

export function scrubEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SCRUB_RE.test(key)) out[key] = value;
  }
  return out;
}
