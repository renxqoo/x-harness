// 观察版本登记（docs/TOOLBOX.md §3 + docs/EXEC-ENV.md §3）：会话键控（跨会话不可借用观察）；
// 版本元组 {ino,size,mtimeNs} 由 ExecEnv 产出（read=openRead fd 版本，write=env.stat——
// temp+rename 换 inode 必须可比）；同路径进程内互斥（promise chain）。

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

  /** 会话终结逐出（sessionDisposed——delegation 子会话不累积） */
  evict(session: string | undefined): void {
    this.bySession.delete(session ?? "_anon");
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
