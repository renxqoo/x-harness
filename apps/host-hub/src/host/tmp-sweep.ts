// 原子写残留清扫（DESIGN §3.6）：providers.json / credentials.json 的原子替换链
// （writeFile tmp → rename）中途崩溃后 tmp 永久残留——启动期清扫兜底回收（运行
// 中 tmp 属在途写，不碰：仅清 mtime 超 1h 的残留）。
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** tmp 命名 pattern：`providers.json.<pid>.<uuid>.tmp` / `credentials.<pid>.<uuid>.tmp` */
const TMP_NAME = /^(?:providers\.json|credentials)\.[0-9]+\.[0-9a-f-]{8,}\.tmp$/;

/** 在途写的最大合理窗口（超过即视为残留） */
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

export async function cleanupTmpResidue(agentDir: string): Promise<void> {
  const names = await readdir(agentDir).catch(() => undefined);
  if (names === undefined) return;
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
  for (const name of names) {
    if (!TMP_NAME.test(name)) continue;
    const path = join(agentDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    if (info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
  }
}
