export interface FileVersion {
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly hadBom: boolean;
}

export class ObservedRegistry {
  private readonly bySession = new Map<string, Map<string, FileVersion>>();
  private readonly chains = new Map<string, Promise<void>>();

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

  static stale(a: FileVersion, b: FileVersion): boolean {
    return a.ino !== b.ino || a.size !== b.size || a.mtimeNs !== b.mtimeNs;
  }

  evict(session: string | undefined): void {
    this.bySession.delete(session ?? "_anon");
  }

  async locked<T>(lockKey: string, critical: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(lockKey) ?? Promise.resolve();
    const run = previous.then(critical, critical);
    this.chains.set(
      lockKey,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }
}
