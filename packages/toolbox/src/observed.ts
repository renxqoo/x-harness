// 观察版本登记（docs/TOOLBOX.md §3）：会话键控（跨会话不可借用观察）；版本元组 {ino,size,mtimeNs}
// （statSync bigint——temp+rename 换 inode 必须可比）；同路径进程内互斥（promise chain）。

import { statSync } from "node:fs";

export interface FileVersion {
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  /** 读取时剥过 BOM——write 补回依据 */
  readonly hadBom: boolean;
}

export class ObservedRegistry {
  private readonly bySession = new Map<string, Map<string, FileVersion>>();
  private readonly chains = new Map<string, Promise<void>>();

  /** 会话键：ctx.session ?? "_anon"（无 session 调用方共享匿名桶） */
  private bucket(session: string | undefined): Map<string, FileVersion> {
    const key = session ?? "_anon";
    const existing = this.bySession.get(key);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, FileVersion>();
    this.bySession.set(key, fresh);
    return fresh;
  }

  /** 元组拆出：read 的 stat 必须发生在 head peek 前（fail-closed），hadBom 要 peek 后才检测得出 */
  static tupleOf(path: string): Pick<FileVersion, "ino" | "size" | "mtimeNs"> {
    const st = statSync(path, { bigint: true }) as unknown as { ino: bigint; size: bigint; mtimeNs: bigint };
    return { ino: st.ino.toString(), size: st.size.toString(), mtimeNs: st.mtimeNs.toString() };
  }

  static versionOf(path: string, hadBom: boolean): FileVersion {
    return { ...ObservedRegistry.tupleOf(path), hadBom };
  }

  record(session: string | undefined, path: string, version: FileVersion): void {
    this.bucket(session).set(path, version);
  }

  lookup(session: string | undefined, path: string): FileVersion | undefined {
    return this.bucket(session).get(path);
  }

  /** 版本比对：三项任一不等 → 陈旧 */
  static stale(a: FileVersion, b: FileVersion): boolean {
    return a.ino !== b.ino || a.size !== b.size || a.mtimeNs !== b.mtimeNs;
  }

  /** 同绝对路径进程内互斥：check→temp→rename 临界区串行化 */
  async locked<T>(path: string, critical: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(path) ?? Promise.resolve();
    const run = previous.then(critical, critical);
    this.chains.set(
      path,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }
}
